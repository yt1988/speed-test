// The built pages keep the 1ms.dog tool contract (1ms-shell docs/tool-contract.md) and draw every slot up front.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { LANGS, ORIGINS } from "../scripts/build.mjs";
import { USES } from "../src/verdict.mjs";

const page = slug => readFile(new URL(`../public/${slug ? slug + "/" : ""}index.html`, import.meta.url), "utf8");

test("every language page keeps the shell contract", async () => {
  for (const [lang, slug] of LANGS) {
    const h = await page(slug);
    assert.match(h, new RegExp(`<html lang="${lang}"`), lang);
    assert.match(h, /<head>\r?\n<meta charset="utf-8">\r?\n<script>/, lang + ": charset first, then the pre-paint script");
    assert.match(h, /id="helpBtn"[^>]*aria-haspopup="dialog"/, lang + ": help button");
    assert.match(h, /<div class="scrim" id="help" hidden>/, lang + ": help dialog hidden by default");
    assert.match(h, /class="logo-light" src="\/assets\/logo-light.svg" width="90" height="36"/);
    assert.ok(!/\{\{[\w:]+\}\}/.test(h), lang + ": unfilled placeholder");
    assert.ok(h.length < 60000, lang + ": page is " + h.length + " bytes");
    assert.equal((h.match(/<script>/g) || []).length, 1, lang + ": the only inline script is the pre-paint one");
    assert.equal((h.match(/<div data-ms-more><\/div>/g) || []).length, 1, lang + ": one place for the shell's tool list");
    assert.ok(h.indexOf("data-ms-more") < h.indexOf('class="scrim"'), lang + ": tool list before the dialogs");
    const order = ["id=\"lang\"", "id=\"helpBtn\"", "class=\"icon-btn gh\"", "id=\"theme\""].map(s => h.indexOf(s));
    assert.deepEqual([...order].sort((a, b) => a - b), order, lang + ": header button order");
    assert.match(h, /<link rel="canonical" href="https:\/\/speed\.1ms\.dog\//, lang + ": canonical");
    assert.match(h, /hreflang="x-default"/, lang);
    assert.match(h, /"@type":"FAQPage"/, lang + ": FAQ structured data");
    assert.match(h, /<meta property="og:image" content="https:\/\/speed\.1ms\.dog\/og\/[a-z-]+\.png">/, lang);
    assert.ok(!/manifest|serviceWorker/.test(h), lang + ": no manifest or service worker of our own");
  }
});

test("the hero's slots are there before the test", async () => {
  const h = await page("");
  for (const k of USES) assert.match(h, new RegExp(`<li data-u="${k}" data-lv="">`), k);
  for (const k of ["idle", "jit", "ldown", "lup"]) assert.match(h, new RegExp(`data-l="${k}"`), k);
  assert.match(h, /id="go"/); assert.match(h, /id="auto"/);
  assert.ok(!/id="auto" checked/.test(h), "waits for Start by default");
});

test("the CSP lets the page reach every test host", async () => {
  const hd = await readFile(new URL("../public/_headers", import.meta.url), "utf8");
  for (const o of ORIGINS) assert.ok(hd.includes(" " + o), o);
});
