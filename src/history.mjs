// Past results, kept only in this browser (localStorage): newest first, at most MAX. Pure helpers, unit-tested; the
// page reads and writes the list.

export const MAX = 20;
// the evening peak, local time, when lines are busiest (as in the me2cloud tool)
export const PEAK = [20, 23];
export const isPeak = d => d.getHours() >= PEAK[0] && d.getHours() < PEAK[1];

const num = v => typeof v === "number" && isFinite(v) ? v : null;
// a stored list → only well-formed records (an old or hand-edited one can't break the page)
export function parse(text) {
  let a;
  try { a = JSON.parse(text || "[]"); } catch (e) { return []; }
  if (!Array.isArray(a)) return [];
  return a.filter(r => r && typeof r.ts === "number" && (num(r.down) != null || num(r.up) != null)).slice(0, MAX).map(r => ({
    ts: r.ts, down: num(r.down), up: num(r.up), idle: num(r.idle), jit: num(r.jit), ldown: num(r.ldown), lup: num(r.lup), jdown: num(r.jdown), jup: num(r.jup),
    ip: typeof r.ip === "string" ? r.ip.slice(0, 64) : "", cc: /^[A-Z]{2}$/.test(r.cc || "") ? r.cc : "", org: typeof r.org === "string" ? r.org.slice(0, 80) : "", peak: !!r.peak,
  }));
}
export const add = (list, rec) => [rec, ...list].slice(0, MAX);

// the change from the last result, as a whole percentage (null when either is missing or zero)
export const change = (now, before) => now == null || !before ? null : Math.round((now - before) / before * 100);
