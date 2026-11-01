// Statistics, header parsing, the request-size schedule, what the line is good for, shared links and the direct rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quantile, median, jitter, mbps, serverTime, l4, meta, nextSize, rateNow, steady, settled } from "../src/measure.mjs";
import { fromServer, site } from "../src/mlab.mjs";
import { uses, bloat, bloatLevel, fmtMbps, fmtMs, speedTier } from "../src/verdict.mjs";
import { encode, decode, sharePath } from "../src/share.mjs";
import { items, ruleSets, inline, remote, FORMATS } from "../src/rules.mjs";

test("statistics", () => {
  assert.equal(quantile([3, 1, 2], .5), 2);
  assert.equal(median([10, 20, 30, 40]), 25);
  assert.equal(median([]), null);
  assert.equal(jitter([10, 14, 10, 12]), (4 + 4 + 2) / 3);
  assert.equal(jitter([10]), null);
  assert.equal(mbps(12.5e6, 1000), 100);
});

test("Server-Timing: the Worker's time, and the kernel's round trip", () => {
  const h = 'cfSpeedEdge;dur=3, cfSpeedWorker;dur=16, cfL4;desc="?proto=TCP&rtt=196594&min_rtt=192364&rtt_var=13003&sent=11"';
  assert.equal(serverTime(h), 16);
  assert.equal(serverTime("cfRequestDuration;dur=7.5"), 7.5);
  assert.equal(serverTime(null), 0);
  assert.deepEqual(l4(h), { proto: "TCP", rtt: 196.594, minRtt: 192.364 });
  assert.equal(l4("cfSpeedEdge;dur=3"), null);
  const H = { "cf-meta-colo": "HKG", "cf-meta-ip": "1.2.3.4" };
  assert.deepEqual(meta(k => H[k] || null), { colo: "HKG", asn: "", country: "", city: "", ip: "1.2.3.4" });
});

test("request sizes grow with the speed, within bounds, in 64 KB steps", () => {
  assert.equal(nextSize(0, 4), 262144);
  assert.equal(nextSize(1e6, 4), 262144, "slow line: the smallest");
  const s = nextSize(400e6, 4);            // 400 Mbps, 4 streams, 1.2 s each: 15 MB
  assert.ok(s > 14e6 && s < 16e6, s);
  assert.equal(s % 65536, 0);
  assert.equal(nextSize(10e9, 1, { hi: 25e6 }), Math.round(25e6 / 65536) * 65536);
});

test("speed now, steady speed, and when it has settled", () => {
  // 100 Mbps (12.5 MB/s) after a slow first second
  const s = [[0, 0]];
  for (let t = 100; t <= 8000; t += 100) s.push([t, t <= 1000 ? t * 2500 : 2.5e6 + (t - 1000) * 12500]);
  assert.ok(Math.abs(rateNow(s) - 100) < .01, rateNow(s));
  assert.ok(Math.abs(steady(s) - 100) < .5, "after the ramp-up: " + steady(s));
  assert.ok(settled(s));
  assert.ok(!settled(s.slice(0, 30)), "not before 5 s");
  // still climbing: not settled
  const c = [[0, 0]];
  let b = 0;
  for (let t = 100; t <= 8000; t += 100) { b += t * 30; c.push([t, b]); }
  assert.ok(!settled(c));
  assert.equal(rateNow([[0, 0]]), 0);
  assert.equal(steady([[0, 0]]), 0);
});

test("M-Lab server measurements", () => {
  assert.deepEqual(fromServer({ AppInfo: { NumBytes: 125e6, ElapsedTime: 10e6 }, TCPInfo: { MinRTT: 42000 } }, "down"), { mbps: 100, minRtt: 42 });
  assert.deepEqual(fromServer({ TCPInfo: { BytesReceived: 25e6, ElapsedTime: 10e6 } }, "up"), { mbps: 20 });
  assert.deepEqual(fromServer({}, "down"), {});
  assert.equal(site("ndt-hnd63770-db645cea.ipacyberlab.autojoin.measurement-lab.org"), "HND");
  assert.equal(site("mlab1-sin01.mlab-oti.measurement-lab.org"), "SIN");
  assert.equal(site(""), "");
});

test("what the line is good for", () => {
  const fast = { down: 500, up: 100, idle: 8, jit: 1, ldown: 20, lup: 25 };
  assert.deepEqual(Object.values(uses(fast)), ["good", "good", "good", "good", "good"]);
  assert.equal(bloat(fast), 17); assert.equal(bloatLevel(17), "low");
  const far = { down: 30, up: 4, idle: 190, jit: 12, ldown: 400, lup: 230 };
  const u = uses(far);
  assert.equal(u.video, "good"); assert.equal(u.call, "ok"); assert.equal(u.game, "poor"); assert.equal(u.cloud, "poor"); assert.equal(u.live, "poor");
  assert.equal(bloatLevel(bloat(far)), "high");
  assert.deepEqual(Object.values(uses({})), ["", "", "", "", ""], "nothing measured yet");
  assert.equal(uses({ down: 50 }).game, "", "game needs the latencies");
});

test("numbers as shown", () => {
  assert.equal(fmtMbps(4.567), "4.57"); assert.equal(fmtMbps(45.67), "45.7"); assert.equal(fmtMbps(456.7), "457"); assert.equal(fmtMbps(null), "–");
  assert.equal(fmtMs(3.14), "3.1"); assert.equal(fmtMs(38.6), "39");
  assert.equal(speedTier(1000), "t1"); assert.equal(speedTier(5), "t5");
});

test("a shared result survives the link; other formats refused", () => {
  const r = { ts: 1793500000000, cc: "CN", colo: "HKG", down: 287.43, up: 41.25, idle: 38.2, jit: 3.1, ldown: 96.4, lup: null };
  const code = encode(r);
  assert.match(code, /^1~[0-9a-z]+~CN~HKG~/);
  assert.match(code, /^[0-9A-Za-z~._-]+$/, "path-safe");
  const back = decode(code);
  assert.deepEqual({ ...back, v: undefined }, { ...r, v: undefined });
  assert.deepEqual(decode(encode({ ...r, cc: "", colo: "" })).cc, "");
  assert.equal(decode("2~x~-~-~1~1~1~1~1~1"), null, "a later format");
  assert.equal(decode("1~x~-~-~zz!~1~1~1~1~1"), null, "garbage");
  assert.equal(decode("1~x~-~-~~~~~~"), null, "no speeds");
  assert.deepEqual(sharePath("/zh-cn/r/" + code), { slug: "zh-cn", code });
  assert.deepEqual(sharePath("/r/" + code), { slug: "", code });
  assert.equal(sharePath("/zh-cn/"), null);
});

test("direct rules name the test's hosts and M-Lab's domain, nothing broader", () => {
  const it = items();
  assert.deepEqual(it.map(i => i.d || "*." + i.s), ["speed.cloudflare.com", "locate.measurementlab.net", "*.measurement-lab.org"]);
  const sets = ruleSets("https://speed.1ms.dog");
  assert.ok(sets["clash.yaml"].includes("  - DOMAIN,speed.cloudflare.com\n"));
  assert.ok(sets["clash.yaml"].includes("  - DOMAIN-SUFFIX,measurement-lab.org\n"));
  assert.ok(sets["quanx.list"].includes("host-suffix, measurement-lab.org, direct"));
  assert.ok(!/DOMAIN-KEYWORD|DOMAIN-SUFFIX,[\w.]*cloudflare|host-suffix, [\w.]*cloudflare/i.test(Object.values(sets).join("")), "never all of Cloudflare");
  assert.deepEqual(JSON.parse(sets["singbox.json"]).rules[0], { domain: ["speed.cloudflare.com", "locate.measurementlab.net"], domain_suffix: ["measurement-lab.org"] });
  for (const f of FORMATS) assert.ok(inline(f, { top: "t" }).includes("speed.cloudflare.com"), f);
  assert.ok(JSON.parse(inline("xray", { top: "t" })).routing.rules[0].domain.includes("domain:measurement-lab.org"));
  assert.equal(remote("xray", "x", { top: "t" }), null);
  assert.ok(remote("clash", "https://speed.1ms.dog", { top: "t" }).includes("https://speed.1ms.dog/rules/clash.yaml"));
});
