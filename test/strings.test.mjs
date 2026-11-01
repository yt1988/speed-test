// Every string the page shows comes from the language files, in every language: a missing key would show its name
// (or, worse, English) instead.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LANGS } from "../scripts/build.mjs";
import { USES } from "../src/verdict.mjs";

const read = f => readFile(new URL("../" + f, import.meta.url), "utf8");
const all = (s, re) => [...s.matchAll(re)].map(m => m[1]);

test("every key the page uses exists in every language", async () => {
  const [app, page, build, worker] = await Promise.all(["src/app.js", "src/page.html", "scripts/build.mjs", "src/worker.js"].map(read));
  const keys = new Set([
    ...all(app, /\bt\("(\w+)"/g), ...all(build, /\bT\("(\w+)"/g), ...all(worker, /\bS\.(\w+)/g),
    ...all(page, /data-i="(\w+)"/g), ...all(page, /\{\{a:(\w+)\}\}/g), ...all(page, /\{\{(k_\w+)\}\}/g),
    ...["system", "light", "dark"].map(x => "th_" + x), ...USES.map(k => "u_" + k), ...["good", "ok", "poor"].map(x => "lv_" + x),
    ...["low", "mid", "high"].map(x => "bloat_" + x), ...["chk", "good", "warn", "unk"].map(x => "st_" + x), "start", "stop", "again", "r_ml", "r_split", "r_tcp", "r_mldc", "ml_peeking", "ml_fail", "k_idle", "k_jit", "k_ldown", "k_lup",
  ].filter(k => !k.endsWith("_")));
  assert.ok(keys.size > 60, "found " + keys.size + " keys");
  for (const [lang] of LANGS) {
    const d = (await import(`../src/i18n/${lang}.mjs`)).default;
    const missing = [...keys].filter(k => !(k in d));
    assert.deepEqual(missing, [], `${lang} lacks ${missing.join(", ")}`);
  }
});

test("every language has every string, with the same placeholders", async () => {
  const en = (await import("../src/i18n/en.mjs")).default;
  const vars = s => (s.match(/\{\w+\}/g) || []).sort().filter((x, i, a) => a.indexOf(x) === i).join();
  for (const [lang] of LANGS) {
    const d = (await import(`../src/i18n/${lang}.mjs`)).default;
    for (const k of Object.keys(en)) assert.ok(k in d, `${lang}: ${k}`);
    for (const k of Object.keys(d)) assert.ok(k in en, `${lang}: ${k} is not in en`);
    assert.equal(d.docs.length, en.docs.length, lang + ": help entries");
    for (const k of Object.keys(en)) if (typeof en[k] === "string") assert.equal(vars(d[k]), vars(en[k]), `${lang}: ${k} placeholders`);
  }
});

test("no English fallback in the page script or the build", async () => {
  const [app, build] = await Promise.all(["src/app.js", "scripts/build.mjs"].map(read));
  for (const [name, s] of [["src/app.js", app], ["scripts/build.mjs", build]]) {
    assert.ok(!/\|\|\s*\w+(\.name)?\.en\b|\?\?\s*en\[/.test(s), name + " falls back to English");
  }
});

test("lists come from $$, never $ (which returns one element)", async () => {
  const app = await read("src/app.js");
  const bad = app.split("\n").filter(l => /(^|[^$])\$\([^)]*\)\.(forEach|map|filter)\(/.test(l));
  assert.deepEqual(bad, []);
});
