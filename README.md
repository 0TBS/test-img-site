# Image hosting speed test — GitHub vs Backblaze B2

A one-page static site that loads the **same image file** from two or more hosts, one request at a
time, and times each one in the browser using the
[Resource Timing API](https://developer.mozilla.org/en-US/docs/Web/API/PerformanceResourceTiming).

No build step, no dependencies, no tracking. Every measurement stays in the visitor's browser.

```
index.html            the page
assets/style.css      styles
assets/app.js         the test harness
assets/sample-*.jpg   three payload sizes: ~50 KB, ~250 KB, ~1.2 MB
tools/make-samples.py regenerates the sample images
```

## What it actually measures

- Each host gets the same number of runs, and the hosts **alternate turns** so a slow patch in the
  network does not land consistently on one side.
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
  verdict says *Too close to call* instead of naming a winner.
- A **failed request is never a sample.** Any non-2xx is discarded, which matters because errors
  arrive fast: counting one 503 as a success would drag a median toward zero and invent a winner.
- The cross-origin capability probe **retries** and treats *any* response as permission, including a
  5xx. A single transient error must not demote every host to the cruder method — B2 does return the
  occasional 503, so this is a real case rather than a theoretical one.
- Each request reads **its own** resource-timing entry. Repeat-visitor mode reuses one URL per host,
  so entries accumulate under a single name; the page records how many existed before a request and
  ignores anything older, rather than re-reporting the previous run's number.

Where a host sends a `Timing-Allow-Origin` header, the page also breaks the time down into DNS,
connect + TLS, waiting (TTFB) and downloading, and reports the transferred byte count. Where it does
not, the table says *not exposed* rather than pretending the value is zero.

## Running it

Any static server will do — `file://` works too, but a server keeps the timing entries honest:

```sh
python3 -m http.server 8080
# then open http://localhost:8080/
```

## Setting up the comparison

The GitHub side is pre-filled with this repository's raw endpoint:

```
https://raw.githubusercontent.com/0tbs/test-img-site/main/assets/
```

That URL only answers once these files are on `main`. Testing from a branch before it is merged?
Swap `main` for the branch name in the input — the page will remember it.

The Backblaze side is pre-filled too. The same three sample files live in a public B2 bucket in
`us-east-005`, under a `speed-test/` prefix:

```
https://f005.backblazeb2.com/file/brandingcentres-imgsite-test/speed-test/
```

That is the bucket endpoint with nothing in front of it, which is deliberate — it is the honest
"object storage, one region, no CDN" baseline. Two things to expect from it: B2 answers over
**HTTP/1.1**, and it sends no `Timing-Allow-Origin`, so the page will report totals for this host and
`not exposed` for the phase breakdown.

The third card is the CDN comparison, and it is filled in too:

```
https://imgtest.crystic.ca/speed-test/
```

That is the **same bucket, same region, same files**, reached through Cloudflare — the arrangement
the TBOX Studio stack builds at gate 7. Three pieces, no worker:

1. A **proxied CNAME**, `imgtest` → `f005.backblazeb2.com`. On its own this cannot work: B2's native
   URL is `/file/<bucket>/<key>`, and a request arriving as `/speed-test/sample.jpg` names no bucket.
2. A **URL-rewrite transform rule**, scoped to `http.host eq "imgtest.crystic.ca"`, rewriting the
   path to `concat("/file/brandingcentres-imgsite-test", http.request.uri.path)`. This is the piece
   that makes the CNAME mean anything.
3. A **response-header transform rule** on the same expression, setting `Timing-Allow-Origin: *` and
   `Access-Control-Allow-Origin: *` — headers B2 cannot send itself. This is what makes this the one
   host in the test that reports a full phase breakdown rather than just a total.

Both rules are scoped by hostname, so they cannot affect anything else on the zone. Edge caching
needs no configuration: `.jpg` is cached by default and the objects carry a long immutable
`Cache-Control` set at upload.

The gap between card two and card three is the whole point: it separates *"B2 is fast"* from
*"Cloudflare's edge cache is fast"*.

To re-upload the samples to a bucket of your own, keep the file names and set `image/jpeg` as the
content type.

Settings are remembered in `localStorage`, so a reload keeps your URLs.

### Making it a fair fight

- **Serve the identical file.** The page compares transferred byte counts where the hosts expose them
  and warns if they disagree, but it cannot see a size it is not told. If one host re-encodes or
  resizes images, the comparison is meaningless.
- **Add `Timing-Allow-Origin: *`** on the hosts you control, or you only get totals. On Cloudflare
  this is a one-line Response Header Transform Rule.
- **Compare like with like.** `raw.githubusercontent.com` is a repository-reading endpoint: rate
  limited, and not something GitHub's terms invite you to point a production site at. If you want to
  know whether GitHub is a viable host, put **GitHub Pages** (`username.github.io`) in the first card
  instead — that one has a CDN in front of it and is a real comparison.

## Publishing it

**GitHub Pages** — Settings → Pages → deploy from a branch, root folder. The `.nojekyll` file is
already there so `assets/` is served untouched.

**Cloudflare Workers** — the repo is a plain static directory; point Workers Builds at it with no
build command and `.` as the asset directory.

**Railway** — the `Dockerfile` and `Caddyfile` in the root are all it needs: Railway detects the
Dockerfile, builds a Caddy image with the site copied into `/srv`, and serves it on `$PORT`. There is
no build step. Caddy is configured to send `Timing-Allow-Origin: *` and `Access-Control-Allow-Origin:
*`, so a copy of the page running anywhere else can read this host's full phase breakdown and byte
counts rather than only its totals — which makes the Railway deployment usable as a fourth contender
in the test, not just a place to read the page.

## Regenerating the samples

The sample images are synthetic: gradients, blurred blobs, fine arcs and per-pixel grain, so JPEG
cannot compress them down to nothing and the payload sizes stay realistic.

```sh
pip install pillow
python3 tools/make-samples.py
```
