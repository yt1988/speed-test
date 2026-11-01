// A result in a link: /r/<code> (or /<lang>/r/<code>). The Worker reads the code to put the speeds in the link's
// preview title; the page reads it to show the result. Only the numbers go in it: no address and no network; the
// country and the Cloudflare data center only when the visitor ticks the box.
//
// Format 2:  2~<time, base 36 seconds>~<country or ->~<data center or ->~<down>~<up>~<idle>~<jitter>~<loaded down>~<loaded up>
//             ~<jitter, downloading>~<jitter, uploading>
//   speeds in hundredths of a Mbps, times in tenths of a ms, base 36; empty: not measured. The bufferbloat grade
//   comes from the latencies (src/verdict.mjs), so the link carries it without a field of its own.
// Format 1: the same without the two loaded jitters; old links keep working.

export const FORMAT = 2;
const KEYS1 = [["down", 100], ["up", 100], ["idle", 10], ["jit", 10], ["ldown", 10], ["lup", 10]];
const KEYS = [...KEYS1, ["jdown", 10], ["jup", 10]];
const n36 = (v, k) => v == null ? "" : Math.max(0, Math.round(v * k)).toString(36);
const p36 = (s, k) => s === "" || s == null ? null : /^[0-9a-z]{1,9}$/.test(s) ? parseInt(s, 36) / k : NaN;

// { ts, cc, colo, down, up, idle, jit, ldown, lup, jdown, jup } → code
export function encode(r) {
  return [FORMAT, Math.round(r.ts / 1000).toString(36), /^[A-Z]{2}$/.test(r.cc || "") ? r.cc : "-", /^[A-Z]{3}$/.test(r.colo || "") ? r.colo : "-",
    ...KEYS.map(([k, m]) => n36(r[k], m))].join("~");
}

// code → the result, or null when it isn't one this page can read
export function decode(code) {
  if (typeof code !== "string" || code.length > 200) return null;
  const p = code.split("~"), keys = { 1: KEYS1, 2: KEYS }[p[0]];
  if (!keys || p.length !== 4 + keys.length || !/^[0-9a-z]+$/.test(p[1])) return null;
  const r = { v: +p[0], ts: parseInt(p[1], 36) * 1000, cc: /^[A-Z]{2}$/.test(p[2]) ? p[2] : "", colo: /^[A-Z]{3}$/.test(p[3]) ? p[3] : "" };
  KEYS.forEach(([k, m], i) => { r[k] = i < keys.length ? p36(p[4 + i], m) : null; });
  if (KEYS.some(([k]) => Number.isNaN(r[k]))) return null;
  return r.down == null && r.up == null ? null : r;
}

// /r/<code> or /<lang folder>/r/<code> → { slug, code }, or null
export function sharePath(pathname) {
  const m = /^\/(?:([a-z]{2}(?:-[a-z]{2})?)\/)?r\/([0-9A-Za-z~._-]+)\/?$/.exec(pathname);
  return m ? { slug: m[1] || "", code: decodeURIComponent(m[2]) } : null;
}
