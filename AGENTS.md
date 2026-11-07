# AGENTS.md

For people and AI agents (Claude Code, Codex, Cursor and others) working in this repository: how to build, run,
test and deploy it, your own copy included. 1ms.dog's operations notes (how speed.1ms.dog itself is deployed and
run) are in the private repository 1ms-shell.

## What this is

A speed test that runs in the browser:

- **Download, upload, latency and bufferbloat** against Cloudflare's speed test servers (the ones behind
  speed.cloudflare.com), at the data center nearest the visitor. Nothing passes through the site serving the page.
- **UDP loss and whether QUIC gets through**, to a small server of its own (`server/`, one Go process). Optional:
  the page only shows that row on the host it is configured for (`src/rtc.mjs` and `RTC_ON` in `src/app.js`), so a
  copy without the server simply doesn't have it.
- 10 languages, shared results in links (`/<lang>/r/<code>`), direct rules for proxy tools, an embed mode.

The page is static files on a Cloudflare Worker (`src/worker.js` only answers `/r/<code>` and 404s). What each file
does is listed in [README.md](README.md#files); the reasons behind the design are in [docs/design.md](docs/design.md).

## Run it locally

```bash
npm ci
npm run build              # writes public/ from src/ (pages, assets, rule sets, CSP)
node scripts/capped.mjs    # http://localhost:8870/zh-cn/, every speed request capped at 16 KB
```

**Don't run full speed tests to check a change.** A real run moves hundreds of MB, which costs whoever runs it. Check
layout, strings and the flow of a test with `scripts/capped.mjs` (the speeds it shows are meaningless), or open a
shared result (`/zh-cn/r/<code>`), which shows a full result without measuring anything. `npm run dev` (wrangler)
serves the real thing.

## Test by what you changed

| Change | Run |
|---|---|
| Anything | `npm test`: `public/` is up to date with `src/` (rebuild first), every string in all 10 languages with the same placeholders, the unit tests. CI runs it on every push |
| Strings, layout, styles | the above, plus the page at 375 px wide in de, ru and fr (the longest): nothing cut off, no sideways scroll |
| The share card | open it in en, de, ru and fr with the longest real result; `window.__msShareClips` must stay empty (the share component logs every word it had to cut) |
| Measurement (`src/measure.mjs`, `src/rtc.mjs`) | `npm test`, then one run on `scripts/capped.mjs` with the console open: no errors, no unhandled rejections, the stop button works in each phase |
| Cloudflare's endpoints | `npm run verify` (tiny requests; also weekly in GitHub Actions) |
| `server/` | `go vet ./...` and a build (below), then the checks under "Verify" |

## Deploy the page

`npx wrangler deploy` uploads `public/` and the Worker. With Cloudflare Workers Builds connected to the repository,
a push to `main` deploys (`npm ci && npm test`, then `npx wrangler deploy`; nothing ships when `public/` is stale or
a test fails), so commit `public/` together with `src/`. `wrangler.toml` binds no domain: bind yours to the Worker
in the dashboard and build with `SITE_URL=https://<your-domain> npm run build`.

## Run the UDP and QUIC server

One Go binary under systemd on any Linux VPS with a public IPv4 (and IPv6, if you want it tested). Three ports, set
by flags: an HTTPS port for the WebRTC offer and a WebSocket echo (`-sig`, default `:2087`), a UDP port every
WebRTC peer shares (`-ice`, default `40100`, ice-lite) and a UDP port for WebTransport (`-wt`, default `:40101`). It
writes no access log and keeps nothing (see the top of `server/main.go`); about 12 MB of memory.

1. **Get the binary.** Every push to `main` that touches `server/` publishes a static linux/amd64 build as a GitHub
   Release (tag `server-<short commit>`, always marked latest; `.github/workflows/server.yml`). On the server, no Go
   needed:
   ```bash
   curl -fLO https://github.com/yt1988/speed-test/releases/latest/download/rtc
   curl -fLO https://github.com/yt1988/speed-test/releases/latest/download/SHA256SUMS
   sha256sum -c SHA256SUMS          # must print "rtc: OK"
   chmod 755 rtc
   ```
   That build answers only the page origins listed in `server/main.go`. For your own domains (step 2), build it
   yourself with Go 1.27 or newer, on any machine:
   ```bash
   cd server
   GOOS=linux GOARCH=amd64 CGO_ENABLED=0 go build -trimpath -ldflags="-s -w" -o rtc .
   ```
   Keep quic-go at the version webtransport-go asks for in its go.mod (newer quic-go doesn't build with it).
2. **Point it at your domains**: the page's server address is `RTC` in `src/rtc.mjs`, the hosts that show the row
   are in `RTC_ON` (`src/app.js`), the CSP takes its origins from `src/rtc.mjs` at build time, and the server only
   answers the page origins in `origins` (`server/main.go`).
3. **Install**: a system user for it, a directory such as `/opt/<app>/` with the binary, and a DNS name for the
   server pointing straight at it (not through a proxy or CDN: browsers connect to it directly, over UDP too).
4. **Firewall**: open the three ports for IPv4 *and* IPv6. A cloud firewall often has a separate IPv6 list; with
   only IPv4 open, dual-stack visitors wait for the IPv6 attempt to time out.
5. **Certificate** for the server's name (certbot or any ACME client). The service reads `fullchain.pem` and
   `privkey.pem` from systemd's credentials directory (`LoadCredential=`), so it needs no access to the key's
   original place; restart it after each renewal.
6. **UDP buffers**: `net.core.rmem_max` and `net.core.wmem_max` at 7500000 (a file in `/etc/sysctl.d/`, then
   `sysctl --system`). Without it quic-go logs "failed to sufficiently increase receive buffer size" at start; it
   works, with less headroom.
7. **The unit**: `server/1ms-speed.service` is the one speed.1ms.dog runs; copy it, change the paths, the user,
   the certificate's directory and `-public4`, then `systemctl daemon-reload && systemctl enable --now <unit>`.
   `-public4` is the server's public IPv4: behind a cloud provider's NAT the machine only sees its private address,
   and WebRTC must announce the public one. The sockets still listen on all addresses.

### Verify

- `systemctl is-active <unit>`; its journal shows the start line and nothing else (no buffer warning); `ss -tulnp`
  lists all three ports.
- From **another machine** (a cloud firewall doesn't show from inside), over `-4` and `-6`:
  `curl https://<server>:2087/` answers 404; `curl -X POST https://<server>:2087/offer` answers 403 (no allowed
  Origin); with `-H 'Origin: https://<your-page>' -X OPTIONS` it answers 200.
- QUIC: a handshake to `<server>:40101` with ALPN `h3` over IPv4 and IPv6 (`openssl s_client -quic -alpn h3` from
  OpenSSL 3.5, or a few lines with quic-go's `quic.DialAddr`).
- WebRTC: on your page the UDP row fills in during a test. To check IPv4 and IPv6 apart, post an offer from the
  browser console and keep only one family's `a=candidate` lines in the answer before `setRemoteDescription`.
- Memory stays around 10–15 MB; the unit caps it at 96 MB.

Traffic: about 0.4–0.7 MB per test (measured with the browser's `getStats`: 50 data packets a second become about
130 UDP packets and 10 KB a second each way, with WebRTC's own acknowledgements).

## Conventions

- Every visible string is written for each language from the meaning, not translated word for word, in all 10
  languages at once; the string test fails otherwise. Numbers that can be 1 use plural keys (`key_one`, and for
  Russian `key_few`/`key_many`) chosen with `Intl.PluralRules`.
- Country names come from `Intl.DisplayNames` and flags from `/flags/<code>.svg`; `regionName` and `flagCode` in
  `src/app.js` are the only place names and flags come from.
- The share card never cuts words with "…": fit or wrap the text, or make the card taller.
- Every `abort()` carries a reason, and every promise a request makes is handled; an unhandled rejection is a bug
  unless it comes from outside the page (see docs/design.md).
- Nothing about the visitor is stored or logged, by the page or the server; the privacy entry in the help says
  exactly what goes where, in all 10 languages. Change it when that changes.
- Commit messages in English. Secrets never go into the repository.
