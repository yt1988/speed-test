// What the numbers mean: color tiers, the latency added under load, and what the line is good for. Pure, unit-tested;
// the page, the share card and the Worker's preview titles all use it.

// a speed as the page shows it: two decimals below 10, one below 100, then whole numbers
export const fmtMbps = v => v == null ? "–" : v < 10 ? v.toFixed(2) : v < 100 ? v.toFixed(1) : String(Math.round(v));
export const fmtMs = ms => ms == null ? "–" : ms < 10 ? ms.toFixed(1) : String(Math.round(ms));

// t1 (best) … t5 (worst)
export const speedTier = v => v == null ? "" : v >= 300 ? "t1" : v >= 100 ? "t2" : v >= 30 ? "t3" : v >= 10 ? "t4" : "t5";
export const msTier = ms => ms == null ? "" : ms <= 20 ? "t1" : ms <= 50 ? "t2" : ms <= 100 ? "t3" : ms <= 200 ? "t4" : "t5";

// Latency added when the line is busy (bufferbloat): the worse of download and upload, over the idle latency
export function bloat(r) {
  const l = [r.ldown, r.lup].filter(v => v != null);
  return r.idle == null || !l.length ? null : Math.max(0, Math.max(...l) - r.idle);
}
export const bloatLevel = b => b == null ? "" : b <= 30 ? "low" : b <= 100 ? "mid" : "high";

// What it's good for, each "good", "ok" or "poor" ("" while a number it needs is missing).
// r: { down, up (Mbps), idle, jit, ldown, lup (ms) }
export const USES = ["video", "call", "game", "cloud", "live"];
export function uses(r) {
  const b = bloat(r), has = (...k) => k.every(x => r[x] != null);
  const lvl = (good, ok) => good ? "good" : ok ? "ok" : "poor";
  return {
    // 4K streams need about 25 Mbps, HD about 5
    video: has("down") ? lvl(r.down >= 25, r.down >= 5) : "",
    call: has("down", "up", "idle", "jit") ? lvl(r.down >= 3 && r.up >= 3 && r.idle <= 80 && r.jit <= 20, r.down >= 1.5 && r.up >= 1 && r.idle <= 200 && r.jit <= 50) : "",
    game: has("idle", "jit") && b != null ? lvl(r.idle <= 40 && r.jit <= 10 && b <= 30, r.idle <= 100 && r.jit <= 30 && b <= 100) : "",
    cloud: has("down", "idle", "jit") ? lvl(r.down >= 35 && r.idle <= 40 && r.jit <= 10, r.down >= 15 && r.idle <= 80 && r.jit <= 20) : "",
    // live streaming, video calls in HD, big uploads
    live: has("up") ? lvl(r.up >= 20, r.up >= 5) : "",
  };
}
