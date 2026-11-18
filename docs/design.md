# Design

Why the speed test works the way it does, and what was measured to get there. For how to build, run and deploy it,
see [AGENTS.md](../AGENTS.md).

## The UDP and QUIC row

- **What it shows.** UDP loss with the line idle, while downloading and while uploading, and whether QUIC gets
  through. Calls and games send over UDP, where a lost packet stays lost; the page's HTTP latency samples can't show
  that. QUIC (HTTP/3) runs over UDP too, and some office, school and cross-border networks block or slow it without
  the visitor knowing.
- **Why a server of its own.** A browser can only send UDP through WebRTC (an unreliable, unordered data channel),
  which needs a peer that answers; a Cloudflare Worker can't be one. WebTransport (QUIC) against a WebSocket (TCP)
  to the same server is the only way a page can compare the two: whether the browser uses HTTP/3 to Cloudflare is
  the browser's choice and invisible to the page.
- **One location, and the page says where.** A single server measures the whole route to it. Far from it, part of
  the loss and jitter belongs to the long way there, so the row's heading names the place, the help explains it,
  and the bufferbloat grade and "what it's good for" come from Cloudflare's measurement alone.
- **Beside the speed test, not after it.** QUIC against TCP runs as the test starts and shows in its first
  seconds; each phase's loss updates every 0.5 s (a packet counts once it is 1.5 s old); the final figures, split
  into the way there and back by the server's own count of what arrived, come at the end.
- **How much traffic.** Measured with `getStats`: 50 data packets of 12 bytes a second become about 130 UDP packets
  and 10 KB a second each way with WebRTC's own acknowledgements, 0.4–0.7 MB a test. Halving the rate saves only
  about 27%, because much of that is WebRTC's fixed overhead, and halves the resolution.
- **Safari** has no WebTransport: the QUIC tile says it can't check rather than guessing.
- **For the embed mode's report**: `udpLoss` (over the whole test) and `quic` (handshake through or blocked) in
  `facts`, left out when not measured; the report waits the few seconds the row takes.

## The network row, and first paint

- **The field showed the row as the LCP.** On 2026-11-18, 78% of the page's mobile loads had `#netCf` (the exit
  network) as the LCP element, p75 3,308 ms, while the h1 painted at 2,608 ms; desktop 32%, 2,544 ms. 54% of the
  visitors are on phones.
- **It was waiting for the page script, not for a probe.** The row comes from `/_ms/me` (what Cloudflare already
  knows of this connection), but only `app.js` drew it, and that runs after the render-blocking stylesheet and the
  strings script; the fetch then added a round trip of its own. In a throttled lab (375×667, 4× CPU, 1.6 Mbps,
  150 ms) the row filled at 1,530 ms and became the LCP at 1,550 ms, 390 ms after the h1 painted.
- **The pre-paint snippet now draws it.** The inline script in `<head>` asks `/_ms/me` as the HTML parses and fills
  `#netCf` with the same data (flag, city and country, network, IP) as soon as the JSON arrives — about 340 ms in
  the lab, before first paint. `app.js` replaces it with the full row (links to the ASN and IP quality tools, the
  data center, the proxy warnings) when it runs. It is the real answer, not a placeholder: painting made-up text
  first would freeze the LCP at that paint instead of making the answer arrive sooner (2026-11-05, dns).
- **Measured after the change:** LCP = first paint — 950–1,050 ms in the lab with the preload removed, 1,150–1,170
  with it kept (from 1,550 ms). On the live page before the deploy the same lab read 1,170–1,370 ms, `#netCf` 200 ms
  after the h1. The row no longer bounds LCP; the stylesheet and first paint do.
- **The Geist preload stays.** Dropping it (the fix home made on 2026-11-17) gained first paint ~200 ms in the lab,
  but on the live page it brought a 0.11 CLS: the latency tiles' line boxes change when the font swaps in after
  first paint. With the preload, the font is there before paint and CLS stays 0. Speed's first paint is text, so it
  needs the font the way home did not.
- **Taiwan's name and flag** are repeated in the snippet (it runs without `app.js`), because the tool contract
  fixes them; `test/strings.test.mjs` fails if the two tables ever differ.
- **One round trip is left.** If the shell ever puts these `request.cf` fields into the HTML it already returns,
  every tool could paint its own row with the first paint and this fetch could go. Until then, this is the earliest
  the page can know.

## Errors and aborts

- **Abort rejections from outside the page.** Chrome and Edge 156–157 report unhandled rejections carrying the
  page's own abort reasons ("transfer over", "stopped"; before reasons were added, "signal is aborted without
  reason"). None of the page's promises is left unhandled: checked with Chrome 156 and a local stand-in for
  Cloudflare whose bodies trickle, so each phase really ends mid-body. A browser extension that wraps
  `window.fetch` and reads its own `clone()` of each response without handling errors reproduces them exactly.
- **Why not end a phase by cancelling the reader instead of aborting.** It would silence those reports, but such
  an extension's clone keeps downloading the rest of the body (up to tens of MB), costing the visitor data and
  skewing the next phase. An error collector should count abort and timeout rejections apart from real errors.
- **Every abort carries a reason** ("transfer over": a phase ended; "stopped": the visitor pressed Stop; the probe's
  own timeout), so a report says which it was, and the download reader's `closed` promise has its handler.

## Strings

- **Plurals.** "{n} samples" has `lat_n_one` in every language and `lat_n_few`/`lat_n_many` in Russian, picked with
  `Intl.PluralRules`; the build ships a language's own plural keys, and the string test lets Russian have keys
  English doesn't.
- **Written from the meaning in each language.** Bufferbloat stays untranslated and is explained in plain words
  where it first appears; SQM gets its full name; Korean and Russian say 핑 / Пинг in the labels; French puts a
  non-breaking space before : ; ? ! » and %.

## The share card

- **No words cut off.** With the box ticked, the country and the Cloudflare data center sit on their own line under
  the speeds (with the flag), not at the end of the footer, where long languages lost them to "…"; the card is
  44 px taller then. The latency labels use short forms in es, fr, pt and ru ("Latencia (descarga)"), and the link
  preview images shrink a label's font before cutting it.

## Testing without traffic

- A real run moves hundreds of MB. `scripts/capped.mjs` serves the site with every speed request capped at 16 KB;
  shared-result links show a full result without measuring. To reproduce what only happens mid-body (an abort while
  a response is still streaming), run the page against a local stand-in for `/__down` that sends its body slowly,
  so nothing crosses the internet.
