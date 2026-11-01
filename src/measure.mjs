// The test, in the visitor's browser, against Cloudflare's speed test endpoints (the ones speed.cloudflare.com and
// Cloudflare's own MIT-licensed @cloudflare/speedtest library use; both answer any origin):
//   GET  /__down?bytes=N   N bytes; its headers say which data center answered and how long the server took
//   POST /__up             takes the body and answers at once
// Latency: empty downloads one after another on a warm connection, each request's time minus the server's own time
// (Server-Timing: cfSpeedWorker). Download and upload: several requests in flight at once for a few seconds, bytes
// counted as they arrive (download: the response stream; upload: XHR progress), the speed taken over the part after
// the ramp-up. While data flows, an empty download every 400 ms measures the latency under load (bufferbloat).
// The pure helpers at the top are unit-tested; the runners need a browser.

export const CF = "https://speed.cloudflare.com";

export const quantile = (a, q) => {
  if (!a.length) return null;
  const s = [...a].sort((x, y) => x - y), i = (s.length - 1) * q, lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
};
export const median = a => quantile(a, .5);
// jitter: the mean difference between one latency sample and the next
export const jitter = a => a.length < 2 ? null : a.slice(1).reduce((s, v, i) => s + Math.abs(v - a[i]), 0) / (a.length - 1);
export const mbps = (bytes, ms) => ms > 0 ? bytes * 8 / ms / 1000 : 0;

// the server's own time in a Server-Timing header, in ms: the Worker's, which includes the edge's
export function serverTime(h) {
  if (!h) return 0;
  const m = /cfSpeedWorker;dur=([\d.]+)/.exec(h) || /dur=([\d.]+)/.exec(h);
  return m ? +m[1] : 0;
}
// the TCP (or QUIC) round trip as the server's kernel sees it, in ms (cfL4 in Server-Timing), or null
export function l4(h) {
  const m = /cfL4;desc="\?([^"]*)"/.exec(h || "");
  if (!m) return null;
  const p = new URLSearchParams(m[1]), us = k => p.has(k) && !isNaN(+p.get(k)) ? +p.get(k) / 1000 : null;
  return { proto: p.get("proto") || "", rtt: us("rtt"), minRtt: us("min_rtt") };
}
// where the request went and where it came from: cf-meta-* headers on /__down
export function meta(get) {
  const v = k => { const s = get("cf-meta-" + k); return s ? s.trim() : ""; };
  return { colo: v("colo"), asn: v("asn"), country: v("country"), city: v("city"), ip: v("ip") };
}

// The size of the next request on one of `streams` parallel requests: about `secs` of data at the speed so far,
// within [lo, hi] and in whole 64 KB. Small to start, so a slow line still finishes its first requests.
export function nextSize(bps, streams, { lo = 256e3, hi = 50e6, secs = 1.2 } = {}) {
  const want = bps > 0 ? bps / 8 * secs / streams : lo;
  return Math.round(Math.max(lo, Math.min(hi, want)) / 65536) * 65536 || 65536;
}

// samples: [[ms since start, bytes so far]] every 100 ms. The speed over the last `win` ms (what the gauge shows).
export function rateNow(s, win = 1000) {
  if (s.length < 2) return 0;
  const [t1, b1] = s[s.length - 1];
  let i = s.length - 1;
  while (i > 0 && t1 - s[i - 1][0] <= win) i--;
  const [t0, b0] = s[i === s.length - 1 ? i - 1 : i];
  return mbps(b1 - b0, t1 - t0);
}
// The result: the average speed after the ramp-up, from 30% of the time on (TCP's slow start and the first requests'
// set-up are behind it by then; a steady line gives the same number however it's cut).
export function steady(s) {
  if (s.length < 2) return 0;
  const end = s[s.length - 1], from = end[0] * .3;
  const a = s.find(x => x[0] >= from) || s[0];
  return a === end ? mbps(end[1], end[0]) : mbps(end[1] - a[1], end[0] - a[0]);
}
// Done early when the speed has settled: past `min` ms, the 1-second speeds over the last 2.5 s within 8% of each other
export function settled(s, min = 5000) {
  const end = s.length ? s[s.length - 1][0] : 0;
  if (end < min) return false;
  const r = [];
  for (let k = s.length - 1; k >= 0 && end - s[k][0] <= 2500; k -= 5) r.push(rateNow(s.slice(0, k + 1)));
  const m = r.reduce((a, b) => a + b, 0) / r.length;
  return r.length >= 5 && m > 0 && (Math.max(...r) - Math.min(...r)) / m < .08;
}

/* ---------- in the browser ---------- */

const uid = () => Math.random().toString(36).slice(2, 10);
const sleep = (ms, signal) => new Promise(res => { const t = setTimeout(res, ms); signal && signal.addEventListener("abort", () => { clearTimeout(t); res(); }, { once: true }); });

// One empty download: its round trip in ms (request time minus the server's time), with the response's headers
async function probe(signal) {
  const url = `${CF}/__down?bytes=0&measId=${uid()}`;
  const t = performance.now();
  const r = await fetch(url, { cache: "no-store", signal });
  await r.arrayBuffer();
  let ms = performance.now() - t;
  // the browser's own timing of the request, when it has it: not slowed by this page's script
  const e = performance.getEntriesByName(url).pop();
  if (e && e.duration > 0) ms = e.duration;
  performance.clearResourceTimings && performance.getEntriesByName(url).length > 200 && performance.clearResourceTimings();
  const st = r.headers.get("server-timing");
  return { ms: Math.max(0.1, ms - serverTime(st)), l4: l4(st), headers: r.headers };
}

// Idle latency: one request to open the connection (not counted), then `n` one after another
export async function ping({ n = 16, signal, onSample } = {}) {
  const first = await probe(signal);
  const out = [], tcp = [];
  for (let i = 0; i < n && !signal?.aborted; i++) {
    const p = await probe(signal);
    out.push(p.ms); if (p.l4 && p.l4.minRtt) tcp.push(p.l4.minRtt);
    onSample && onSample(p.ms, i + 1, n);
  }
  return { samples: out, meta: meta(k => first.headers.get(k)), proto: first.l4 ? first.l4.proto : "", tcpMin: tcp.length ? Math.min(...tcp) : null };
}

// Latency while the line is busy: an empty download every 400 ms until stopped
function underLoad(signal, out) {
  (async () => {
    await sleep(800, signal);
    while (!signal.aborted) {
      const t = performance.now();
      try { out.push((await probe(signal)).ms); } catch (e) { if (signal.aborted) return; }
      await sleep(Math.max(0, 400 - (performance.now() - t)), signal);
    }
  })();
}

// A transfer: `streams` workers each sending requests back to back, sampled every 100 ms, until it settles or `max`
// ms pass. send(size, add, signal) moves `size` bytes, calling add(n) as bytes go; resolves when the request ends.
async function transfer({ send, streams, hi, min, max, signal, onTick }) {
  const stop = new AbortController(), t0 = performance.now(), samples = [[0, 0]], loaded = [];
  const end = () => stop.abort();
  signal && signal.addEventListener("abort", end, { once: true });
  let got = 0, fails = 0;
  const add = n => { got += n; };
  const tick = setInterval(() => {
    samples.push([performance.now() - t0, got]);
    const ms = samples[samples.length - 1][0];
    onTick && onTick({ ms, mbps: rateNow(samples), bytes: got, samples });
    if (ms >= max || settled(samples, min)) end();
  }, 100);
  underLoad(stop.signal, loaded);
  const worker = async () => {
    while (!stop.signal.aborted) {
      const size = nextSize(rateNow(samples) * 1e6, streams, { hi });
      try { await send(size, add, stop.signal); fails = 0; } catch (e) {
        if (stop.signal.aborted) break;
        // three failures in a row with nothing moved: the endpoint can't be reached from here
        if (++fails >= 3 && got === 0) { end(); throw e; }
        await sleep(300, stop.signal);
      }
    }
  };
  try { await Promise.all(Array.from({ length: streams }, worker)); }
  finally { clearInterval(tick); end(); signal && signal.removeEventListener("abort", end); }
  samples.push([performance.now() - t0, got]);
  return { mbps: steady(samples), bytes: got, ms: samples[samples.length - 1][0], loaded, samples };
}

export function download({ streams = 4, min = 5000, max = 10000, signal, onTick } = {}) {
  const send = async (size, add, sig) => {
    const r = await fetch(`${CF}/__down?bytes=${size}&measId=${uid()}`, { cache: "no-store", signal: sig });
    if (!r.ok || !r.body) throw new Error("HTTP " + r.status);
    const rd = r.body.getReader();
    for (;;) { const { done, value } = await rd.read(); if (done) break; add(value.byteLength); }
  };
  return transfer({ send, streams, hi: 50e6, min, max, signal, onTick });
}

// Upload bodies: one random megabyte, repeated (random so nothing on the way can compress it)
let chunk = null;
function body(size) {
  if (!chunk) { chunk = new Uint8Array(1 << 20); for (let i = 0; i < chunk.length; i += 65536) crypto.getRandomValues(chunk.subarray(i, i + 65536)); }
  const parts = [];
  for (let n = size; n > 0; n -= chunk.length) parts.push(n >= chunk.length ? chunk : chunk.subarray(0, n));
  return new Blob(parts);
}

export function upload({ streams = 3, min = 5000, max = 10000, signal, onTick } = {}) {
  // XHR: fetch can't report upload progress. Bytes count as the browser hands them to the network.
  const send = (size, add, sig) => new Promise((res, rej) => {
    const x = new XMLHttpRequest();
    let sent = 0;
    x.upload.onprogress = e => { add(e.loaded - sent); sent = e.loaded; };
    x.onload = () => { add(size - sent); sent = size; x.status === 200 ? res() : rej(new Error("HTTP " + x.status)); };
    x.onerror = () => rej(new Error("network"));
    x.onabort = () => res();
    sig.addEventListener("abort", () => x.abort(), { once: true });
    x.open("POST", `${CF}/__up?measId=${uid()}`);
    x.send(body(size));
  });
  return transfer({ send, streams, hi: 25e6, min, max, signal, onTick });
}
