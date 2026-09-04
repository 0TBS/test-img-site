/* Image host speed test.
 *
 * Point it at any number of hosts — a Backblaze bucket, the same bucket behind a
 * Cloudflare img.<domain> record, an R2 bucket, GitHub Pages, the WordPress site
 * you are migrating away from — and it loads the same image from each of them,
 * one request at a time, timing every one with the browser's Resource Timing API.
 *
 * Two instruments share the same list of hosts:
 *
 *   The speed test  — many timed runs per host, median, and a significance test,
 *                     to answer "which of these is faster, and is that real?"
 *   The move check  — one careful request per host, compared byte for byte
 *                     against whichever host you mark as the original, to answer
 *                     "did the file actually arrive intact, and is it being
 *                     served properly?"
 *
 * No dependencies, no build step, no network calls beyond the images themselves.
 */
(function () {
  'use strict';

  // ── configuration ───────────────────────────────────────────────────

  var STORAGE_KEY = 'img-speed-test/v2';
  var LEGACY_KEY = 'img-speed-test/v1'; // read once, to carry over remembered URLs

  // GitHub's raw endpoint for this repo. Change the owner/repo/branch if you
  // fork it; the payload file name is appended to whatever base you set.
  var GITHUB_RAW = 'https://raw.githubusercontent.com/0tbs/test-img-site/main/assets/';

  // The bucket endpoint holding the same three sample files. Public, in the
  // us-east-005 region. This is the S3-style address rather than the native
  // /file/<bucket>/ one because B2 applies bucket CORS rules to the S3
  // endpoint, and without cross-origin permission this host could only be
  // measured by the cruder of the two methods below.
  var B2_DIRECT = 'https://brandingcentres-imgsite-test.s3.us-east-005.backblazeb2.com/speed-test/';

  // The same bucket reached through Cloudflare: a proxied CNAME, a transform
  // rule that prepends the bucket to the path, and a response-header rule.
  // No worker in the path. This is the arrangement worth copying.
  var B2_CLOUDFLARE = 'https://imgtest.crystic.ca/speed-test/';

  var DEFAULT_HOSTS = [
    {
      id: 'github',
      name: 'GitHub (raw)',
      blurb: 'raw.githubusercontent.com — reads the file straight out of the repository. Rate limited, and not meant to be a production asset host.',
      base: GITHUB_RAW,
      enabled: true
    },
    {
      id: 'b2direct',
      name: 'Backblaze B2 (direct)',
      blurb: 'The bucket endpoint with nothing in front of it: every request travels to the one region the bucket lives in. It sends no Timing-Allow-Origin, so it reports a total, and its phase breakdown and its protocol both read as not exposed.',
      base: B2_DIRECT,
      enabled: true
    },
    {
      id: 'backblaze',
      name: 'Backblaze B2 behind Cloudflare',
      blurb: 'The same bucket, same region, same files — reached through Cloudflare, which answers from an edge cache. A response-header rule adds the Timing-Allow-Origin that B2 cannot send itself, so this is the one host here that will show you where the time actually went, and over which protocol.',
      base: B2_CLOUDFLARE,
      enabled: true
    }
  ];

  // Starting points for a new card. Each one is an arrangement worth naming, so
  // that adding a host is a matter of picking the shape and pasting a hostname
  // rather than remembering what a bucket endpoint looks like.
  var PRESETS = [
    {
      id: 'cloudflare',
      name: 'Bucket behind Cloudflare',
      blurb: 'A bucket served through one of your own Cloudflare DNS records — the img.<domain> arrangement: a proxied CNAME, a URL-rewrite rule that prepends the bucket to the path, and a response-header rule adding both Access-Control-Allow-Origin and Timing-Allow-Origin.',
      placeholder: 'https://img.yourdomain.com/'
    },
    {
      id: 'b2',
      name: 'Backblaze B2 bucket (direct)',
      blurb: 'The bucket endpoint with nothing in front of it. Use the S3-style address — B2 applies bucket CORS rules to that one, and without a permitted cross-origin read this host can only be measured the crude way.',
      placeholder: 'https://<bucket>.s3.us-east-005.backblazeb2.com/'
    },
    {
      id: 'r2',
      name: 'Cloudflare R2 bucket',
      blurb: 'An R2 bucket on its own r2.dev address or on a custom domain of yours.',
      placeholder: 'https://<id>.r2.dev/'
    },
    {
      id: 'pages',
      name: 'GitHub Pages',
      blurb: 'A real static host with a CDN in front of it — the fair way to put GitHub in this comparison.',
      placeholder: 'https://you.github.io/repo/'
    },
    {
      id: 'wordpress',
      name: 'The old WordPress site',
      blurb: 'Where the images live today, before the move. Usually /wp-content/uploads/<year>/<month>/. Mark this one as the original and the move check compares everything else against it.',
      placeholder: 'https://oldsite.com/wp-content/uploads/'
    },
    {
      id: 'blank',
      name: 'Somewhere else',
      blurb: '',
      placeholder: 'https://…/'
    }
  ];

  var CUSTOM_PAYLOAD = '__custom__';

  var PAYLOADS = [
    { file: 'sample-small.jpg',  label: 'Sample — small, 900 × 900, about 50 KB',      hint: 'A thumbnail or an icon. At this size connection setup dominates and the file itself is almost free. Only exists on hosts carrying this repo’s sample files.' },
    { file: 'sample-medium.jpg', label: 'Sample — medium, 1800 × 1800, about 250 KB',  hint: 'A typical content image on a well-built page. The usual sweet spot for telling two hosts apart. Only exists on hosts carrying this repo’s sample files.' },
    { file: 'sample-large.jpg',  label: 'Sample — large, 3200 × 3200, about 1.2 MB',   hint: 'An unoptimised hero image. Throughput matters more than latency here, so the gap usually widens. Only exists on hosts carrying this repo’s sample files.' },
    { file: CUSTOM_PAYLOAD,      label: 'An image of your own',                        hint: 'The path to an image inside each bucket, appended to every base URL above. Leave it empty if every card already holds a whole image URL.' }
  ];

  var HOST_COLOURS = 8; // must match the --host-N custom properties in style.css
  var MAX_RECENT = 12;

  var TIMEOUT_MS = 20000;
  var FAILED_TIMEOUT_MS = 4000; // short leash once a host has already failed
  var GIVE_UP_AFTER = 2;        // consecutive failures before a host is dropped
  var GAP_MS = 120;             // breathing room so requests never overlap
  var ENTRY_GRACE_MS = 250;     // how long to wait for a resource timing entry
  var PROBE_ATTEMPTS = 3;       // a dropped probe must not demote the method
  var DECODE_TIMEOUT_MS = 8000; // long enough for a large image on a slow machine

  var MODES = [
    {
      id: 'warm',
      label: 'Repeat visitor — CDN edge warm',
      hint: 'Requests a stable URL and bypasses only the browser cache, so a CDN in front of a host answers from its edge. This is what most real visitors experience, and it is the mode that shows what a CDN is worth. Needs every host to allow cross-origin reads.'
    },
    {
      id: 'cold',
      label: 'First visitor — nothing cached anywhere',
      hint: 'Adds a unique token to every URL, so each request misses the browser cache and the CDN edge alike, and travels all the way to the origin. Measures the worst case each host can offer rather than the common one.'
    }
  ];

  // ── small helpers ───────────────────────────────────────────────────

  var $ = function (id) { return document.getElementById(id); };

  function el(tag, className, text) {
    var node = document.createElement(tag);
    if (className) node.className = className;
    if (text != null) node.textContent = text;
    return node;
  }

  function sleep(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms); });
  }

  function ms(value) {
    if (value == null || !isFinite(value)) return '—';
    if (value >= 1000) return (value / 1000).toFixed(2) + ' s';
    if (value >= 100) return Math.round(value) + ' ms';
    return value.toFixed(1) + ' ms';
  }

  function bytes(value) {
    if (!value) return '—';
    if (value >= 1048576) return (value / 1048576).toFixed(2) + ' MB';
    if (value >= 1024) return Math.round(value / 1024) + ' KB';
    return value + ' B';
  }

  function median(list) {
    if (!list.length) return null;
    var sorted = list.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function mean(list) {
    if (!list.length) return null;
    return list.reduce(function (a, b) { return a + b; }, 0) / list.length;
  }

  function stdev(list) {
    if (list.length < 2) return null;
    var m = mean(list);
    var variance = list.reduce(function (acc, v) { return acc + (v - m) * (v - m); }, 0) / (list.length - 1);
    return Math.sqrt(variance);
  }

  function shuffle(list) {
    for (var i = list.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var tmp = list[i]; list[i] = list[j]; list[j] = tmp;
    }
    return list;
  }

  function uid() {
    return 'h' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }

  function colourFor(index) {
    return 'var(--host-' + ((index % HOST_COLOURS) + 1) + ')';
  }

  // Is this base already a whole image URL rather than a directory to append to?
  // Decided on the last segment of the *path*, so a bare hostname full of dots
  // (img.example.com) is still a directory, and a trailing slash always is.
  function looksLikeFile(base) {
    var path;
    try {
      path = new URL(base).pathname;
    } catch (err) {
      // No scheme, so nothing has been parsed off the front. Everything before
      // the first slash is an authority, not a path — without this, a hostname
      // pasted out of a DNS dashboard (img.example.com) would look like a file
      // because of its dots, and every request would go to this page's origin.
      var raw = String(base).replace(/^\/\//, '');
      var slash = raw.indexOf('/');
      if (slash < 0) return false;
      path = raw.slice(slash).split(/[?#]/)[0];
    }
    var last = path.split('/').pop();
    return last.indexOf('.') > 0;
  }

  // A base plus the chosen image path. A base that is already a whole file URL
  // is used as it stands — which is how one card can point at the old site's
  // /wp-content/uploads/… path while another points at a bucket key.
  function resolveUrl(base, file) {
    var trimmed = String(base || '').trim();
    if (!trimmed) return '';
    if (looksLikeFile(trimmed)) return trimmed;
    if (!file) return '';
    // Append to the path, not to the end of the string. A base carrying a
    // query string or a fragment — a versioned or signed bucket prefix — would
    // otherwise fold the file name into the query and request the directory.
    var cut = trimmed.search(/[?#]/);
    var path = cut < 0 ? trimmed : trimmed.slice(0, cut);
    var suffix = cut < 0 ? '' : trimmed.slice(cut);
    return path.replace(/\/+$/, '') + '/' + String(file).replace(/^\/+/, '') + suffix;
  }

  function bust(url) {
    var token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    var hash = '';
    var hashAt = url.indexOf('#');
    if (hashAt >= 0) { hash = url.slice(hashAt); url = url.slice(0, hashAt); }
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'cb=' + token + hash;
  }

  function formatP(p) {
    if (p < 0.001) return '0.001 or less';
    return p.toFixed(p < 0.01 ? 4 : 3);
  }

  function hostLabel(url) {
    try { return new URL(url).host; } catch (err) { return url; }
  }

  function fileLabel(url) {
    try {
      var path = new URL(url).pathname;
      return path.split('/').filter(Boolean).pop() || path;
    } catch (err) { return url; }
  }

  function toHex(u8) {
    var out = '';
    for (var i = 0; i < u8.length; i++) out += (u8[i] < 16 ? '0' : '') + u8[i].toString(16);
    return out;
  }

  // A stand-in for SHA-256 where crypto.subtle is unavailable — notably on
  // file://, which is not a secure context. Weaker, and labelled as such; the
  // byte-for-byte comparison below never relies on it.
  function fnv1a(u8) {
    var hash = 0x811c9dc5;
    for (var i = 0; i < u8.length; i++) {
      hash ^= u8[i];
      hash = (hash + ((hash << 1) + (hash << 4) + (hash << 7) + (hash << 8) + (hash << 24))) >>> 0;
    }
    return ('00000000' + hash.toString(16)).slice(-8);
  }

  function digestOf(buffer) {
    var u8 = new Uint8Array(buffer);
    if (window.crypto && crypto.subtle && crypto.subtle.digest) {
      try {
        return crypto.subtle.digest('SHA-256', buffer).then(function (hash) {
          return { algo: 'SHA-256', hex: toHex(new Uint8Array(hash)) };
        }, function () {
          return { algo: 'FNV-1a', hex: fnv1a(u8) };
        });
      } catch (err) { /* fall through to the cheap one */ }
    }
    return Promise.resolve({ algo: 'FNV-1a', hex: fnv1a(u8) });
  }

  function sameBytes(a, b) {
    if (!a || !b) return null;
    if (a.byteLength !== b.byteLength) return false;
    var x = new Uint8Array(a), y = new Uint8Array(b);
    for (var i = 0; i < x.length; i++) if (x[i] !== y[i]) return false;
    return true;
  }

  // ── state ───────────────────────────────────────────────────────────

  function freshHosts() {
    return DEFAULT_HOSTS.map(function (h) { return Object.assign({}, h, { label: '' }); });
  }

  var state = {
    hosts: freshHosts(),
    payload: PAYLOADS[1].file,
    customPath: '',
    runs: 8,
    warmup: true,
    mode: 'warm',
    referenceId: DEFAULT_HOSTS[0].id,
    recentBases: [],
    recentPaths: []
  };

  function defaultBaseFor(id) {
    var host = DEFAULT_HOSTS.filter(function (h) { return h.id === id; })[0];
    return host ? host.base : '';
  }

  function isShipped(host) {
    return DEFAULT_HOSTS.some(function (h) { return h.id === host.id; });
  }

  // What to call a host in the tables and the verdict. A name you typed wins; a
  // shipped card still sitting on its shipped URL keeps its shipped name; and
  // anything else is named after the hostname it points at, which is always
  // truthful and never goes stale.
  function displayName(host) {
    var typed = String(host.label || '').trim();
    if (typed) return typed;
    if (isShipped(host) && host.base === defaultBaseFor(host.id)) return host.name;
    var base = String(host.base || '').trim();
    if (base) return hostLabel(base);
    return host.name || 'Unnamed host';
  }

  function remember(list, value) {
    var trimmed = String(value || '').trim();
    if (!trimmed) return list;
    var next = list.filter(function (item) { return item !== trimmed; });
    next.unshift(trimmed);
    return next.slice(0, MAX_RECENT);
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        // defaultBase records what the page shipped at the time this was
        // written. If a later version ships a different URL, that new default
        // wins on the next visit — otherwise a remembered blank would shadow
        // it forever and the host would silently never run.
        hosts: state.hosts.map(function (h) {
          return {
            id: h.id,
            name: h.name,
            blurb: h.blurb,
            placeholder: h.placeholder,
            label: h.label,
            base: h.base,
            enabled: h.enabled,
            defaultBase: defaultBaseFor(h.id)
          };
        }),
        payload: state.payload,
        customPath: state.customPath,
        runs: state.runs,
        warmup: state.warmup,
        mode: state.mode,
        referenceId: state.referenceId,
        recentBases: state.recentBases,
        recentPaths: state.recentPaths
      }));
    } catch (err) { /* private browsing, blocked storage — not worth reporting */ }
  }

  // The saved list is authoritative about which cards exist and in what order —
  // otherwise a card the visitor deleted would reappear on the next visit,
  // because the shipped three are always there to be merged back in.
  function hostFromEntry(entry) {
    if (!entry || typeof entry !== 'object' || typeof entry.id !== 'string') return null;

    var shipped = DEFAULT_HOSTS.filter(function (h) { return h.id === entry.id; })[0];
    if (shipped) {
      var host = Object.assign({}, shipped, { label: '' });
      // A base remembered against a *different* shipped default was chosen by
      // an older version of this page. The new default wins, or a remembered
      // blank would shadow it forever and the host would silently never run.
      if (entry.defaultBase === defaultBaseFor(entry.id) && typeof entry.base === 'string') {
        host.base = entry.base;
      }
      if (typeof entry.enabled === 'boolean') host.enabled = entry.enabled;
      if (typeof entry.label === 'string') host.label = entry.label;
      return host;
    }

    // A card the visitor added themselves. Rebuilt whole, since nothing about
    // it came from this build in the first place.
    if (typeof entry.base !== 'string') return null;
    return {
      id: entry.id,
      name: typeof entry.name === 'string' ? entry.name : 'Host',
      blurb: typeof entry.blurb === 'string' ? entry.blurb : '',
      placeholder: typeof entry.placeholder === 'string' ? entry.placeholder : '',
      label: typeof entry.label === 'string' ? entry.label : '',
      base: entry.base,
      enabled: entry.enabled !== false
    };
  }

  function readSaved(key) {
    var raw;
    try { raw = localStorage.getItem(key); } catch (err) { return null; }
    if (!raw) return null;
    try {
      var parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch (err) { return null; }
  }

  function restore() {
    // v1 knew only the three shipped hosts, so its entries all match by id and
    // the loop below carries the visitor's URLs across without special cases.
    var saved = readSaved(STORAGE_KEY) || readSaved(LEGACY_KEY);
    if (!saved) return;

    if (Array.isArray(saved.hosts)) {
      var rebuilt = saved.hosts.map(hostFromEntry).filter(Boolean);
      // An empty list is honoured when it was saved empty — the visitor removed
      // every card, and the picker below is still there to add one. A list that
      // failed to parse is not: the shipped set beats a blank page.
      if (rebuilt.length || !saved.hosts.length) state.hosts = rebuilt;
    }
    if (PAYLOADS.some(function (p) { return p.file === saved.payload; })) state.payload = saved.payload;
    if (typeof saved.customPath === 'string') state.customPath = saved.customPath;
    if (saved.runs >= 1 && saved.runs <= 40) state.runs = Math.round(saved.runs);
    if (typeof saved.warmup === 'boolean') state.warmup = saved.warmup;
    if (MODES.some(function (m) { return m.id === saved.mode; })) state.mode = saved.mode;
    if (typeof saved.referenceId === 'string') state.referenceId = saved.referenceId;
    if (Array.isArray(saved.recentBases)) {
      state.recentBases = saved.recentBases.filter(function (v) { return typeof v === 'string'; }).slice(0, MAX_RECENT);
    }
    if (Array.isArray(saved.recentPaths)) {
      state.recentPaths = saved.recentPaths.filter(function (v) { return typeof v === 'string'; }).slice(0, MAX_RECENT);
    }
  }

  // ── the image being tested ──────────────────────────────────────────

  function payloadFile() {
    if (state.payload !== CUSTOM_PAYLOAD) return state.payload;
    return String(state.customPath || '').trim().replace(/^\/+/, '');
  }

  function payloadDescription() {
    var file = payloadFile();
    if (file) return file;
    return 'whatever each card points at';
  }

  function urlForHost(host) {
    return resolveUrl(host.base, payloadFile());
  }

  function activeHosts() {
    return state.hosts.filter(function (h) { return h.enabled && urlForHost(h); });
  }

  // The host every other host is compared against in the move check. An
  // explicit choice if it is still enabled and resolvable, otherwise the first
  // host that is — so removing or unticking the original never leaves the check
  // with nothing to compare to.
  function referenceHost(list) {
    var chosen = list.filter(function (h) { return h.id === state.referenceId; })[0];
    return chosen || list[0] || null;
  }

  function rememberCurrent() {
    activeHosts().forEach(function (host) {
      state.recentBases = remember(state.recentBases, host.base);
    });
    if (state.payload === CUSTOM_PAYLOAD) {
      state.recentPaths = remember(state.recentPaths, payloadFile());
    }
    save();
    renderDatalists();
  }

  // ── measurement ─────────────────────────────────────────────────────

  // Resource timing entries arrive asynchronously. Polling for them after a
  // setTimeout races the browser: sometimes the entry has landed, sometimes it
  // has not and the run silently falls back to a wall-clock reading instead.
  // Mixing two measurement sources across runs of the same host is exactly the
  // kind of quiet inconsistency this test cannot afford, so entries are taken
  // from an observer and claimed in order.
  var pendingEntries = {};
  var entryWaiters = {};
  var observer = null;

  function startObserver() {
    if (typeof PerformanceObserver !== 'function') return false;
    pendingEntries = {};
    entryWaiters = {};
    if (observer) observer.disconnect();
    observer = new PerformanceObserver(function (list) {
      list.getEntries().forEach(function (entry) {
        if (entry.entryType !== 'resource') return;
        var waiting = entryWaiters[entry.name];
        if (waiting && waiting.length) { waiting.shift()(entry); return; }
        (pendingEntries[entry.name] = pendingEntries[entry.name] || []).push(entry);
      });
    });
    // buffered:false — only entries created from here on, so nothing the page
    // loaded earlier can be mistaken for a measurement.
    observer.observe({ type: 'resource', buffered: false });
    return true;
  }

  function stopObserver() {
    if (observer) { observer.disconnect(); observer = null; }
  }

  // Requests are strictly sequential, so the next entry under a given name is
  // always this request's.
  function awaitEntry(url, graceMs) {
    return new Promise(function (resolve) {
      var queued = pendingEntries[url];
      if (queued && queued.length) return resolve(queued.shift());

      var settled = false;
      var waiters = entryWaiters[url] = entryWaiters[url] || [];
      var claim = function (entry) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(entry);
      };
      waiters.push(claim);

      var timer = setTimeout(function () {
        if (settled) return;
        settled = true;
        var i = waiters.indexOf(claim);
        if (i >= 0) waiters.splice(i, 1);
        resolve(null);
      }, graceMs);
    });
  }

  // Can this host be read cross-origin? Only then can a request be timed with
  // fetch, which is what makes warm-cache mode and exact byte counts possible.
  function probeCors(url, attempt) {
    return fetch(bust(url), { mode: 'cors', cache: 'no-store' })
      // Any response at all means the cross-origin read was permitted. The
      // status is irrelevant here: a 503 still proves the browser was allowed
      // to see the response, and treating it as a refusal would demote every
      // host to the cruder method over one transient blip.
      .then(function () { return true; })
      .catch(function () {
        // A rejection is either a genuine CORS refusal or a dropped request,
        // and they are indistinguishable from here. Retry before concluding.
        if ((attempt || 0) >= PROBE_ATTEMPTS - 1) return false;
        return sleep(GAP_MS).then(function () { return probeCors(url, (attempt || 0) + 1); });
      });
  }

  // Time one request. Two methods, and every host in a run uses the same one:
  //
  //   fetch  — reads the body to completion, so the clock covers the whole
  //            transfer and the exact byte count is known for every host.
  //            cache: 'no-store' bypasses the browser cache without changing
  //            the URL, which is what leaves a CDN edge cache warm.
  //   image  — the fallback where a host forbids cross-origin reads. An <img>
  //            can load anything, but the bytes are only visible when the host
  //            sends Timing-Allow-Origin, and the URL must be cache-busted.
  function measure(url, method, timeoutMs) {
    return method === 'fetch' ? measureFetch(url, timeoutMs) : measureImage(url, timeoutMs);
  }

  function measureFetch(url, timeoutMs) {
    // Warm mode requests the same URL every run, so entries pile up under one
    // name. Remember the count now and read only past it, or a run whose entry
    // has not landed yet would silently report the previous run's timing.
    var seen = performance.getEntriesByName(url).length;
    var started = performance.now();
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () { if (controller) controller.abort(); }, timeoutMs);

    var options = { mode: 'cors', cache: 'no-store' };
    if (controller) options.signal = controller.signal;

    return fetch(url, options)
      .then(function (response) {
        if (!response.ok) throw new Error('HTTP ' + response.status);
        // Draining the body is the point: the request is not finished until
        // the last byte has arrived.
        return response.arrayBuffer();
      })
      .then(function (buffer) {
        clearTimeout(timer);
        var wall = performance.now() - started;
        return settle(url, true, wall, buffer.byteLength, seen);
      })
      .catch(function () {
        clearTimeout(timer);
        return settle(url, false, performance.now() - started, null, seen);
      });
  }

  function measureImage(url, timeoutMs) {
    return new Promise(function (resolve) {
      var img = new Image();
      var seen = performance.getEntriesByName(url).length;
      var started = performance.now();
      var settled = false;

      function finish(ok) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(settle(url, ok, performance.now() - started, null, seen));
      }

      var timer = setTimeout(function () { img.src = ''; finish(false); }, timeoutMs);
      img.onload = function () { finish(true); };
      img.onerror = function () { finish(false); };
      img.src = url;
    });
  }

  // The resource timing entry lands a beat after the transfer completes. Wait
  // for the observer to hand it over rather than guessing when it is ready.
  function settle(url, ok, wall, measuredBytes, seen) {
    if (observer) {
      return awaitEntry(url, ENTRY_GRACE_MS).then(function (entry) {
        return describe(url, ok, wall, measuredBytes, seen, entry);
      });
    }
    return new Promise(function (resolve) {
      setTimeout(function () { resolve(describe(url, ok, wall, measuredBytes, seen, null)); }, 0);
    });
  }

  function describe(url, ok, wall, measuredBytes, seen, observed) {
    var result = {
      ok: ok,
      total: wall,
      detailed: false,
      dns: null, connect: null, tls: null, wait: null, download: null,
      bytes: measuredBytes,
      measuredBytes: measuredBytes,
      protocol: null,
      source: 'wallclock'
    };
    if (!ok) { result.total = null; return result; }

    // Only an entry recorded after this request started describes this
    // request. If none arrived, keep the wall-clock reading rather than
    // attributing an older entry to this run.
    var entry = observed;
    if (!entry) {
      var entries = performance.getEntriesByName(url);
      entry = entries.length > seen ? entries[entries.length - 1] : null;
    }
    if (!entry) return result;

    result.source = 'timing';
    result.total = entry.duration || wall;

    // Everything below responseEnd is zeroed for cross-origin responses that do
    // not send Timing-Allow-Origin. responseStart is the reliable tell.
    if (entry.responseStart > 0) {
      result.detailed = true;
      result.dns = entry.domainLookupEnd - entry.domainLookupStart;
      result.connect = entry.connectEnd - entry.connectStart;
      result.tls = entry.secureConnectionStart > 0 ? entry.connectEnd - entry.secureConnectionStart : 0;
      result.wait = entry.responseStart - entry.requestStart;
      result.download = entry.responseEnd - entry.responseStart;
    }
    // Also gated behind Timing-Allow-Origin, so it is empty for exactly the
    // hosts whose phase breakdown is missing.
    if (entry.nextHopProtocol) result.protocol = entry.nextHopProtocol;
    // A byte count read from the body itself is authoritative; the timing
    // entry's figures are only exposed to same-origin or Timing-Allow-Origin
    // hosts, so they are the fallback, not the source of truth.
    if (result.bytes == null) {
      if (entry.encodedBodySize > 0) result.bytes = entry.encodedBodySize;
      else if (entry.transferSize > 0) result.bytes = entry.transferSize;
    }

    return result;
  }

  // Mann-Whitney U, two-sided, with the normal approximation and a continuity
  // correction. Latency samples are skewed and small, so a rank test is the
  // honest way to ask whether two hosts really differ or the gap is noise.
  function differenceIsReal(a, b) {
    if (a.length < 4 || b.length < 4) return null;

    var pooled = a.map(function (v) { return { v: v, group: 0 }; })
      .concat(b.map(function (v) { return { v: v, group: 1 }; }))
      .sort(function (x, y) { return x.v - y.v; });

    // Average ranks over ties, or equal timings would bias the result.
    var ranks = new Array(pooled.length);
    for (var i = 0; i < pooled.length;) {
      var j = i;
      while (j + 1 < pooled.length && pooled[j + 1].v === pooled[i].v) j++;
      var shared = (i + j) / 2 + 1;
      for (var k = i; k <= j; k++) ranks[k] = shared;
      i = j + 1;
    }

    var rankSumA = 0;
    for (var m = 0; m < pooled.length; m++) if (pooled[m].group === 0) rankSumA += ranks[m];

    var na = a.length, nb = b.length;
    var uA = rankSumA - na * (na + 1) / 2;
    var u = Math.min(uA, na * nb - uA);

    var meanU = na * nb / 2;
    var sdU = Math.sqrt(na * nb * (na + nb + 1) / 12);
    if (!sdU) return null;

    var z = (Math.abs(u - meanU) - 0.5) / sdU;
    return { p: 2 * (1 - normalCdf(z)), z: z };
  }

  // Abramowitz & Stegun 26.2.17 — plenty of precision for a p-value we only
  // ever report to one significant figure.
  function normalCdf(z) {
    var t = 1 / (1 + 0.2316419 * Math.abs(z));
    var d = 0.3989422804014327 * Math.exp(-z * z / 2);
    var p = d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 +
            t * (-1.821255978 + t * 1.330274429))));
    return z > 0 ? 1 - p : p;
  }

  // ── the speed test ──────────────────────────────────────────────────

  var running = false;
  var lastResults = null;

  function busy(isBusy) {
    running = isBusy;
    ['run', 'move', 'race'].forEach(function (id) { $(id).disabled = isBusy; });
  }

  function noTargets(verb) {
    var enabled = state.hosts.filter(function (h) { return h.enabled; });
    if (!enabled.length) {
      setStatus('Tick at least one host to ' + verb + '.', true);
    } else if (state.payload === CUSTOM_PAYLOAD && !payloadFile()) {
      setStatus('Type the path of an image to ' + verb + ' — or paste a whole image URL into a host card.', true);
    } else {
      setStatus('No host resolves to an image URL yet. Give one a base URL, or paste a whole image URL into it.', true);
    }
  }

  async function runTest() {
    if (running) return;

    var hosts = activeHosts();
    if (!hosts.length) { noTargets('test'); return; }

    busy(true);
    $('progress').hidden = false;
    rememberCurrent();

    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(1000);
    if (performance.clearResourceTimings) performance.clearResourceTimings();
    startObserver();

    var results = hosts.map(function (host, index) {
      return {
        host: host,
        name: displayName(host),
        colour: colourFor(index),
        url: urlForHost(host),
        samples: [],
        failures: 0,
        abandoned: false
      };
    });

    // Every host must be measured the same way or the comparison is worthless,
    // so one host refusing cross-origin reads drops all of them to <img>.
    setStatus('Checking what each host allows…');
    var corsResults = await Promise.all(results.map(function (r) { return probeCors(r.url); }));
    var method = corsResults.every(Boolean) ? 'fetch' : 'image';
    var blockedBy = results.filter(function (r, i) { return !corsResults[i]; })
      .map(function (r) { return hostLabel(r.url); });

    // Warm mode needs a stable URL, which only fetch can request without the
    // browser answering it out of its own cache.
    var mode = state.mode === 'warm' && method === 'fetch' ? 'warm' : 'cold';
    var urlFor = function (base) { return mode === 'warm' ? base : bust(base); };

    var run_meta = {
      method: method,
      mode: mode,
      requestedMode: state.mode,
      blockedBy: blockedBy,
      payload: payloadDescription(),
      runs: state.runs,
      warmup: state.warmup
    };

    var total = state.runs * results.length + (state.warmup ? results.length : 0);
    var done = 0;
    function tick() {
      done += 1;
      $('progress-bar').style.width = (done / total * 100) + '%';
    }

    if (state.warmup) {
      for (var w = 0; w < results.length; w++) {
        setStatus('Warming ' + hostLabel(results[w].url) + '…');
        // In warm mode this also primes the CDN edge, which is the whole point:
        // it is what a visitor arriving after somebody else in their city sees.
        await measure(urlFor(results[w].url), method, TIMEOUT_MS);
        tick();
        await sleep(GAP_MS);
      }
    }

    for (var run = 0; run < state.runs; run++) {
      // Shuffle rather than alternate. Strict ABAB ordering can line up with a
      // periodic disturbance — a background sync, a wifi beacon — and hand the
      // same host the bad slot every time. A fresh order each run cannot.
      var order = shuffle(results.slice());

      for (var i = 0; i < order.length; i++) {
        var target = order[i];
        if (target.abandoned) { tick(); continue; }

        setStatus('Run ' + (run + 1) + ' of ' + state.runs + ' — ' + hostLabel(target.url) + '…');
        // A host that has already failed gets a short leash. Waiting the full
        // timeout on every remaining run turns one dead host into minutes of
        // staring at a progress bar.
        var budget = target.failures ? FAILED_TIMEOUT_MS : TIMEOUT_MS;
        var measurement = await measure(urlFor(target.url), method, budget);

        if (measurement.ok) {
          target.samples.push(measurement);
        } else {
          target.failures += 1;
          if (target.failures >= GIVE_UP_AFTER && !target.samples.length) target.abandoned = true;
        }
        tick();
        await sleep(GAP_MS);
      }
    }

    results.forEach(function (r) {
      var times = r.samples.map(function (s) { return s.total; });
      r.stats = {
        n: times.length,
        median: median(times),
        mean: mean(times),
        min: times.length ? Math.min.apply(null, times) : null,
        max: times.length ? Math.max.apply(null, times) : null,
        stdev: stdev(times)
      };
      r.detailed = r.samples.some(function (s) { return s.detailed; });
      r.protocol = (r.samples.filter(function (s) { return s.protocol; })[0] || {}).protocol || null;
      r.phases = {
        dns: median(r.samples.filter(function (s) { return s.detailed; }).map(function (s) { return s.dns; })),
        connect: median(r.samples.filter(function (s) { return s.detailed; }).map(function (s) { return s.connect; })),
        wait: median(r.samples.filter(function (s) { return s.detailed; }).map(function (s) { return s.wait; })),
        download: median(r.samples.filter(function (s) { return s.detailed; }).map(function (s) { return s.download; }))
      };
      var sizes = r.samples.map(function (s) { return s.bytes; }).filter(Boolean);
      r.bytes = sizes.length ? median(sizes) : null;
      // Bytes read off the body are proof; bytes inferred from a timing entry
      // are only available to hosts that opt in. The distinction decides
      // whether the fairness check below can be trusted.
      r.bytesMeasured = r.samples.some(function (s) { return s.measuredBytes != null; });
      // If some runs were timed from a resource entry and others from the wall
      // clock, the numbers are not strictly comparable within the host.
      r.wallclockRuns = r.samples.filter(function (s) { return s.source === 'wallclock'; }).length;
    });

    stopObserver();

    lastResults = results;
    busy(false);
    $('progress').hidden = true;
    $('progress-bar').style.width = '0';
    setStatus('Done — ' + state.runs + ' runs per host on ' + run_meta.payload
      + ' (' + (run_meta.mode === 'warm' ? 'repeat visitor' : 'first visitor') + ').');
    renderResults(results, run_meta);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── the move check ──────────────────────────────────────────────────
  //
  // One request per host, read carefully rather than quickly. The question is
  // not "how fast" but "is this the same file, and is it being served the way
  // an image should be" — which is what actually goes wrong when images are
  // copied from one host to another.

  function decodeFromBlob(buffer, type) {
    return new Promise(function (resolve) {
      if (typeof URL === 'undefined' || !URL.createObjectURL) return resolve(null);
      // Deliberately drop a non-image content type rather than passing it on:
      // a JPEG mislabelled as application/octet-stream is one of the things
      // this check exists to catch, and it must still be decodable here so the
      // report can say "it is a real image, served under the wrong type".
      var blob = new Blob([buffer], /^image\//i.test(type || '') ? { type: type } : undefined);
      var objectUrl = URL.createObjectURL(blob);
      var img = new Image();
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        URL.revokeObjectURL(objectUrl);
        resolve(value);
      }
      var timer = setTimeout(function () { finish(null); }, DECODE_TIMEOUT_MS);
      img.onload = function () { finish({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = function () { finish(null); };
      img.src = objectUrl;
    });
  }

  // The fallback for a host that refuses a cross-origin read: an <img> can
  // still load it, which proves the URL resolves and reveals the pixel
  // dimensions, even though the bytes stay invisible to the page.
  function decodeFromUrl(url) {
    return new Promise(function (resolve) {
      var img = new Image();
      var settled = false;
      function finish(value) {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      }
      var timer = setTimeout(function () { img.src = ''; finish(null); }, DECODE_TIMEOUT_MS);
      img.onload = function () { finish({ width: img.naturalWidth, height: img.naturalHeight }); };
      img.onerror = function () { finish(null); };
      img.src = url;
    });
  }

  function inspectHost(record) {
    // Cache-busted deliberately: a move check asks what the host is holding
    // now, not what an edge cached before the file was replaced.
    var url = bust(record.url);
    var info = {
      url: record.url,
      requested: url,
      ok: false,
      status: null,
      error: null,
      corsBlocked: false,
      decodeFailed: false,
      type: null,
      cacheControl: null,
      edge: null,
      bytes: null,
      buffer: null,
      digest: null,
      width: null,
      height: null,
      protocol: null,
      tao: false,
      total: null
    };

    var started = performance.now();

    return fetch(url, { mode: 'cors', cache: 'no-store' })
      .then(function (response) {
        info.status = response.status;
        info.ok = response.ok;
        // Content-Type, Content-Length, Cache-Control, Expires and
        // Last-Modified are CORS-safelisted, so they read cross-origin without
        // the host doing anything. Anything else — cf-cache-status among them —
        // needs Access-Control-Expose-Headers, and reads as null without it.
        // Which is why a missing one is never reported as absent.
        info.type = response.headers.get('content-type');
        info.cacheControl = response.headers.get('cache-control');
        info.edge = response.headers.get('cf-cache-status');
        if (!response.ok) {
          info.error = 'HTTP ' + response.status;
          return null;
        }
        return response.arrayBuffer();
      })
      .catch(function () {
        info.corsBlocked = true;
        return null;
      })
      .then(function (buffer) {
        info.total = performance.now() - started;
        if (buffer) {
          info.buffer = buffer;
          info.bytes = buffer.byteLength;
          return decodeFromBlob(buffer, info.type).then(function (size) {
            if (size) { info.width = size.width; info.height = size.height; }
            return digestOf(buffer).then(function (digest) { info.digest = digest; });
          });
        }
        // The host answered with an error status. There is nothing an <img>
        // would add: it would fail the same way, more slowly.
        if (!info.corsBlocked) return null;
        // A refused cross-origin read and a dead host look identical to fetch.
        // An <img> tells them apart: if it loads, the host is up and simply
        // will not be read by script — and its dimensions are visible anyway.
        return decodeFromUrl(url).then(function (size) {
          if (size) {
            info.width = size.width;
            info.height = size.height;
            info.ok = true;
            info.error = null;
          } else if (!info.error) {
            // The <img> failing is not proof the file is missing: the browser
            // may simply have no decoder for the format, or the decode may have
            // run out of time. That distinction is carried into the report.
            info.decodeFailed = true;
            info.error = 'not readable';
          }
        });
      })
      .then(function () {
        return awaitEntry(url, ENTRY_GRACE_MS);
      })
      .then(function (entry) {
        if (entry) {
          if (entry.duration) info.total = entry.duration;
          if (entry.responseStart > 0) info.tao = true;
          if (entry.nextHopProtocol) info.protocol = entry.nextHopProtocol;
          if (info.bytes == null && entry.encodedBodySize > 0) info.bytes = entry.encodedBodySize;
        }
        return info;
      });
  }

  // A status code is not a diagnosis. 404 means the path is wrong; 403 usually
  // means the object is there and the bucket is not public, which is the single
  // most common thing to get wrong at this step and the one a blanket "the file
  // is not there" would send somebody hunting for the wrong mistake.
  function failureText(info) {
    if (info.corsBlocked) {
      return info.decodeFailed
        ? 'The cross-origin read was refused and the browser could not decode it as an image either, so this cannot tell a missing file from a format it has no decoder for.'
        : 'Nothing loaded from this URL at all — wrong path, wrong bucket, or the host is down.';
    }
    var status = info.status;
    if (status === 404 || status === 410) return 'The host answered ' + status + '. Nothing is at that path.';
    if (status === 401 || status === 403) return 'The host answered ' + status + '. The object may well be there — this is what a bucket that has not been made public says, and what a URL that needs signing says.';
    if (status === 429) return 'The host answered 429: rate limited. Nothing is wrong with the file; there were too many requests.';
    if (status >= 500) return 'The host answered ' + status + '. The host failed, which says nothing about whether the file is there.';
    return 'The host answered ' + (info.error || 'with an error') + '.';
  }

  // Cache-Control is a list of directives, and reading it with one regex gets
  // the common CDN arrangements wrong: no-cache means revalidate, not "do not
  // store", and s-maxage is the one that governs the edge.
  function readCache(value) {
    var directives = String(value || '').toLowerCase().split(',').map(function (d) { return d.trim(); });
    var seconds = function (name) {
      var hit = directives.filter(function (d) { return d.indexOf(name + '=') === 0; })[0];
      if (!hit) return null;
      var n = Number(hit.slice(name.length + 1).replace(/"/g, ''));
      return isFinite(n) ? n : null;
    };
    return {
      present: !!String(value || '').trim(),
      noStore: directives.indexOf('no-store') >= 0,
      noCache: directives.indexOf('no-cache') >= 0,
      immutable: directives.indexOf('immutable') >= 0,
      maxAge: seconds('max-age'),
      sMaxAge: seconds('s-maxage')
    };
  }

  // What is wrong with this copy, in the order a person would want to hear it.
  function auditCopy(info, reference) {
    var flags = [];
    var isReference = info === reference;

    if (!info.ok) {
      flags.push({ level: 'bad', text: failureText(info) });
      return flags;
    }

    if (info.type && !/^image\//i.test(info.type)) {
      flags.push({ level: 'bad', text: 'Served as ' + info.type + ', not an image type. Browsers may download it instead of displaying it, and some CDNs will not optimise it. This is what an upload that did not set a content type looks like — the usual souvenir of an rclone or S3 copy.' });
    }

    // Deliberately no Content-Length-against-body check: on a compressed
    // response the header is the compressed size and the body is not, so it
    // would report a phantom truncation — and a genuinely short body fails the
    // fetch outright rather than arriving here.
    if (info.buffer && info.bytes === 0) {
      flags.push({ level: 'bad', text: 'The file is empty — nought bytes. The upload created the object but never wrote to it.' });
    }

    if (info.duplicateOf) {
      flags.push({ level: 'warn', text: 'This card resolves to the same URL as ' + info.duplicateOf
        + ', so it is the same object asked twice, not a copy to compare. Anything below about identity is trivially true.' });
    }

    if (!isReference && (!reference || !reference.ok)) {
      // Nothing was compared. Saying so is the difference between a check that
      // did not run and a copy that passed one.
      flags.push({ level: 'warn', text: 'The original could not be read, so this copy was not compared against anything. Only how it is served was checked.' });
    }

    if (!isReference && reference && reference.ok && !info.duplicateOf) {
      if (info.buffer && reference.buffer) {
        if (info.bytes === 0 && reference.bytes === 0) {
          flags.push({ level: 'bad', text: 'Both this copy and the original are empty. Two files of nothing are not a verified move.' });
        } else if (sameBytes(info.buffer, reference.buffer)) {
          flags.push({ level: 'good', text: 'Byte-for-byte identical to the original.' });
        } else if (info.bytes != null && reference.bytes != null && info.bytes !== reference.bytes) {
          var delta = info.bytes - reference.bytes;
          flags.push({ level: 'bad', text: 'Different file: ' + bytes(Math.abs(delta)) + (delta < 0 ? ' smaller' : ' larger')
            + ' than the original (' + bytes(info.bytes) + ' against ' + bytes(reference.bytes) + '). Something re-encoded or resized it on the way.' });
        } else {
          flags.push({ level: 'bad', text: 'The same number of bytes as the original, but not the same bytes. The file has been altered.' });
        }
      } else {
        flags.push({ level: 'warn', text: 'The bytes could not be read on both sides, so identity is unproven. Dimensions and size are all this check can offer here.' });
      }

      if (info.width && reference.width && (info.width !== reference.width || info.height !== reference.height)) {
        flags.push({ level: 'bad', text: 'Different pixel dimensions: ' + info.width + ' × ' + info.height
          + ' against the original’s ' + reference.width + ' × ' + reference.height + '.' });
      }

      if (info.type && reference.type && info.type.split(';')[0] !== reference.type.split(';')[0]) {
        flags.push({ level: 'warn', text: 'Content type differs from the original: ' + info.type + ' against ' + reference.type + '.' });
      }
    }

    if (info.corsBlocked) {
      // Everything below this line is read from response headers, and a refused
      // cross-origin read means there were none to read. Reporting them as
      // absent would be inventing a finding out of our own blindness.
      flags.push({ level: 'warn', text: 'Refuses cross-origin reads, so scripts on your site cannot fetch it, this page cannot verify its bytes, and none of its headers can be inspected. On a Cloudflare-fronted bucket that means the Access-Control-Allow-Origin response-header rule is missing or scoped to a different hostname.' });
      return flags;
    }

    if (!info.tao) {
      flags.push({ level: 'warn', text: 'No Timing-Allow-Origin header, so neither this page nor your own monitoring can see where the time goes on this host — only the total.' });
    }

    // Only readable where the host names it in Access-Control-Expose-Headers,
    // so it is reported when present and never inferred from its absence. MISS
    // is expected here and says nothing: this request carried a cache-buster.
    if (/^(DYNAMIC|BYPASS)$/i.test(String(info.edge || ''))) {
      flags.push({ level: 'warn', text: 'Cloudflare reports cf-cache-status: ' + info.edge
        + ', so it is not caching this at the edge at all — every request travels to the bucket. That is the CDN in front of it doing nothing.' });
    }

    var cache = readCache(info.cacheControl);
    var shared = cache.sMaxAge != null ? cache.sMaxAge : cache.maxAge;
    if (!cache.present) {
      flags.push({ level: 'warn', text: 'No Cache-Control header. Every visitor, and every CDN edge, has to guess how long to keep it — usually meaning they re-fetch it far too often.' });
    } else if (cache.noStore) {
      flags.push({ level: 'warn', text: 'Cache-Control says no-store, so nothing may keep a copy of it at all. For an image that never changes, that is throwing the CDN away.' });
    } else if (cache.noCache && cache.sMaxAge == null) {
      flags.push({ level: 'warn', text: 'Cache-Control says no-cache, so every use has to be revalidated with the origin before the cached copy may be shown. For an image that never changes that is a round trip per visitor, per image.' });
    } else if (shared != null && shared < 86400 && !cache.immutable) {
      flags.push({ level: 'warn', text: 'Cache-Control keeps it for only ' + shared + ' second' + (shared === 1 ? '' : 's')
        + '. Images that never change are normally set to a year and marked immutable.' });
    }

    if (!flags.length) flags.push({ level: 'good', text: 'Nothing to report.' });
    return flags;
  }

  async function runMoveCheck() {
    if (running) return;

    var hosts = activeHosts();
    if (!hosts.length) { noTargets('check'); return; }

    busy(true);
    $('progress').hidden = false;
    rememberCurrent();

    if (performance.clearResourceTimings) performance.clearResourceTimings();
    startObserver();

    var records = hosts.map(function (host, index) {
      return { host: host, name: displayName(host), colour: colourFor(index), url: urlForHost(host) };
    });

    var reference = referenceHost(hosts);
    // The card marked as the original may have been unticked, emptied or
    // removed since. Something still has to be the reference, but the report
    // has to say that it was not the one chosen.
    var markedMissing = !hosts.some(function (h) { return h.id === state.referenceId; });
    var checked = [];
    for (var i = 0; i < records.length; i++) {
      setStatus('Checking ' + records[i].name + '…');
      var info = await inspectHost(records[i]);
      info.record = records[i];
      info.isReference = records[i].host === reference;
      checked.push(info);
      $('progress-bar').style.width = ((i + 1) / records.length * 100) + '%';
      await sleep(GAP_MS);
    }

    stopObserver();

    var referenceInfo = checked.filter(function (info) { return info.isReference; })[0] || checked[0];
    // A card pointing at the same URL as another is one object asked twice.
    // Comparing it against itself would produce the strongest claim this tool
    // can make about a move that never happened.
    checked.forEach(function (info) {
      if (info === referenceInfo) return;
      var twin = checked.filter(function (other) { return other !== info && other.url === info.url; })[0];
      if (twin) info.duplicateOf = twin.record.name;
    });
    checked.forEach(function (info) { info.flags = auditCopy(info, referenceInfo); });

    busy(false);
    $('progress').hidden = true;
    $('progress-bar').style.width = '0';
    setStatus('Move check done — ' + checked.length + ' host' + (checked.length === 1 ? '' : 's') + ' inspected.');
    renderMoveReport(checked, referenceInfo, markedMissing);
    $('move-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // A row's first cell names what every other cell in it describes, which makes
  // it a header, not data — the difference between a screen reader announcing
  // "Size, 50 KB" and "img.example.com, Size, 50 KB" in an eight-column table.
  function columnHeader(label) {
    var cell = el('th', null, label);
    cell.setAttribute('scope', 'col');
    return cell;
  }

  function rowHeader(name) {
    var cellHeader = el('th');
    cellHeader.setAttribute('scope', 'row');
    var cell = el('span', 'host-cell');
    cell.appendChild(el('span', 'dot'));
    cell.appendChild(document.createTextNode(name));
    cellHeader.appendChild(cell);
    return cellHeader;
  }

  function renderMoveReport(checked, reference, markedMissing) {
    $('move-panel').hidden = false;

    var box = $('move-verdict');
    box.innerHTML = '';

    var others = checked.filter(function (info) { return info !== reference; });
    // Anything the audit called "bad" that is not about identity: a file can be
    // the right bytes and still be served in a way that breaks it.
    var served = checked.filter(function (info) {
      return info.ok && info.flags.some(function (f) { return f.level === 'bad'; });
    });

    var headline;
    if (!reference || !reference.ok) {
      headline = 'The original could not be read.';
    } else if (!others.length) {
      headline = served.length
        ? 'The file is there, but not being served properly.'
        : 'One host checked — nothing to compare it against.';
    } else {
      // Three outcomes, not two. A copy nobody could read is not a copy that
      // failed the comparison, and lumping the two together would report a
      // CORS-refusing host as a corrupted file.
      var comparable = others.filter(function (info) {
        return info.ok && info.buffer && reference.buffer && !info.duplicateOf;
      });
      var identical = comparable.filter(function (info) {
        return sameBytes(info.buffer, reference.buffer);
      }).length;
      var unverified = others.filter(function (info) { return info.ok && comparable.indexOf(info) < 0; }).length;
      var broken = others.filter(function (info) { return !info.ok; }).length;
      var trailer = unverified
        ? ' ' + unverified + (unverified === 1 ? ' copy could' : ' copies could') + ' not be compared at all.'
        : '';

      if (broken === others.length) {
        headline = broken === 1 ? 'The copy did not load at all.' : 'None of the copies loaded at all.';
      } else if (broken) {
        headline = broken + ' of ' + others.length + ' copies did not load at all.';
      } else if (!comparable.length) {
        headline = 'Nothing could be compared.';
      } else if (identical < comparable.length) {
        headline = identical
          ? identical + ' of ' + comparable.length + ' comparable copies match the original byte for byte.' + trailer
          : (comparable.length === 1 ? 'The copy is not the same file as the original.' : 'No comparable copy matches the original.') + trailer;
      } else if (served.length) {
        // The bytes matching is not the same as the move having worked. Saying
        // "identical" over the top of a wrong content type would be the exact
        // false all-clear this check exists to prevent.
        headline = (comparable.length === 1
          ? 'The bytes match, but the copy is not being served properly.'
          : 'The bytes all match, but ' + served.length + ' host'
            + (served.length === 1 ? ' is' : 's are') + ' not serving them properly.') + trailer;
      } else {
        headline = (comparable.length === 1
          ? 'The copy is byte-for-byte identical to the original.'
          : 'All ' + comparable.length + ' comparable copies are byte-for-byte identical to the original.') + trailer;
      }
    }
    box.appendChild(el('p', 'verdict-headline', headline));

    var detail = el('p', 'verdict-detail');
    detail.textContent = reference
      ? 'Compared against ' + reference.record.name + ' (' + hostLabel(reference.url) + '), marked as the original. '
        + 'Each host was requested once, with a cache-busting token, so this describes what the host is holding now rather than what an edge cached earlier.'
      : 'Nothing to compare.';
    box.appendChild(detail);

    if (markedMissing && reference) {
      box.appendChild(el('p', 'verdict-caveat',
        'The card you marked as the original is not in this run — it is unticked, empty, or gone — so '
        + reference.record.name + ' stood in for it.'));
    }

    // The all-clear needs positive proof, not the absence of a complaint. A run
    // in which nothing could be read produces no bad flags either, and telling
    // somebody to proceed on that basis is the worst thing this page could do.
    var proved = others.length && reference && reference.ok && others.every(function (info) {
      return info.ok && !info.duplicateOf && info.buffer && reference.buffer
        && sameBytes(info.buffer, reference.buffer);
    });
    var anyBad = checked.some(function (info) {
      return info.flags.some(function (f) { return f.level === 'bad'; });
    });
    if (proved && !anyBad) {
      box.appendChild(el('p', 'verdict-detail',
        'Every copy was read and matched. Nothing here blocks the move — run the speed test next to see whether the new host is actually quicker.'));
    } else if (!anyBad && others.length) {
      box.appendChild(el('p', 'verdict-detail',
        'Nothing is obviously broken, but not everything could be verified. Read the host-by-host notes below before treating this as a clean move.'));
    }

    var table = $('move-table');
    table.innerHTML = '';

    var head = el('thead');
    var headRow = el('tr');
    ['Host', 'Result', 'Type', 'Size', 'Pixels', 'Cache-Control', 'Protocol', 'Digest'].forEach(function (label) {
      headRow.appendChild(columnHeader(label));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = el('tbody');
    checked.forEach(function (info) {
      var row = el('tr');
      row.style.setProperty('--host', info.record.colour);

      var nameCell = rowHeader(info.record.name);
      row.appendChild(nameCell);

      var verdictCell = el('td');
      var badge;
      if (!info.ok) {
        badge = el('span', 'badge bad', info.error || 'failed');
      } else if (info === reference) {
        // Identity, not the flag: where the marked card is missing from the run
        // another one stands in for it, and that row is the reference here even
        // though nobody marked it.
        badge = el('span', 'badge', 'reference');
      } else if (info.duplicateOf) {
        badge = el('span', 'badge warn', 'same URL');
      } else if (info.buffer && reference && reference.buffer) {
        badge = sameBytes(info.buffer, reference.buffer)
          ? el('span', 'badge good', 'identical')
          : el('span', 'badge bad', 'different');
      } else {
        badge = el('span', 'badge warn', 'unverified');
      }
      verdictCell.appendChild(badge);
      row.appendChild(verdictCell);

      // A refused cross-origin read leaves every header unreadable. "None" would
      // be a measurement; these cells have to say they never saw one.
      var unread = info.corsBlocked;
      row.appendChild(el('td', info.type ? null : 'miss',
        info.type ? info.type.split(';')[0] : (unread ? 'not readable' : 'unknown')));
      // Not a truthiness test: nought bytes is a reading, and an important one.
      row.appendChild(el('td', info.bytes == null ? 'miss' : null,
        info.bytes == null ? 'not readable' : (info.bytes === 0 ? '0 B' : bytes(info.bytes))));
      row.appendChild(el('td', info.width ? null : 'miss', info.width ? info.width + ' × ' + info.height : 'not decoded'));
      row.appendChild(el('td', 'wrap-cell' + (info.cacheControl ? '' : ' miss'),
        info.cacheControl || (unread ? 'not readable' : 'none')));
      row.appendChild(el('td', info.protocol ? null : 'miss', info.protocol || 'not exposed'));
      row.appendChild(el('td', info.digest ? 'digest' : 'miss',
        info.digest ? info.digest.hex.slice(0, 12) : 'not readable'));

      body.appendChild(row);
    });
    table.appendChild(body);

    var notes = $('move-notes');
    notes.innerHTML = '';
    checked.forEach(function (info) {
      var group = el('div', 'note-group');
      group.style.setProperty('--host', info.record.colour);

      var title = el('p', 'note-title');
      title.appendChild(el('span', 'dot'));
      title.appendChild(document.createTextNode(info.record.name));
      var url = el('span', 'note-url', info.url);
      title.appendChild(url);
      group.appendChild(title);

      var list = el('ul', 'note-list');
      info.flags.forEach(function (flag) {
        var item = el('li', 'note ' + flag.level, flag.text);
        list.appendChild(item);
      });
      group.appendChild(list);
      notes.appendChild(group);
    });

    var digests = checked.filter(function (info) { return info.digest; });
    var algos = [];
    digests.forEach(function (info) {
      if (algos.indexOf(info.digest.algo) < 0) algos.push(info.digest.algo);
    });
    var note;
    if (!digests.length) {
      note = 'No digests: the bytes of these hosts could not be read by script, so identity could not be proved.';
    } else {
      note = 'Digests are ' + algos.join(' and ')
        + (algos.indexOf('SHA-256') >= 0 ? ', shown as their first twelve characters' : '') + '. ';
      note += 'Identity above is decided by comparing the bytes themselves, never by the digest.';
      if (algos.indexOf('FNV-1a') >= 0) {
        // Only reachable outside a secure context, where crypto.subtle does not
        // exist. Worth showing, not worth recording as a fingerprint.
        note += ' FNV-1a is the fallback where the browser offers no SHA-256 — this page is not on https or localhost. It is a 32-bit checksum, useful for spotting a change and no use at all as a fingerprint.';
      }
    }
    $('move-digest-note').textContent = note;
  }

  // ── rendering: results ──────────────────────────────────────────────

  function renderResults(results, meta) {
    $('results').hidden = false;
    renderVerdict(results, meta);
    renderBars(results);
    renderPhases(results);
    renderRunChart(results);
    renderRunsTable(results);
  }

  function renderHow(meta) {
    // Say plainly what was measured. The same hosts give very different answers
    // cold and warm, and a reader who does not know which they are looking at
    // cannot use the number.
    var how = el('p', 'verdict-detail');
    how.textContent = meta.mode === 'warm'
      ? 'Measured as a repeat visitor: stable URLs with the browser cache bypassed, so any host with a CDN in front of it answered from its edge.'
      : 'Measured as a first visitor: every URL uniquely cache-busted, so each request missed the browser cache and any CDN edge and went to the origin.';
    if (meta.method === 'image') {
      how.textContent += ' Timed by image load rather than fetch, because '
        + meta.blockedBy.join(' and ') + ' would not permit a cross-origin read.';
    }
    return how;
  }

  function collectCaveats(results, finished, meta, comparing) {
    var caveats = [];

    // Fairness first: a speed comparison between hosts serving different bytes
    // is not a comparison at all.
    if (comparing) {
      var sizes = finished.map(function (r) { return r.bytes; }).filter(Boolean);
      var allProven = finished.every(function (r) { return r.bytesMeasured; });
      if (sizes.length === finished.length && Math.max.apply(null, sizes) - Math.min.apply(null, sizes) > 1024) {
        caveats.push('The hosts returned different byte counts (' +
          finished.map(function (r) { return r.name + ': ' + bytes(r.bytes); }).join(', ') +
          '). They are not serving the same file, so this is not a like-for-like comparison. The move check will tell you exactly how they differ.');
      } else if (!allProven) {
        caveats.push('Byte counts could not be confirmed for every host, so the page cannot prove they served identical files. Run the move check before trusting the ranking.');
      }

      // Two cards pointing at the same URL race the same object against itself.
      var urls = {};
      var duplicated = [];
      finished.forEach(function (r) {
        if (urls[r.url]) duplicated.push(r.url); else urls[r.url] = true;
      });
      if (duplicated.length) {
        caveats.push('Two or more hosts resolve to the same URL (' + duplicated[0] + '), so they are not two hosts. Give them different base URLs.');
      }
    }

    var failed = results.filter(function (r) { return r.failures > 0; });
    if (failed.length) {
      caveats.push(failed.map(function (r) {
        return r.name + ' failed ' + r.failures + ' of ' + (r.failures + r.stats.n) + ' requests'
          + (r.abandoned ? ' and was dropped after the first two' : '');
      }).join('; ') + '. Failures are excluded from the medians above.');
    }
    if (meta.requestedMode === 'warm' && meta.mode === 'cold') {
      caveats.push('Repeat-visitor mode was requested but could not be used: ' + meta.blockedBy.join(' and ')
        + ' would not permit a cross-origin read, so every host fell back to cache-busted first-visitor requests. '
        + 'That removes the CDN advantage this test is meant to show.');
    }
    if (meta.runs < 5) {
      caveats.push('Fewer than five runs per host. That is enough for a rough look and not enough to trust.');
    }
    var mixed = finished.filter(function (r) { return r.wallclockRuns > 0; });
    if (mixed.length) {
      caveats.push(mixed.map(function (r) {
        return r.name + ' had ' + r.wallclockRuns + ' of ' + r.stats.n
          + ' runs timed by wall clock because no resource timing entry arrived';
      }).join('; ') + '. Those readings include a little scheduling overhead the others do not.');
    }
    finished.forEach(function (r) {
      if (r.stats.stdev && r.stats.stdev > r.stats.median * 0.5) {
        caveats.push('The run-to-run spread for ' + r.name + ' is wider than half its median, so your connection was unsettled. Run it again before drawing a conclusion.');
      }
    });

    return caveats;
  }

  function renderVerdict(results, meta) {
    var box = $('verdict');
    box.innerHTML = '';

    var finished = results.filter(function (r) { return r.stats.n > 0; });
    if (!finished.length) {
      box.appendChild(el('p', 'verdict-headline', 'Nothing loaded.'));
      box.appendChild(el('p', 'verdict-detail',
        'No host returned a single successful request. Check the URLs, and check that the image exists at that path — the move check reports exactly what each host said.'));
      collectCaveats(results, finished, meta, false)
        .forEach(function (text) { box.appendChild(el('p', 'verdict-caveat', text)); });
      return;
    }

    // One host is a legitimate run — measuring a single new img.<domain> record
    // is a real question — but it is a measurement, not a comparison, and the
    // verdict must not dress it up as one.
    if (finished.length === 1) {
      var only = finished[0];
      box.appendChild(el('p', 'verdict-headline', only.name + ' — ' + ms(only.stats.median) + ' median'));

      var solo = el('p', 'verdict-detail');
      solo.textContent = 'Over ' + only.stats.n + ' runs of ' + fileLabel(only.url) + ': fastest '
        + ms(only.stats.min) + ', slowest ' + ms(only.stats.max)
        + (only.stats.stdev == null ? '' : ', spread ± ' + ms(only.stats.stdev)) + '. '
        + 'Nothing to rank it against — add a second host to get a comparison.';
      box.appendChild(solo);
      box.appendChild(renderHow(meta));

      // Per host, not per run. meta.method is a whole-run decision: one other
      // host refusing drags everybody down to <img>, and reporting that as this
      // host's refusal would send somebody to fix a rule that is already right.
      var refused = meta.blockedBy.indexOf(hostLabel(only.url)) >= 0;
      var exposure = el('p', 'verdict-detail');
      exposure.textContent = hostLabel(only.url) + ' '
        + (refused ? 'refuses cross-origin reads' : 'permits cross-origin reads')
        + ' and ' + (only.detailed ? 'sends Timing-Allow-Origin, so the phase breakdown below is real'
          : 'sends no Timing-Allow-Origin, so only the total is visible')
        + (only.protocol ? '. It answered over ' + only.protocol + '.' : '.');
      if (!refused && meta.method === 'image') {
        exposure.textContent += ' The run still fell back to image loads, because '
          + meta.blockedBy.join(' and ') + ' refused — so the breakdown above is what that fallback could see, not this host\'s limit.';
      }
      box.appendChild(exposure);

      if (results.length > 1) {
        box.appendChild(el('p', 'verdict-caveat',
          'Only one host produced any measurements — the others failed every request, so this is not the comparison you asked for.'));
      }

      collectCaveats(results, finished, meta, false)
        .forEach(function (text) { box.appendChild(el('p', 'verdict-caveat', text)); });
      box.appendChild(renderLimits(meta, finished));
      return;
    }

    var ranked = finished.slice().sort(function (a, b) { return a.stats.median - b.stats.median; });
    var winner = ranked[0];
    var loser = ranked[ranked.length - 1];
    var ratio = loser.stats.median / winner.stats.median;
    var delta = loser.stats.median - winner.stats.median;

    // Does the gap survive the noise? A ratio means nothing on its own when
    // the run-to-run spread is wider than the difference being claimed.
    var test = differenceIsReal(
      winner.samples.map(function (s) { return s.total; }),
      ranked[1].samples.map(function (s) { return s.total; })
    );
    var separated = test ? test.p < 0.05 : ratio >= 1.25;

    var headline;
    if (!separated) {
      headline = 'Too close to call.';
    } else if (ratio < 1.1) {
      headline = winner.name + ' edged it.';
    } else {
      headline = winner.name + ' won, by ' + ratio.toFixed(1) + '×.';
    }
    box.appendChild(el('p', 'verdict-headline', headline));

    var detail = el('p', 'verdict-detail');
    detail.textContent =
      'Median of ' + ms(winner.stats.median) + ' from ' + hostLabel(winner.url) +
      ' against ' + ms(loser.stats.median) + ' from ' + hostLabel(loser.url) +
      ' — ' + ms(delta) + ' per image. On a page carrying twenty images of this size, that is roughly ' +
      ms(delta * 20) + ' of difference if they were fetched one after another, and rather less in ' +
      'practice because browsers fetch several at once.';
    box.appendChild(detail);

    box.appendChild(renderHow(meta));

    var stat = el('p', 'verdict-detail');
    if (test) {
      stat.textContent = separated
        ? 'The gap against ' + ranked[1].name + ' holds up against the run-to-run noise (Mann-Whitney p ≈ '
          + formatP(test.p) + ' over ' + winner.stats.n + ' and ' + ranked[1].stats.n + ' runs).'
        : 'The spread between runs is wide enough that this ordering could be noise (Mann-Whitney p ≈ '
          + formatP(test.p) + '). Treat the ranking as unproven and run it again, or raise the run count.';
    } else {
      stat.textContent = 'Too few runs to test whether the gap is real rather than noise — four per host is the minimum.';
    }
    box.appendChild(stat);

    collectCaveats(results, finished, meta, true)
      .forEach(function (text) { box.appendChild(el('p', 'verdict-caveat', text)); });

    box.appendChild(renderLimits(meta, finished));
  }

  // Shown on every result, pass or fail. A benchmark that does not state its
  // own scope invites being read as more than it is.
  function renderLimits(meta, finished) {
    var wrap = el('details', 'limits');
    var summary = el('summary', null, 'What this result does and does not establish');
    wrap.appendChild(summary);

    var list = el('ul');
    [
      'It measures your connection, from where you are, right now. It is evidence about your visitors only in so far as they sit where you sit and connect as you connect. A host that wins here can lose from another continent.',
      'It measures ' + (meta.mode === 'warm'
        ? 'the repeat-visitor path, with any CDN edge warm. A first visitor to a cold edge will see slower numbers than these.'
        : 'the first-visitor path, with every cache missed. Ordinary visitors to a host with a CDN will see faster numbers than these.'),
      finished.length === 1
        ? 'It measures one host on one file of one size, and says nothing about how that compares to anywhere else.'
        : 'It compares ' + finished.length + ' hosts on one file of one size. Ranking can and does change with payload size — try a larger image before concluding anything.',
      'Timings come from the browser, which deliberately coarsens its clocks. Differences of a millisecond or two are below the noise floor and should be read as "the same".',
      'A single run of this page is one sample of a noisy process. Agreement across several runs at different times of day is worth far more than one decisive-looking result.'
    ].forEach(function (text) { list.appendChild(el('li', null, text)); });

    wrap.appendChild(list);
    return wrap;
  }

  function renderBars(results) {
    var wrap = $('bars');
    wrap.innerHTML = '';

    var maxMedian = Math.max.apply(null, results.map(function (r) { return r.stats.median || 0; }));

    results.forEach(function (r) {
      var row = el('div', 'bar-row');
      row.style.setProperty('--host', r.colour);

      var meta = el('div', 'bar-meta');
      var left = el('span');
      left.appendChild(el('b', null, r.name));
      left.appendChild(document.createTextNode('  ' + hostLabel(r.url)));
      meta.appendChild(left);

      var right = el('span', 'spread');
      right.textContent = r.stats.n
        ? ms(r.stats.median) + '   (min ' + ms(r.stats.min) + ' · max ' + ms(r.stats.max) + ')'
        : 'no successful runs';
      meta.appendChild(right);
      row.appendChild(meta);

      var track = el('div', 'bar-track');
      var fill = el('div', 'bar-fill' + (r.stats.n ? '' : ' failed'));
      fill.style.width = r.stats.n && maxMedian ? (r.stats.median / maxMedian * 100) + '%' : '100%';
      track.appendChild(fill);
      row.appendChild(track);

      wrap.appendChild(row);
    });
  }

  function renderPhases(results) {
    var table = $('phases');
    table.innerHTML = '';

    var anyDetail = results.some(function (r) { return r.detailed; });
    $('phases-note').textContent = (anyDetail
      ? 'Median of each phase. A host only reveals this breakdown, and the protocol it answered over, if it sends a Timing-Allow-Origin header; where it does not, only the total is available.'
      : 'None of these hosts sends a Timing-Allow-Origin header, so the browser will only tell us the totals. The breakdown below is unavailable — not zero.')
      + ' Sizes are counted from the response body wherever a cross-origin read was permitted, and inferred from the timing entry otherwise. Matching sizes are consistent with the same file; the move check is what proves it.';

    var head = el('thead');
    var headRow = el('tr');
    ['Host', 'DNS', 'Connect + TLS', 'Waiting', 'Downloading', 'Total', 'Size', 'Protocol'].forEach(function (label) {
      headRow.appendChild(columnHeader(label));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = el('tbody');
    results.forEach(function (r) {
      var row = el('tr');
      row.style.setProperty('--host', r.colour);

      row.appendChild(rowHeader(r.name));

      if (r.detailed) {
        [r.phases.dns, r.phases.connect, r.phases.wait, r.phases.download].forEach(function (value) {
          row.appendChild(el('td', null, ms(value)));
        });
      } else {
        for (var i = 0; i < 4; i++) row.appendChild(el('td', 'miss', 'not exposed'));
      }
      row.appendChild(el('td', null, ms(r.stats.median)));
      row.appendChild(el('td', r.bytes ? null : 'miss', r.bytes ? bytes(r.bytes) : 'not exposed'));
      row.appendChild(el('td', r.protocol ? null : 'miss', r.protocol || 'not exposed'));
      body.appendChild(row);
    });
    table.appendChild(body);
  }

  function renderRunChart(results) {
    var svg = $('runchart');
    while (svg.firstChild) svg.removeChild(svg.firstChild);

    var W = 720, H = 200, padL = 54, padR = 12, padT = 12, padB = 28;
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);

    var maxRuns = Math.max.apply(null, results.map(function (r) { return r.samples.length; }));
    var maxTime = Math.max.apply(null, results.map(function (r) {
      return r.samples.length ? Math.max.apply(null, r.samples.map(function (s) { return s.total; })) : 0;
    }));
    if (!maxRuns || !maxTime) return;

    var top = maxTime * 1.12;
    var x = function (i) { return padL + (maxRuns === 1 ? (W - padL - padR) / 2 : i * (W - padL - padR) / (maxRuns - 1)); };
    var y = function (v) { return padT + (1 - v / top) * (H - padT - padB); };

    function svgEl(tag, attrs) {
      var node = document.createElementNS('http://www.w3.org/2000/svg', tag);
      Object.keys(attrs).forEach(function (key) { node.setAttribute(key, attrs[key]); });
      return node;
    }

    // horizontal gridlines with a millisecond label each
    [0, 0.25, 0.5, 0.75, 1].forEach(function (fraction) {
      var value = top * fraction;
      svg.appendChild(svgEl('line', {
        class: fraction === 0 ? 'axis' : 'gridline',
        x1: padL, x2: W - padR, y1: y(value), y2: y(value)
      }));
      var label = svgEl('text', { class: 'tick', x: padL - 8, y: y(value) + 4, 'text-anchor': 'end' });
      label.textContent = Math.round(value) + (fraction === 1 ? ' ms' : '');
      svg.appendChild(label);
    });

    // run numbers along the bottom
    for (var i = 0; i < maxRuns; i++) {
      if (maxRuns > 12 && i % 2) continue;
      var tick = svgEl('text', { class: 'tick', x: x(i), y: H - 8, 'text-anchor': 'middle' });
      tick.textContent = String(i + 1);
      svg.appendChild(tick);
    }

    results.forEach(function (r) {
      if (!r.samples.length) return;
      var points = r.samples.map(function (s, i) { return x(i) + ',' + y(s.total); }).join(' ');
      svg.appendChild(svgEl('polyline', { class: 'series', points: points, stroke: r.colour }));
      r.samples.forEach(function (s, i) {
        svg.appendChild(svgEl('circle', { cx: x(i), cy: y(s.total), r: 3, fill: r.colour }));
      });
    });
  }

  function renderRunsTable(results) {
    var table = $('runs-table');
    table.innerHTML = '';

    var maxRuns = Math.max.apply(null, results.map(function (r) { return r.samples.length; }));

    var head = el('thead');
    var headRow = el('tr');
    headRow.appendChild(columnHeader('Host'));
    for (var i = 1; i <= maxRuns; i++) headRow.appendChild(columnHeader(String(i)));
    headRow.appendChild(columnHeader('Median'));
    headRow.appendChild(columnHeader('Mean'));
    headRow.appendChild(columnHeader('± sd'));
    head.appendChild(headRow);
    table.appendChild(head);

    // the fastest single run overall, so it can be marked in the grid
    var best = Infinity;
    results.forEach(function (r) {
      r.samples.forEach(function (s) { if (s.total < best) best = s.total; });
    });

    var body = el('tbody');
    results.forEach(function (r) {
      var row = el('tr');
      row.style.setProperty('--host', r.colour);

      row.appendChild(rowHeader(r.name));

      for (var i = 0; i < maxRuns; i++) {
        var sample = r.samples[i];
        if (!sample) { row.appendChild(el('td', 'miss', '—')); continue; }
        row.appendChild(el('td', sample.total === best ? 'best' : null, Math.round(sample.total)));
      }
      row.appendChild(el('td', null, ms(r.stats.median)));
      row.appendChild(el('td', null, ms(r.stats.mean)));
      row.appendChild(el('td', null, r.stats.stdev == null ? '—' : ms(r.stats.stdev)));
      body.appendChild(row);
    });
    table.appendChild(body);
  }

  // ── rendering: the visual race ──────────────────────────────────────

  function runRace() {
    if (running) return;
    var hosts = activeHosts();
    if (!hosts.length) { noTargets('race'); return; }

    $('race-panel').hidden = false;
    var track = $('race-track');
    track.innerHTML = '';

    var lanes = hosts.map(function (host, index) {
      var url = bust(urlForHost(host));
      var lane = el('div', 'lane');
      lane.style.setProperty('--host', colourFor(index));

      var head = el('div', 'lane-head');
      head.appendChild(el('b', null, displayName(host)));
      var time = el('span', 'lane-time', 'loading…');
      head.appendChild(time);
      lane.appendChild(head);

      var frame = el('div', 'lane-frame');
      var img = new Image();
      img.alt = displayName(host) + ' sample image';
      frame.appendChild(el('span', 'placeholder', 'waiting'));
      lane.appendChild(frame);
      track.appendChild(lane);

      return { lane: lane, frame: frame, time: time, img: img, url: url };
    });

    var started = performance.now();
    var finished = 0;
    var winner = null;

    lanes.forEach(function (entry) {
      entry.img.onload = function () {
        var elapsed = performance.now() - started;
        entry.frame.innerHTML = '';
        entry.frame.appendChild(entry.img);
        entry.time.textContent = ms(elapsed);
        if (!winner) { winner = entry; entry.lane.classList.add('won'); entry.time.textContent += '  ✓ first'; }
        if (++finished === lanes.length) setStatus('Race finished.');
      };
      entry.img.onerror = function () {
        entry.frame.innerHTML = '';
        entry.frame.appendChild(el('span', 'placeholder', 'failed to load'));
        entry.time.textContent = 'failed';
        if (++finished === lanes.length) setStatus('Race finished, with failures.');
      };
      entry.img.src = entry.url;
    });

    setStatus(lanes.length === 1
      ? 'Loading the image, so you can see it.'
      : 'Racing — every request is in flight at once.');
    $('race-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── rendering: setup ────────────────────────────────────────────────

  function renderHosts() {
    var wrap = $('hosts');
    wrap.innerHTML = '';

    state.hosts.forEach(function (host, index) {
      var card = el('div', 'host');
      card.style.setProperty('--host', colourFor(index));
      card.dataset.enabled = String(host.enabled);

      var toggle = el('input');
      toggle.type = 'checkbox';
      toggle.className = 'host-toggle';
      toggle.checked = host.enabled;
      toggle.addEventListener('change', function () {
        host.enabled = toggle.checked;
        card.dataset.enabled = String(host.enabled);
        save();
      });
      card.appendChild(toggle);

      var body = el('div', 'host-body');

      var top = el('div', 'host-top');
      top.appendChild(el('span', 'dot'));

      var nameInput = el('input', 'host-name-input');
      nameInput.type = 'text';
      nameInput.value = host.label || '';
      nameInput.placeholder = displayName(host);
      nameInput.spellcheck = false;
      nameInput.setAttribute('aria-label', 'Name for this host');
      top.appendChild(nameInput);

      var ref = el('label', 'host-ref');
      var refInput = el('input');
      refInput.type = 'radio';
      refInput.name = 'reference';
      refInput.checked = host.id === state.referenceId;
      refInput.addEventListener('change', function () {
        if (refInput.checked) { state.referenceId = host.id; save(); }
      });
      ref.appendChild(refInput);
      // The visible text is the same on every card, which is fine to look at
      // and useless to listen to: without a name of its own, every radio in the
      // group announces "the original" and none of them says which host.
      var refText = el('span', null, 'the original');
      refText.setAttribute('aria-hidden', 'true');
      ref.appendChild(refText);
      ref.title = 'The move check compares every other host against this one.';
      top.appendChild(ref);

      var remove = el('button', 'host-remove', '×');
      remove.type = 'button';
      remove.title = 'Remove this host';
      remove.addEventListener('click', function () {
        var name = displayName(host);
        state.hosts = state.hosts.filter(function (h) { return h !== host; });
        // Never leave the reference pointing at a card that no longer exists,
        // or every later run reports that the marked original went missing.
        if (state.referenceId === host.id) {
          state.referenceId = state.hosts.length ? state.hosts[0].id : null;
        }
        save();
        renderHosts();
        // The button that had focus has just been destroyed, and without this
        // focus falls to the top of the document.
        var buttons = $('hosts').querySelectorAll('.host-remove');
        if (buttons.length) buttons[Math.min(index, buttons.length - 1)].focus();
        else $('add-preset').focus();
        setStatus(name + ' removed.');
      });
      top.appendChild(remove);
      body.appendChild(top);

      // A shipped card's description names a specific host, so it becomes a lie
      // the moment the card is pointed somewhere else. A preset's description
      // is about the arrangement rather than the URL, so it stays true.
      var blurb = host.blurb ? el('p', 'host-blurb', host.blurb) : null;
      if (blurb) body.appendChild(blurb);

      var input = el('input', 'host-url');
      input.type = 'text';
      input.value = host.base;
      input.placeholder = host.placeholder || 'https://…/';
      input.spellcheck = false;
      input.setAttribute('list', 'known-bases');
      input.setAttribute('aria-label', 'Base URL or whole image URL for this host');

      var resolved = el('p', 'host-resolved');
      function refresh() {
        var url = urlForHost(host);
        if (!url) {
          resolved.textContent = host.base
            ? '→ needs an image path below'
            : '→ no URL set yet';
        } else if (looksLikeFile(host.base)) {
          resolved.textContent = '→ ' + url + '  (a whole image URL — the image picker below is not applied to this card)';
        } else {
          resolved.textContent = '→ ' + url;
        }
        // Every label that names this host has to be rebuilt here, not once at
        // render time: renaming a card or pointing it somewhere else changes
        // what it is called, and a control that announces the old name is how
        // somebody deletes the wrong card.
        var name = displayName(host);
        nameInput.placeholder = name;
        toggle.setAttribute('aria-label', 'Include ' + name + ' in the test');
        remove.setAttribute('aria-label', 'Remove ' + name);
        refInput.setAttribute('aria-label', 'Compare everything against ' + name + ', as the original');
        if (blurb) blurb.hidden = isShipped(host) && host.base !== defaultBaseFor(host.id);
      }
      input.addEventListener('input', function () {
        host.base = input.value;
        refresh();
        save();
      });
      nameInput.addEventListener('input', function () {
        host.label = nameInput.value;
        refresh();
        save();
      });
      refresh();

      body.appendChild(input);
      body.appendChild(resolved);
      card.appendChild(body);
      wrap.appendChild(card);
    });

    if (!state.hosts.length) {
      wrap.appendChild(el('p', 'panel-note', 'No hosts. Add one below.'));
    }
  }

  function addHost(presetId) {
    var preset = PRESETS.filter(function (p) { return p.id === presetId; })[0] || PRESETS[PRESETS.length - 1];
    state.hosts.push({
      id: uid(),
      name: preset.name,
      blurb: preset.blurb,
      placeholder: preset.placeholder,
      label: '',
      base: '',
      enabled: true
    });
    // Somebody who removed every card and started again has marked nothing, so
    // the first card back becomes the original rather than leaving the setting
    // pointing at a host that is gone.
    if (!state.hosts.some(function (h) { return h.id === state.referenceId; })) {
      state.referenceId = state.hosts[0].id;
    }
    save();
    renderHosts();
    // Focus the URL field of the card just added — the only thing to do next.
    var inputs = $('hosts').querySelectorAll('.host-url');
    if (inputs.length) inputs[inputs.length - 1].focus();
  }

  function renderPresetPicker() {
    var select = $('add-preset');
    select.innerHTML = '';
    PRESETS.forEach(function (preset) {
      var option = el('option', null, preset.name);
      option.value = preset.id;
      select.appendChild(option);
    });
    select.value = PRESETS[0].id;
  }

  function renderDatalists() {
    var bases = $('known-bases');
    bases.innerHTML = '';
    state.recentBases.forEach(function (value) {
      var option = el('option');
      option.value = value;
      bases.appendChild(option);
    });

    var paths = $('known-paths');
    paths.innerHTML = '';
    state.recentPaths.forEach(function (value) {
      var option = el('option');
      option.value = value;
      paths.appendChild(option);
    });
  }

  function renderPayloads() {
    var select = $('payload');
    select.innerHTML = '';
    PAYLOADS.forEach(function (payload) {
      var option = el('option', null, payload.label);
      option.value = payload.file;
      select.appendChild(option);
    });
    select.value = state.payload;
    $('custom-path').value = state.customPath;
    updatePayloadHint();
  }

  function renderModes() {
    var select = $('mode');
    select.innerHTML = '';
    MODES.forEach(function (m) {
      var option = el('option', null, m.label);
      option.value = m.id;
      select.appendChild(option);
    });
    select.value = state.mode;
    updateModeHint();
  }

  function updateModeHint() {
    var m = MODES.filter(function (x) { return x.id === state.mode; })[0];
    $('mode-hint').textContent = m ? m.hint : '';
  }

  function updatePayloadHint() {
    var payload = PAYLOADS.filter(function (p) { return p.file === state.payload; })[0];
    $('payload-hint').textContent = payload ? payload.hint : '';
    $('custom-path').hidden = state.payload !== CUSTOM_PAYLOAD;
  }

  function setStatus(text, isError) {
    var node = $('status');
    node.textContent = text;
    node.classList.toggle('error', !!isError);
  }

  function readyMessage() {
    if (!activeHosts().length) {
      if (state.payload === CUSTOM_PAYLOAD && !payloadFile()) {
        return 'Type the path of an image inside your buckets, or paste a whole image URL into a host card.';
      }
      return 'Paste a base URL — img.yourdomain.com, a bucket endpoint — or a whole image URL into a host card.';
    }
    return 'Ready.';
  }

  // ── wiring ──────────────────────────────────────────────────────────

  restore();
  renderHosts();
  renderPresetPicker();
  renderDatalists();
  renderPayloads();
  renderModes();
  $('runs').value = state.runs;
  $('warmup').checked = state.warmup;

  $('payload').addEventListener('change', function () {
    state.payload = this.value;
    updatePayloadHint();
    renderHosts();
    save();
    if (state.payload === CUSTOM_PAYLOAD) $('custom-path').focus();
    setStatus(readyMessage());
  });

  $('custom-path').addEventListener('input', function () {
    state.customPath = this.value;
    renderHosts();
    save();
  });

  $('mode').addEventListener('change', function () {
    state.mode = this.value;
    updateModeHint();
    save();
  });

  $('runs').addEventListener('change', function () {
    var value = Math.round(Number(this.value));
    if (!isFinite(value) || value < 1) value = 1;
    if (value > 40) value = 40;
    state.runs = value;
    this.value = value;
    save();
  });

  $('warmup').addEventListener('change', function () {
    state.warmup = this.checked;
    save();
  });

  // The picker chooses; the button acts. Acting on the select's change event
  // would add a card on every arrow key, which puts the rest of the list out of
  // reach of a keyboard and drops focus into a card nobody asked for.
  $('add-host').addEventListener('click', function () {
    addHost($('add-preset').value);
  });

  $('run').addEventListener('click', runTest);
  $('move').addEventListener('click', runMoveCheck);
  $('race').addEventListener('click', runRace);

  $('reset').addEventListener('click', function () {
    try { localStorage.removeItem(STORAGE_KEY); localStorage.removeItem(LEGACY_KEY); } catch (err) { /* nothing to undo */ }
    state.hosts = freshHosts();
    state.payload = PAYLOADS[1].file;
    state.customPath = '';
    state.runs = 8;
    state.warmup = true;
    state.mode = 'warm';
    state.referenceId = DEFAULT_HOSTS[0].id;
    state.recentBases = [];
    state.recentPaths = [];
    renderHosts();
    renderDatalists();
    renderPayloads();
    renderModes();
    $('runs').value = state.runs;
    $('warmup').checked = state.warmup;
    $('results').hidden = true;
    $('move-panel').hidden = true;
    $('race-panel').hidden = true;
    lastResults = null;
    setStatus('Back to the defaults.');
  });

  setStatus(readyMessage());
})();
