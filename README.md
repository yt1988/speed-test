# Speed Test

**English** · [简体中文](README.zh-CN.md)

How fast is your internet, really? [Speed Test](https://speed.1ms.dog) measures download and upload speed, ping, jitter and the ping under load (bufferbloat) right in your browser, from your own network to the nearest Cloudflare data center, and tells you what the line is good for: 4K video, video calls, online games, cloud gaming, live streaming.

**Live:** https://speed.1ms.dog

## What it measures

| | How |
|---|---|
| **Ping, jitter** | 16 empty downloads one after another on a warm connection. Each request's time (Resource Timing) minus the server's own time (`Server-Timing: cfSpeedWorker`); the median, and the mean difference between neighbours. |
| **Download** | Several requests to `GET /__down?bytes=N` in flight at once, every byte counted as it arrives from the response stream. Request sizes grow with the speed so far (about 1.2 s of data each, 256 KB to 50 MB). |
| **Upload** | The same with `POST /__up` and XHR upload progress (fetch can't report it), random bodies so nothing can compress them. |
| **Speed** | The average after the first 30% of the time, once the connection has ramped up. Each direction runs at least 5 s and stops as soon as the 1-second speeds over the last 2.5 s agree within 8%; at most 10 s. |
| **Ping under load** | An empty download every 0.4 s while data flows. The rise over the idle ping is the bufferbloat: up to 30 ms low, up to 100 ms some, more is heavy. |

The test servers are Cloudflare's own speed test endpoints, the ones behind speed.cloudflare.com and Cloudflare's MIT-licensed [@cloudflare/speedtest](https://github.com/cloudflare/speedtest); they answer any origin. In the browser all requests share one HTTP/2 or HTTP/3 connection, so on long paths the result reads lower than tools that open many TCP connections (the help dialog explains this, and why it reads lower still in mainland China, where Cloudflare's data centers are abroad).

The page waits for Start by default (a test moves 5 to 10 s of your top speed each way); "Test when the page opens" turns on auto-run, remembered in the browser.

### With a proxy on

The test runs through the proxy and measures the proxy node. Before any test the page reads the exit Cloudflare sees (`speed.cloudflare.com/meta`: city, network, IP, data center) and warns when it looks like a proxy: the device's time zone in another country than the exit, or a data-center network. The **Direct rules** button gives rules for Clash/Mihomo, Surge, Shadowrocket, Quantumult X, Loon, sing-box and Xray that send only `speed.cloudflare.com` direct. Remote rule sets: `/rules/clash.yaml`, `surge.list`, `loon.list`, `quanx.list`, `singbox.json`.

### Sharing

A result goes into a link, `/r/<code>` (format in `src/share.mjs`, versioned): the Worker puts the speeds in the page's title and preview, the page shows the result. The share dialog also draws a card image in the browser. Neither carries the IP address or network; country and data center only when the visitor ticks the box.

## Files

```
src/measure.mjs     the test against Cloudflare: ping, download, upload, under-load ping; pure helpers unit-tested
src/net.mjs         the exit Cloudflare sees, and signs of a proxy
src/history.mjs     past results, kept only in the browser
src/verdict.mjs     tiers, bufferbloat, what the line is good for
src/rules.mjs       direct rules for proxy tools
src/share.mjs       results in links
src/app.js          the page script
src/worker.js       /r/<code> previews; a bare 404 for anything else
src/i18n/*.mjs      10 languages
scripts/build.mjs   builds public/ (pages, assets, rule sets, CSP)
scripts/assets.mjs  link preview images (public/og/)
scripts/verify.mjs  checks the endpoints with tiny requests (weekly in GitHub Actions)
```

## Run and deploy

```bash
npm install
npm run build      # writes public/
npm test           # public/ up to date, contract, strings, unit tests
npm run verify     # the endpoints still answer as the page expects
npm run dev        # http://localhost:8796
npx wrangler deploy
```

Static files on a Cloudflare Worker: files are served without running the script (not metered); `src/worker.js` only answers `/r/<code>` and 404s. On 1ms.dog, pushes to `main` deploy through Workers Builds (`npm ci && npm test`, then `npx wrangler deploy`; nothing ships when `public/` is stale or a test fails). `wrangler.toml` binds no domain: on 1ms.dog the shared shell routes `speed.1ms.dog` to it. To self-host, bind your domain to the Worker in the Cloudflare dashboard and build with `SITE_URL=https://your.domain npm run build`.

## License

MIT
