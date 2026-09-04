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
- Every URL carries a unique `?cb=` token, so nothing comes from the browser cache and every request
  is a fresh miss at the CDN edge.
- There is an optional untimed **warm-up** request per host, so DNS, TCP and TLS are already paid for
  by the time the clock starts. Turn it off to measure a cold visitor's very first image instead.
- The headline number is the **median**, not the mean, so one unlucky run cannot move it far.

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

For the Backblaze side, upload the three `assets/sample-*.jpg` files to a B2 bucket, keeping the file
names, and paste the base URL into the second card. In the TBOX Studio stack that is the
`img.<domain>` hostname created at gate 7 — a public B2 bucket with Cloudflare in front of it:

```
https://img.yourdomain.com/
```

The third card, off by default, is for the bucket's own endpoint
(`https://f003.backblazeb2.com/file/your-bucket/`). Enabling it is the interesting part of the test:
it separates *"B2 is fast"* from *"Cloudflare's edge cache is fast"*.

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
