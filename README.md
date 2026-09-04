# Image host speed test — any image, any bucket

A one-page static site that loads the **same image file** from any number of hosts, one request at a
time, and times each one in the browser using the
[Resource Timing API](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming).
It will also check that an image you have just **moved** from one service to another arrived intact.

No build step, no dependencies, no tracking. Every measurement stays in the visitor's browser.

```
index.html            the page
assets/style.css      styles
assets/app.js         the test harness
assets/sample-*.jpg   three payload sizes: ~50 KB, ~250 KB, ~1.2 MB
tools/make-samples.py regenerates the sample images
```

## Pointing it at your own images

Nothing is hard-coded. A host card takes anything that answers over HTTP, and there can be as many
of them as you like — add, remove and rename them in the first panel.

**A base URL plus a path.** Put `https://img.yourdomain.com/` in a card, pick *An image of your own*
in step 2, and type the object's key — `products/chair.jpg`. That path is appended to every card, so
the same key is compared across every arrangement of the same bucket.

**Or a whole image URL.** Paste `https://img.yourdomain.com/2024/06/hero.jpg` into a card and it is
used exactly as it stands; the image picker is not applied to it. That is how you compare one path
on the old host against a different path on the new one — the usual shape of a migration, where the
WordPress upload lives at `/wp-content/uploads/2024/06/hero.jpg` and the bucket copy does not.

A card is treated as a whole URL when the last segment of its path contains a dot. End a directory
base with `/` if that guess would be wrong.

**One host on its own is a legitimate run.** If you have just brought up a new `img.` record and
only want to know how fast it is, tick one card. The page reports the median and the spread, and
says whether that hostname permits cross-origin reads and sends `Timing-Allow-Origin` — which is the
quickest way to tell whether the response-header rule is really scoped to that hostname. It will not
invent a winner, because there is nobody to beat.

The hostnames and paths you use are remembered and offered back as suggestions, so a second client
site is a few keystrokes. Everything lives in `localStorage` on your own machine; **Reset** clears
it.

## The move check

Speed is the second question about a moved image. The first is whether the file that arrived is the
file you sent. Mark one card as **the original**, press **Check the move**, and every host is
fetched once and compared against it — byte for byte where the bytes can be read, and by size,
dimensions and headers where they cannot.

What it catches, in rough order of how often it actually happens:

- **The wrong content type.** A copy made with a tool that did not set one lands as
  `application/octet-stream` or `binary/octet-stream`. The image still downloads, so an eyeball test
  passes, but browsers may save it rather than show it and CDN image optimisation will skip it.
- **A file that is not the same file.** Something re-encoded or resized it in transit. The byte
  comparison and the pixel dimensions both catch this. A digest of each copy is shown so you can
  record it — SHA-256 where the browser offers it, and a weaker checksum, labelled as such, where it
  does not. Identity itself is always decided by comparing the bytes, never by the digest.
- **Missing cache headers.** An object uploaded without `Cache-Control` is re-fetched far more often
  than it should be, and the CDN in front of it cannot do its job.
- **Missing CORS or timing headers.** A host that refuses cross-origin reads cannot be fetched by
  scripts on your own site, and cannot be verified by this page either. One that merely omits
  `Timing-Allow-Origin` costs you the phase breakdown. On a Cloudflare-fronted bucket both are one
  response-header rule.
- **A path that does not exist** — which shows up as a failed request rather than a slow one.

Every URL is requested with a cache-busting token, so the report describes what the host is holding
now rather than what an edge cached before you replaced the file.

The check is deliberately quiet about things it cannot see. A browser exposes only a handful of
response headers cross-origin without the host opting in, and the two the report uses —
`Content-Type` and `Cache-Control` — are among them; the size is counted from the body rather than
read from a header at all. Anything else, `cf-cache-status` for instance, needs the host to name it
in `Access-Control-Expose-Headers`, and is simply absent from the report otherwise rather than being
declared missing.

A host that refuses the cross-origin read outright has no readable headers at all, and the report
says **not readable** for every one of them rather than **none**. That distinction is the whole
point: a bucket serving a perfect year-long `Cache-Control` that this page cannot see must not be
reported as having none. For the same reason a 403 says the object may well be there and the bucket
may simply not be public, rather than claiming the file is missing — and the all-clear at the top is
printed only when every copy was actually read and matched, never merely because nothing complained.

Nothing here can list what is *in* a bucket. Public object storage serves an object you name but
will not enumerate its contents to an anonymous browser — a `ListObjectsV2` against a public
Backblaze B2 bucket answers `403 AccessDenied: Unauthenticated requests are not allowed for this
api` — so the path has to come from you.

## What the speed test actually measures

- Each host gets the same number of runs, and the order is **shuffled every run** so a slow patch in
  the network cannot land on the same host each time. Strict alternation can align with a periodic
  disturbance; a fresh order cannot.
- Requests are **sequential**, never parallel — two images racing for the same bandwidth measure the
  bandwidth, not the hosts.
- Two modes, because they answer different questions. **Repeat visitor** (the default) uses stable
  URLs with `fetch(..., {cache: 'no-store'})`, bypassing the browser cache while leaving a CDN edge
  cache warm — what nearly every real visitor experiences. **First visitor** adds a unique `?cb=`
  token so each request misses the browser cache *and* the edge and goes to the origin.
- Every host in a run is measured **the same way**. Repeat-visitor mode needs cross-origin reads; if
  any one host refuses, all hosts fall back to `<img>` loads with cache-busting, and the page says so
  rather than quietly mixing methods.
- Byte counts are read **from the response body**, not from a header, so the page can prove the hosts
  served identical files even when they send no `Timing-Allow-Origin`. A mismatch is reported as a
  broken comparison.
- There is an optional untimed **warm-up** request per host, so DNS, TCP and TLS are already paid for
  by the time the clock starts — and in repeat-visitor mode it primes the CDN edge too.
- The headline number is the **median**, not the mean, so one unlucky run cannot move it far, and a
  **Mann–Whitney U test** decides whether the gap survives the run-to-run noise. If it does not, the
  verdict says *Too close to call* instead of naming a winner. With a single host it says neither —
  it reports the measurement and stops.
- A **failed request is never a sample.** Any non-2xx is discarded, which matters because errors
  arrive fast: counting one 503 as a success would drag a median toward zero and invent a winner.
- The cross-origin capability probe **retries** and treats *any* response as permission, including a
  5xx. A single transient error must not demote every host to the cruder method — B2 does return the
  occasional 503, so this is a real case rather than a theoretical one.
- Each request reads **its own** resource-timing entry. Repeat-visitor mode reuses one URL per host,
  so entries accumulate under a single name; the page records how many existed before a request and
  ignores anything older, rather than re-reporting the previous run's number.

Where a host sends a `Timing-Allow-Origin` header, the page also breaks the time down into DNS,
connect + TLS, waiting (TTFB) and downloading, reports the transferred byte count, and names the
protocol it answered over. Where it does not, the table says *not exposed* rather than pretending the
value is zero.

## Running it

Any static server will do — `file://` works too, but a server keeps the timing entries honest, and
`crypto.subtle` (and so SHA-256 digests) is only available in a secure context:

```sh
python3 -m http.server 8080
# then open http://localhost:8080/
```

## The three cards it ships with

They are an experiment rather than a default configuration: the same file, in the same bucket,
reached three ways. Replace them the moment you have something real to test.

**GitHub, raw.** This repository's own raw endpoint:

```
https://raw.githubusercontent.com/0tbs/test-img-site/main/assets/
```

That URL only answers once these files are on `main`. Testing from a branch before it is merged?
Swap `main` for the branch name in the input — the page will remember it.

**Backblaze B2, direct.** The same three sample files in a public B2 bucket in `us-east-005`, under a
`speed-test/` prefix:

```
https://brandingcentres-imgsite-test.s3.us-east-005.backblazeb2.com/speed-test/
```

That is the bucket endpoint with nothing in front of it, which is deliberate — it is the honest
"object storage, one region, no CDN" baseline. It is the **S3-style** address rather than the native
`f005.backblazeb2.com/file/<bucket>/` one because B2 applies bucket CORS rules to the S3 endpoint,
and without a permitted cross-origin read this host could only be measured by the cruder method.
Two things to expect from it: B2 answers over **HTTP/1.1**, and it sends no `Timing-Allow-Origin`, so
the page reports a total for this host and `not exposed` for the phase breakdown.

**The same bucket behind Cloudflare.**

```
https://imgtest.crystic.ca/speed-test/
```

Same bucket, same region, same files — reached through Cloudflare, which is the arrangement the TBOX
Studio stack builds at gate 7. Three pieces, no worker:

1. A **proxied CNAME**, `imgtest` → `f005.backblazeb2.com`. On its own this cannot work: B2's native
   URL is `/file/<bucket>/<key>`, and a request arriving as `/speed-test/sample.jpg` names no bucket.
2. A **URL-rewrite transform rule**, scoped to `http.host eq "imgtest.crystic.ca"`, rewriting the
   path to `concat("/file/brandingcentres-imgsite-test", http.request.uri.path)`. This is the piece
   that makes the CNAME mean anything.
3. A **response-header transform rule** on the same expression, setting `Timing-Allow-Origin: *` and
   `Access-Control-Allow-Origin: *` — headers B2 cannot send itself. This is what makes this the one
   host in the shipped three that reports a full phase breakdown rather than just a total.

Both rules are scoped by hostname, so they cannot affect anything else on the zone. Edge caching
needs no configuration: `.jpg` is cached by default and the objects carry a long immutable
`Cache-Control` set at upload.

The gap between the second card and the third is the whole point: it separates *"B2 is fast"* from
*"Cloudflare's edge cache is fast"*.

To re-upload the samples to a bucket of your own, keep the file names and set `image/jpeg` as the
content type.

### Making it a fair fight

- **Serve the identical file.** The page compares transferred byte counts where the hosts expose them
  and warns if they disagree, but it cannot see a size it is not told. Run the move check first: it
  is the part that proves the hosts are serving the same bytes.
- **Add `Timing-Allow-Origin: *`** on the hosts you control, or you only get totals. On Cloudflare
  this is a one-line Response Header Transform Rule.
- **Compare like with like.** `raw.githubusercontent.com` is a repository-reading endpoint: rate
  limited, and not something GitHub's terms invite you to point a production site at. If you want to
  know whether GitHub is a viable host, put **GitHub Pages** (`username.github.io`) in the card
  instead — that one has a CDN in front of it and is a real comparison.
- **Two cards pointing at the same URL are not two hosts.** The page says so rather than reporting a
  dead heat.

## Publishing it

**GitHub Pages** — Settings → Pages → deploy from a branch, root folder. The `.nojekyll` file is
already there so `assets/` is served untouched.

**Cloudflare Workers** — the repo is a plain static directory; point Workers Builds at it with no
build command and `.` as the asset directory.

**Railway** — the `Dockerfile` and `Caddyfile` in the root are all it needs: Railway detects the
Dockerfile, builds a Caddy image with the site copied into `/srv`, and serves it on `$PORT`. There is
no build step. Caddy is configured to send `Timing-Allow-Origin: *` and `Access-Control-Allow-Origin:
*`, so a copy of the page running anywhere else can read this host's full phase breakdown and byte
counts rather than only its totals — which makes the Railway deployment usable as another contender
in the test, not just a place to read the page.

## Regenerating the samples

The sample images are synthetic: gradients, blurred blobs, fine arcs and per-pixel grain, so JPEG
cannot compress them down to nothing and the payload sizes stay realistic.

```sh
pip install pillow
python3 tools/make-samples.py
```
