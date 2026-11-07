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
