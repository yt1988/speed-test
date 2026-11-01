#!/usr/bin/env node
// Checks that the endpoints the page relies on still behave as it expects, with tiny requests only (no speed test):
//   Cloudflare  GET /__down?bytes=0 and POST /__up (1 KB): 200, CORS open to any origin, Server-Timing readable with
//               the Worker's time, cf-meta-ip exposed; the upload's preflight allowed; /meta (the exit shown on load)
// Exit 1 on any failure. Run by hand and weekly from GitHub Actions (.github/workflows/verify.yml).
import { CF, serverTime } from "../src/measure.mjs";

const ORIGIN = "https://speed.1ms.dog";
let bad = 0;
const check = (ok, what) => { console.log((ok ? "ok    " : "FAIL  ") + what); if (!ok) bad++; };
const exposed = r => (r.headers.get("access-control-expose-headers") || "").toLowerCase();

try {
  const r = await fetch(`${CF}/__down?bytes=0`, { headers: { origin: ORIGIN } });
  await r.arrayBuffer();
  check(r.status === 200, `GET ${CF}/__down?bytes=0 → ${r.status}`);
  check(r.headers.get("access-control-allow-origin") === "*", "  download: Access-Control-Allow-Origin *");
  check(/server-timing/.test(exposed(r)), "  download: Server-Timing exposed");
  check(serverTime(r.headers.get("server-timing")) > 0 && /cfSpeedWorker/.test(r.headers.get("server-timing")), "  download: Server-Timing carries cfSpeedWorker");
  check(/cf-meta-ip/.test(exposed(r)), "  download: cf-meta-ip exposed");

  const big = await fetch(`${CF}/__down?bytes=65536`, { headers: { origin: ORIGIN } });
  check(big.status === 200 && (await big.arrayBuffer()).byteLength === 65536, "  download: bytes=65536 gives 65536 bytes");

  const pre = await fetch(`${CF}/__up`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "POST" } });
  check(pre.status < 300 && /POST/.test(pre.headers.get("access-control-allow-methods") || "") && pre.headers.get("access-control-allow-origin") === "*", `OPTIONS ${CF}/__up → ${pre.status}, POST allowed`);
  const up = await fetch(`${CF}/__up`, { method: "POST", headers: { origin: ORIGIN }, body: new Uint8Array(1024) });
  await up.arrayBuffer();
  check(up.status === 200 && up.headers.get("access-control-allow-origin") === "*", `POST ${CF}/__up (1 KB) → ${up.status}`);
} catch (e) { check(false, "Cloudflare: " + e.message); }

// the exit shown before any test: /meta answers a cross-origin request that carries the page's origin as referrer
try {
  const r = await fetch(`${CF}/meta`, { headers: { origin: ORIGIN, referer: ORIGIN + "/" } });
  const j = r.ok ? await r.json() : {};
  check(r.status === 200 && r.headers.get("access-control-allow-origin") === "*" && !!j.clientIp && !!(j.colo && j.colo.iata), `GET ${CF}/meta → ${r.status}, address and data center`);
} catch (e) { check(false, "Cloudflare /meta: " + e.message); }

if (bad) { console.error(`\n${bad} check(s) failed`); process.exit(1); }
console.log("\nall good");
