/* GitHub vs Backblaze — image speed test.
 *
 * Loads one image file from several hosts, one request at a time, and times each
 * one with the browser's Resource Timing API. No dependencies, no network calls
 * beyond the images themselves.
 */
(function () {
  'use strict';

  // ── configuration ───────────────────────────────────────────────────

  var STORAGE_KEY = 'img-speed-test/v1';

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
      blurb: 'The bucket endpoint with nothing in front of it: every request travels to the one region the bucket lives in, over HTTP/1.1. It sends no Timing-Allow-Origin, so it reports a total but no phase breakdown.',
      base: B2_DIRECT,
      enabled: true
    },
    {
      id: 'backblaze',
      name: 'Backblaze B2 behind Cloudflare',
      blurb: 'The same bucket, same region, same files — reached through Cloudflare, which answers from an edge cache. HTTP/2, and a response-header rule adds the Timing-Allow-Origin that B2 cannot send itself, so this is the one host here that will show you where the time actually went.',
      base: B2_CLOUDFLARE,
      enabled: true
    }
  ];

  var PAYLOADS = [
    { file: 'sample-small.jpg',  label: 'Small — 900 × 900, about 50 KB',      hint: 'A thumbnail or an icon. At this size connection setup dominates and the file itself is almost free.' },
    { file: 'sample-medium.jpg', label: 'Medium — 1800 × 1800, about 250 KB',  hint: 'A typical content image on a well-built page. The usual sweet spot for telling two hosts apart.' },
    { file: 'sample-large.jpg',  label: 'Large — 3200 × 3200, about 1.2 MB',   hint: 'An unoptimised hero image. Throughput matters more than latency here, so the gap usually widens.' }
  ];

  var TIMEOUT_MS = 20000;
  var FAILED_TIMEOUT_MS = 4000; // short leash once a host has already failed
  var GIVE_UP_AFTER = 2;        // consecutive failures before a host is dropped
  var GAP_MS = 120;             // breathing room so requests never overlap
  var ENTRY_GRACE_MS = 250;     // how long to wait for a resource timing entry

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

  function joinUrl(base, file) {
    var trimmed = String(base || '').trim();
    if (!trimmed) return '';
    if (/\.(jpe?g|png|webp|avif|gif)$/i.test(trimmed)) return trimmed; // a full file URL
    return trimmed.replace(/\/+$/, '') + '/' + file;
  }

  function bust(url) {
    var token = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    return url + (url.indexOf('?') === -1 ? '?' : '&') + 'cb=' + token;
  }

  function formatP(p) {
    if (p < 0.001) return '0.001 or less';
    return p.toFixed(p < 0.01 ? 4 : 3);
  }

  function hostLabel(url) {
    try { return new URL(url).host; } catch (err) { return url; }
  }

  // ── state ───────────────────────────────────────────────────────────

  var state = {
    hosts: DEFAULT_HOSTS.map(function (h) { return Object.assign({}, h); }),
    payload: PAYLOADS[1].file,
    runs: 8,
    warmup: true,
    mode: 'warm'
  };

  function defaultBaseFor(id) {
    var host = DEFAULT_HOSTS.filter(function (h) { return h.id === id; })[0];
    return host ? host.base : '';
  }

  function save() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({
        // defaultBase records what the page shipped at the time this was
        // written. If a later version ships a different URL, that new default
        // wins on the next visit — otherwise a remembered blank would shadow
        // it forever and the host would silently never run.
        hosts: state.hosts.map(function (h) {
          return { id: h.id, base: h.base, enabled: h.enabled, defaultBase: defaultBaseFor(h.id) };
        }),
        payload: state.payload,
        runs: state.runs,
        warmup: state.warmup,
        mode: state.mode
      }));
    } catch (err) { /* private browsing, blocked storage — not worth reporting */ }
  }

  function restore() {
    var raw;
    try { raw = localStorage.getItem(STORAGE_KEY); } catch (err) { return; }
    if (!raw) return;
    var saved;
    try { saved = JSON.parse(raw); } catch (err) { return; }
    if (!saved || typeof saved !== 'object') return;

    if (Array.isArray(saved.hosts)) {
      saved.hosts.forEach(function (entry) {
        var host = state.hosts.filter(function (h) { return h.id === entry.id; })[0];
        if (!host) return;
        // Written by a version that shipped a different URL for this host (or
        // by one that recorded no default at all). Keep the current default
        // rather than restoring a value chosen against an older one.
        if (entry.defaultBase !== defaultBaseFor(entry.id)) return;
        if (typeof entry.base === 'string') host.base = entry.base;
        if (typeof entry.enabled === 'boolean') host.enabled = entry.enabled;
      });
    }
    if (PAYLOADS.some(function (p) { return p.file === saved.payload; })) state.payload = saved.payload;
    if (saved.runs >= 1 && saved.runs <= 40) state.runs = Math.round(saved.runs);
    if (typeof saved.warmup === 'boolean') state.warmup = saved.warmup;
    if (MODES.some(function (m) { return m.id === saved.mode; })) state.mode = saved.mode;
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
  function probeCors(url) {
    return fetch(bust(url), { mode: 'cors', cache: 'no-store' })
      .then(function (response) { return response.ok; })
      .catch(function () { return false; });
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

  // ── the test ────────────────────────────────────────────────────────

  var running = false;
  var lastResults = null;
  var lastMeta = null;

  function activeHosts() {
    return state.hosts.filter(function (h) {
      return h.enabled && joinUrl(h.base, state.payload);
    });
  }

  async function runTest() {
    if (running) return;

    var hosts = activeHosts();
    if (hosts.length < 2) {
      setStatus('Give at least two hosts a base URL and tick them on — there is nothing to compare otherwise.', true);
      return;
    }

    running = true;
    $('run').disabled = true;
    $('race').disabled = true;
    $('progress').hidden = false;

    if (performance.setResourceTimingBufferSize) performance.setResourceTimingBufferSize(1000);
    if (performance.clearResourceTimings) performance.clearResourceTimings();
    startObserver();

    var results = hosts.map(function (host, index) {
      return {
        host: host,
        colour: 'var(--host-' + ((index % 3) + 1) + ')',
        url: joinUrl(host.base, state.payload),
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
      payload: state.payload,
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
    lastMeta = run_meta;
    running = false;
    $('run').disabled = false;
    $('race').disabled = false;
    $('progress').hidden = true;
    $('progress-bar').style.width = '0';
    setStatus('Done — ' + state.runs + ' runs per host on ' + state.payload
      + ' (' + (run_meta.mode === 'warm' ? 'repeat visitor' : 'first visitor') + ').');
    renderResults(results, run_meta);
    $('results').scrollIntoView({ behavior: 'smooth', block: 'start' });
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

  function renderVerdict(results, meta) {
    var box = $('verdict');
    box.innerHTML = '';

    var finished = results.filter(function (r) { return r.stats.n > 0; });
    if (finished.length < 2) {
      box.appendChild(el('p', 'verdict-headline', 'Not enough successful runs to compare.'));
      box.appendChild(el('p', 'verdict-detail',
        'At least one host returned nothing. Check the URL, and check that the file exists at that path.'));
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
      headline = winner.host.name + ' edged it.';
    } else {
      headline = winner.host.name + ' won, by ' + ratio.toFixed(1) + '×.';
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

    // Say plainly what was measured. The same three hosts give very different
    // answers cold and warm, and a reader who does not know which they are
    // looking at cannot use the number.
    var how = el('p', 'verdict-detail');
    how.textContent = meta.mode === 'warm'
      ? 'Measured as a repeat visitor: stable URLs with the browser cache bypassed, so any host with a CDN in front of it answered from its edge.'
      : 'Measured as a first visitor: every URL uniquely cache-busted, so each request missed the browser cache and any CDN edge and went to the origin.';
    if (meta.method === 'image') {
      how.textContent += ' Timed by image load rather than fetch, because '
        + meta.blockedBy.join(' and ') + ' would not permit a cross-origin read.';
    }
    box.appendChild(how);

    var stat = el('p', 'verdict-detail');
    if (test) {
      stat.textContent = separated
        ? 'The gap against ' + ranked[1].host.name + ' holds up against the run-to-run noise (Mann-Whitney p ≈ '
          + formatP(test.p) + ' over ' + winner.stats.n + ' and ' + ranked[1].stats.n + ' runs).'
        : 'The spread between runs is wide enough that this ordering could be noise (Mann-Whitney p ≈ '
          + formatP(test.p) + '). Treat the ranking as unproven and run it again, or raise the run count.';
    } else {
      stat.textContent = 'Too few runs to test whether the gap is real rather than noise — four per host is the minimum.';
    }
    box.appendChild(stat);

    var caveats = [];

    // Fairness first: a speed comparison between hosts serving different bytes
    // is not a comparison at all.
    var sizes = finished.map(function (r) { return r.bytes; }).filter(Boolean);
    var allProven = finished.every(function (r) { return r.bytesMeasured; });
    if (sizes.length === finished.length && Math.max.apply(null, sizes) - Math.min.apply(null, sizes) > 1024) {
      caveats.push('The hosts returned different byte counts (' +
        finished.map(function (r) { return hostLabel(r.url) + ': ' + bytes(r.bytes); }).join(', ') +
        '). They are not serving the same file, so this is not a like-for-like comparison.');
    } else if (!allProven) {
      caveats.push('Byte counts could not be confirmed for every host, so the page cannot prove they served identical files. Check that yourself before trusting the ranking.');
    }
    var failed = results.filter(function (r) { return r.failures > 0; });
    if (failed.length) {
      caveats.push(failed.map(function (r) {
        return hostLabel(r.url) + ' failed ' + r.failures + ' of ' + (r.failures + r.stats.n) + ' requests'
          + (r.abandoned ? ' and was dropped after the first two' : '');
      }).join('; ') + '. Failures are excluded from the medians above.');
    }
    if (meta.requestedMode === 'warm' && meta.mode === 'cold') {
      caveats.push('Repeat-visitor mode was requested but could not be used: ' + meta.blockedBy.join(' and ')
        + ' would not permit a cross-origin read, so every host fell back to cache-busted first-visitor requests. '
        + 'That removes the CDN advantage this test is meant to show.');
    }
    if (state.runs < 5) {
      caveats.push('Fewer than five runs per host. That is enough for a rough look and not enough to trust.');
    }
    var mixed = finished.filter(function (r) { return r.wallclockRuns > 0; });
    if (mixed.length) {
      caveats.push(mixed.map(function (r) {
        return hostLabel(r.url) + ' had ' + r.wallclockRuns + ' of ' + r.stats.n
          + ' runs timed by wall clock because no resource timing entry arrived';
      }).join('; ') + '. Those readings include a little scheduling overhead the others do not.');
    }
    if (winner.stats.stdev && winner.stats.stdev > winner.stats.median * 0.5) {
      caveats.push('The run-to-run spread is wider than half the median, so your connection was unsettled. Run it again before drawing a conclusion.');
    }
    caveats.forEach(function (text) { box.appendChild(el('p', 'verdict-caveat', text)); });

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
      'It compares ' + finished.length + ' host' + (finished.length === 1 ? '' : 's') + ' on one file of one size. Ranking can and does change with payload size — try the other sizes before concluding anything.',
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
      left.appendChild(el('b', null, r.host.name));
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
      ? 'Median of each phase. A host only reveals this breakdown if it sends a Timing-Allow-Origin header; where it does not, only the total is available.'
      : 'None of these hosts sends a Timing-Allow-Origin header, so the browser will only tell us the totals. The breakdown below is unavailable — not zero.')
      + ' Sizes marked as measured were counted from the response body, so they prove the hosts served the same file.';

    var head = el('thead');
    var headRow = el('tr');
    ['Host', 'DNS', 'Connect + TLS', 'Waiting', 'Downloading', 'Total', 'Size'].forEach(function (label) {
      headRow.appendChild(el('th', null, label));
    });
    head.appendChild(headRow);
    table.appendChild(head);

    var body = el('tbody');
    results.forEach(function (r) {
      var row = el('tr');
      row.style.setProperty('--host', r.colour);

      var nameCell = el('td');
      var cell = el('span', 'host-cell');
      cell.appendChild(el('span', 'dot'));
      cell.appendChild(document.createTextNode(r.host.name));
      nameCell.appendChild(cell);
      row.appendChild(nameCell);

      if (r.detailed) {
        [r.phases.dns, r.phases.connect, r.phases.wait, r.phases.download].forEach(function (value) {
          row.appendChild(el('td', null, ms(value)));
        });
      } else {
        for (var i = 0; i < 4; i++) row.appendChild(el('td', 'miss', 'not exposed'));
      }
      row.appendChild(el('td', null, ms(r.stats.median)));
      row.appendChild(el('td', r.bytes ? null : 'miss', r.bytes ? bytes(r.bytes) : 'not exposed'));
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
    headRow.appendChild(el('th', null, 'Host'));
    for (var i = 1; i <= maxRuns; i++) headRow.appendChild(el('th', null, String(i)));
    headRow.appendChild(el('th', null, 'Median'));
    headRow.appendChild(el('th', null, 'Mean'));
    headRow.appendChild(el('th', null, '± sd'));
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

      var nameCell = el('td');
      var cell = el('span', 'host-cell');
      cell.appendChild(el('span', 'dot'));
      cell.appendChild(document.createTextNode(r.host.name));
      nameCell.appendChild(cell);
      row.appendChild(nameCell);

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
    if (hosts.length < 2) {
      setStatus('Give at least two hosts a base URL and tick them on — there is nothing to race.', true);
      return;
    }

    $('race-panel').hidden = false;
    var track = $('race-track');
    track.innerHTML = '';

    var lanes = hosts.map(function (host, index) {
      var url = bust(joinUrl(host.base, state.payload));
      var lane = el('div', 'lane');
      lane.style.setProperty('--host', 'var(--host-' + ((index % 3) + 1) + ')');

      var head = el('div', 'lane-head');
      head.appendChild(el('b', null, host.name));
      var time = el('span', 'lane-time', 'loading…');
      head.appendChild(time);
      lane.appendChild(head);

      var frame = el('div', 'lane-frame');
      var img = new Image();
      img.alt = host.name + ' sample image';
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

    setStatus('Racing — both requests are in flight at once.');
    $('race-panel').scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  // ── rendering: setup ────────────────────────────────────────────────

  function renderHosts() {
    var wrap = $('hosts');
    wrap.innerHTML = '';

    state.hosts.forEach(function (host, index) {
      var card = el('div', 'host');
      card.style.setProperty('--host', 'var(--host-' + ((index % 3) + 1) + ')');
      card.dataset.enabled = String(host.enabled);

      var toggle = el('input');
      toggle.type = 'checkbox';
      toggle.checked = host.enabled;
      toggle.setAttribute('aria-label', 'Include ' + host.name + ' in the test');
      toggle.addEventListener('change', function () {
        host.enabled = toggle.checked;
        card.dataset.enabled = String(host.enabled);
        save();
      });
      card.appendChild(toggle);

      var body = el('div', 'host-body');

      var name = el('div', 'host-name');
      name.appendChild(el('span', 'dot'));
      name.appendChild(document.createTextNode(host.name));
      body.appendChild(name);

      body.appendChild(el('p', 'host-blurb', host.blurb));

      var input = el('input', 'host-url');
      input.type = 'url';
      input.value = host.base;
      input.placeholder = host.placeholder || 'https://…/';
      input.spellcheck = false;
      input.setAttribute('aria-label', host.name + ' base URL');

      var resolved = el('p', 'host-resolved');
      function refresh() {
        var url = joinUrl(host.base, state.payload);
        resolved.textContent = url ? '→ ' + url : '→ no URL set yet';
      }
      input.addEventListener('input', function () {
        host.base = input.value;
        refresh();
        save();
      });
      refresh();

      body.appendChild(input);
      body.appendChild(resolved);
      card.appendChild(body);
      wrap.appendChild(card);
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
  }

  function setStatus(text, isError) {
    var node = $('status');
    node.textContent = text;
    node.classList.toggle('error', !!isError);
  }

  // ── wiring ──────────────────────────────────────────────────────────

  restore();
  renderHosts();
  renderPayloads();
  renderModes();
  $('runs').value = state.runs;
  $('warmup').checked = state.warmup;

  $('payload').addEventListener('change', function () {
    state.payload = this.value;
    updatePayloadHint();
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

  $('run').addEventListener('click', runTest);
  $('race').addEventListener('click', runRace);

  $('reset').addEventListener('click', function () {
    try { localStorage.removeItem(STORAGE_KEY); } catch (err) { /* nothing to undo */ }
    state.hosts = DEFAULT_HOSTS.map(function (h) { return Object.assign({}, h); });
    state.payload = PAYLOADS[1].file;
    state.runs = 8;
    state.warmup = true;
    state.mode = 'warm';
    renderHosts();
    renderPayloads();
    renderModes();
    $('runs').value = state.runs;
    $('warmup').checked = state.warmup;
    $('results').hidden = true;
    $('race-panel').hidden = true;
    lastResults = null;
    setStatus('Back to the defaults.');
  });

  if (!state.hosts.some(function (h) { return h.enabled && h.base; })) {
    setStatus('Paste the base URL of your Backblaze bucket above, then run the test.');
  } else {
    setStatus('Ready.');
  }
})();
