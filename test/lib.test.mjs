// Statistics, header parsing, the request-size schedule, what the line is good for, shared links and the direct rules.
import { test } from "node:test";
import assert from "node:assert/strict";
import { quantile, median, jitter, mbps, serverTime, l4, meta, nextSize, rateNow, steady, settled } from "../src/measure.mjs";
import { fromMeta, fromMe, fromTrace, reasons } from "../src/net.mjs";
import worker from "../src/worker.js";
import { uses, bloat, grade, gradeKey, gradeTier, fmtMbps, fmtMs, speedTier } from "../src/verdict.mjs";
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

test("the exit, and signs it isn't the visitor's own line", () => {
  const e = fromMeta({ clientIp: "114.254.73.157", asn: 4808, asOrganization: "China Unicom Beijing province network", country: "CN", city: "Beijing",
    colo: { iata: "HKG", city: "Hong Kong", cca2: "HK" } });
  assert.deepEqual(e, { ip: "114.254.73.157", cc: "CN", city: "Beijing", asn: 4808, org: "China Unicom Beijing province network", colo: "HKG", coloCity: "Hong Kong", coloCc: "HK", http: "" });
  assert.equal(fromMeta({}), null);
  assert.deepEqual(fromMe({ ip: "1.2.3.4", family: 4, country: "JP", city: "Tokyo", asn: 2516, org: "KDDI", colo: "NRT", http: "HTTP/2", region: null }),
    { ip: "1.2.3.4", cc: "JP", city: "Tokyo", asn: 2516, org: "KDDI", colo: "NRT", coloCity: "", coloCc: "", http: "HTTP/2" });
  assert.equal(fromMe(null), null);
  assert.deepEqual(fromTrace("fl=1\nip=1.2.3.4\nloc=XX\ncolo=NRT\n"), { ip: "1.2.3.4", cc: "", city: "", asn: null, org: "", colo: "NRT", coloCity: "", coloCc: "", http: "" });
  assert.deepEqual(reasons(e, { tz: "Asia/Shanghai" }), [], "home line in China");
  assert.deepEqual(reasons({ ...e, cc: "HK" }, { tz: "Asia/Shanghai" }), [], "Hong Kong counts as China's");
  assert.deepEqual(reasons({ ...e, cc: "JP", org: "Vultr Holdings LLC", asn: 20473 }, { tz: "Asia/Shanghai" }).map(r => r.k), ["r_tz", "r_dc"]);
  assert.deepEqual(reasons(null), []);
});

test("what the line is good for", () => {
  const fast = { down: 500, up: 100, idle: 8, jit: 1, ldown: 20, lup: 25 };
  assert.deepEqual(Object.values(uses(fast)), ["good", "good", "good", "good", "good"]);
  assert.equal(bloat(fast), 17); assert.equal(grade(fast), "A");
  const far = { down: 30, up: 4, idle: 190, jit: 12, ldown: 400, lup: 230 };
  const u = uses(far);
  assert.equal(u.video, "good"); assert.equal(u.call, "ok"); assert.equal(u.game, "poor"); assert.equal(u.cloud, "poor"); assert.equal(u.live, "poor");
  assert.equal(grade(far), "D", "+210 ms");
  assert.deepEqual(Object.values(uses({})), ["", "", "", "", ""], "nothing measured yet");
  assert.equal(uses({ down: 50 }).game, "", "game needs the latencies");
});

test("bufferbloat grade: Waveform's thresholds on the worse direction's rise", () => {
  const at = (ldown, lup = null) => grade({ idle: 20, ldown, lup });
  assert.equal(at(24.9), "A+"); assert.equal(at(25), "A");
  assert.equal(at(49.9), "A"); assert.equal(at(50), "B");
  assert.equal(at(79.9), "B"); assert.equal(at(80), "C");
  assert.equal(at(219.9), "C"); assert.equal(at(220), "D");
  assert.equal(at(419.9), "D"); assert.equal(at(420), "F");
  assert.equal(at(22, 300), "D", "upload worse than download");
  assert.equal(at(10), "A+", "lower than idle counts as no rise");
  assert.equal(grade({ idle: 20 }), "", "nothing under load yet");
  assert.equal(grade({}), "");
  assert.deepEqual(["A+", "A", "B", "C", "D", "F"].map(gradeKey), ["ap", "a", "b", "c", "d", "f"]);
  assert.deepEqual(["A+", "A", "B", "C", "D", "F", ""].map(gradeTier), ["t1", "t1", "t2", "t3", "t4", "t5", ""]);
});

test("numbers as shown", () => {
  assert.equal(fmtMbps(4.567), "4.57"); assert.equal(fmtMbps(45.67), "45.7"); assert.equal(fmtMbps(456.7), "457"); assert.equal(fmtMbps(null), "–");
  assert.equal(fmtMs(3.14), "3.1"); assert.equal(fmtMs(38.6), "39");
  assert.equal(speedTier(1000), "t1"); assert.equal(speedTier(5), "t5");
});

test("a shared result survives the link; other formats refused", () => {
  const r = { ts: 1793500000000, cc: "CN", colo: "HKG", down: 287.43, up: 41.25, idle: 38.2, jit: 3.1, ldown: 96.4, lup: null, jdown: 12.3, jup: null };
  const code = encode(r);
  assert.match(code, /^2~[0-9a-z]+~CN~HKG~/);
  assert.match(code, /^[0-9A-Za-z~._-]+$/, "path-safe");
  const back = decode(code);
  assert.deepEqual({ ...back, v: undefined }, { ...r, v: undefined });
  assert.deepEqual(decode(encode({ ...r, cc: "", colo: "" })).cc, "");
  assert.equal(grade(back), "B", "the grade comes back with the latencies");
  // format 1 links (before the loaded jitters) still read
  const old = decode("1~t3pdkw~CN~HKG~2n9n~11a1~ei~v~2nw~");
  assert.equal(old.v, 1); assert.equal(old.down, 1234.67); assert.equal(old.ldown, 345.2); assert.equal(old.jdown, null);
  assert.equal(decode("3~x~-~-~1~1~1~1~1~1~1~1"), null, "a later format");
  assert.equal(decode("1~x~-~-~1~1~1~1~1~1~1~1"), null, "format 1 with too many fields");
  assert.equal(decode("1~x~-~-~zz!~1~1~1~1~1"), null, "garbage");
  assert.equal(decode("1~x~-~-~~~~~~"), null, "no speeds");
  assert.deepEqual(sharePath("/zh-cn/r/" + code), { slug: "zh-cn", code });
  assert.deepEqual(sharePath("/r/" + code), { slug: "", code });
  assert.equal(sharePath("/zh-cn/"), null);
});

test("direct rules name the test's host, nothing broader", () => {
  const it = items();
  assert.deepEqual(it.map(i => i.d), ["speed.cloudflare.com"]);
  const sets = ruleSets("https://speed.1ms.dog");
  assert.ok(sets["clash.yaml"].includes("  - DOMAIN,speed.cloudflare.com\n"));
  assert.ok(sets["quanx.list"].includes("host, speed.cloudflare.com, direct"));
  assert.ok(!/DOMAIN-KEYWORD|DOMAIN-SUFFIX|host-suffix/i.test(Object.values(sets).join("")), "never all of Cloudflare");
  assert.deepEqual(JSON.parse(sets["singbox.json"]).rules[0], { domain: ["speed.cloudflare.com"], domain_suffix: [] });
  for (const f of FORMATS) assert.ok(inline(f, { top: "t" }).includes("speed.cloudflare.com"), f);
  assert.deepEqual(JSON.parse(inline("xray", { top: "t" })).routing.rules[0].domain, ["full:speed.cloudflare.com"]);
  assert.equal(remote("xray", "x", { top: "t" }), null);
  assert.ok(remote("clash", "https://speed.1ms.dog", { top: "t" }).includes("https://speed.1ms.dog/rules/clash.yaml"));
});
test("history: only well-formed records, newest first, at most 20; change and evening peak", async () => {
  const { parse, add, change, isPeak, MAX } = await import("../src/history.mjs");
  assert.deepEqual(parse("not json"), []);
  assert.deepEqual(parse('{"a":1}'), []);
  const r = { ts: 1, down: 100, up: 20, idle: 9, jit: 1, ldown: 20, lup: 30, jdown: 2, jup: 3, ip: "1.2.3.4", cc: "CN", org: "X", peak: true };
  assert.deepEqual(parse(JSON.stringify([r, { ts: "x" }, { ts: 2 }, { ...r, cc: "bad", down: "9" }])), [r, { ...r, cc: "", down: null }]);
  let h = [];
  for (let i = 0; i < 25; i++) h = add(h, { ...r, ts: i });
  assert.equal(h.length, MAX); assert.equal(h[0].ts, 24);
  assert.equal(change(110, 100), 10); assert.equal(change(90, 100), -10); assert.equal(change(5, 0), null); assert.equal(change(null, 5), null);
  assert.ok(isPeak(new Date(2026, 10, 1, 21))); assert.ok(!isPeak(new Date(2026, 10, 1, 23)));
});


test("a result link whose code can't be read is a 404, not a redirect", async () => {
  const env = { ASSETS: { fetch: () => { throw new Error("not reached"); } } };
  for (const p of ["/r/zz", "/zh-cn/r/zz", "/r/2~x"]) assert.equal((await worker.fetch(new Request("https://speed.1ms.dog" + p), env)).status, 404, p);
});
