#!/usr/bin/env node
// Renders the link-preview images with resvg (dev dependency), 1200 × 630: public/og/<lang>.png for each language.
// Run when the headline or the subtitle change, and commit the output. Uses system fonts for the text (Windows:
// Segoe UI, Microsoft YaHei, Microsoft JhengHei, Yu Gothic UI, Malgun Gothic, Consolas), as the other 1ms.dog tools do.
// Usage: node scripts/assets.mjs
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { Resvg } from "@resvg/resvg-js";

const pub = new URL("../public/", import.meta.url), src = new URL("../src/", import.meta.url);
const HOST = new URL(process.env.SITE_URL || "https://speed.1ms.dog").host;
const FONTS = { "zh-CN": "Microsoft YaHei", "zh-TW": "Microsoft JhengHei", ja: "Yu Gothic UI", ko: "Malgun Gothic" };
const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const b64 = async f => Buffer.from(await readFile(new URL(f, pub))).toString("base64");
const render = svg => new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true, defaultFontFamily: "Segoe UI" } }).render().asPng();
const INK = "#818cf8", UP = "#2dd4bf";

// a speed curve as the page draws it: ramp up, then steady with a little noise
function curve(x0, x1, y0, h, level, seed) {
  const pts = [];
  for (let i = 0; i <= 40; i++) {
    const f = i / 40, ramp = Math.min(1, f * 4), noise = Math.sin(i * 1.7 + seed) * .04 + Math.sin(i * .6 + seed * 2) * .03;
    pts.push([x0 + (x1 - x0) * f, y0 + h - h * level * ramp * (1 + noise * ramp)]);
  }
  const line = pts.map((p, i) => (i ? "L" : "M") + p[0].toFixed(1) + " " + p[1].toFixed(1)).join("");
  return { line, area: line + `L${x1} ${y0 + h}L${x0} ${y0 + h}Z` };
}

async function card(lang, d) {
  const ff = `${FONTS[lang] ? `'${FONTS[lang]}', ` : ""}'Segoe UI', 'Microsoft YaHei', sans-serif`;
  const logo = await b64("assets/logo-dark.svg");
  // headline and subtitle fit the left column (500 px): wrapped by estimated width, wide characters counting double
  const wide = ch => /[　-鿿가-힯＀-￯]/.test(ch), est = (t, px) => [...t].reduce((a, ch) => a + (wide(ch) ? 1 : .56) * px, 0);
  const wrap = (text, px) => {
    const out = [];
    let cur = "";
    for (const word of text.split(/(?<=[ ，、？?,])/)) {
      for (const piece of est(word, px) > 500 ? [...word] : [word]) {
        if (cur && est(cur + piece, px) > 500) { out.push(cur.trim()); cur = ""; }
        cur += piece;
      }
    }
    return [...out, cur.trim()];
  };
  let size = 58, lines;
  for (; (lines = wrap(d.h1, size)).length > 2 && size > 42; size -= 4);
  const subs = wrap(d.og_sub, 26).slice(0, 2);
  const top = 214 - (subs.length - 1) * 18 + (lines.length > 1 ? 0 : 26);
  const head = lines.map((l, i) => `<text x="72" y="${top + i * (size + 12)}" font-size="${size}" font-weight="700" fill="#ededed">${esc(l)}</text>`).join("");
  const subY = top + (lines.length - 1) * (size + 12) + 58;
  const subText = subs.map((l, i) => `<text x="72" y="${subY + i * 36}" font-size="26" fill="#a0a0a0">${esc(l)}</text>`).join("");
  const barY = subY + (subs.length - 1) * 36 + 42;
  // the panel: the two speeds, their curves, and the latencies, as the page shows a result
  const dn = curve(632, 880, 352, 70, .9, 1), up = curve(888, 1136, 352, 70, .55, 4);
  const big = (x, label, val, c) => `<text x="${x}" y="214" font-size="22" font-weight="600" fill="${c}">${esc(label)}</text>` +
    `<text x="${x}" y="296" font-size="76" font-weight="700" font-family="Consolas, monospace" fill="#ededed">${val}</text>` +
    `<text x="${x}" y="330" font-size="20" fill="#a0a0a0">Mbps</text>`;
  const lat = [[d.k_idle, "12", "#3ecf8e"], [d.k_jit, "1.4", "#3ecf8e"], [d.k_ldown, "31", "#9fd356"]].map(([k, v, c], i) =>
    `<text x="${640 + i * 168}" y="468" font-size="18" fill="#a0a0a0">${esc(k.length > 14 ? k.slice(0, 13) + "…" : k)}</text>` +
    `<text x="${640 + i * 168}" y="500" font-size="28" font-weight="600" font-family="Consolas, monospace" fill="${c}">${v} ms</text>`).join("");
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630" font-family="${ff}">
<rect width="1200" height="630" fill="#1c1c1c"/>
<rect x="600" y="150" width="568" height="384" rx="20" fill="#232323" stroke="#363636"/>
<image x="72" y="56" width="180" height="72" href="data:image/svg+xml;base64,${logo}"/>
${head}
${subText}
<rect x="72" y="${barY}" width="120" height="6" rx="3" fill="${INK}"/>
${big(640, "↓ " + d.k_down, "487", INK)}${big(900, "↑ " + d.k_up, "52.6", UP)}
<path d="${dn.area}" fill="${INK}" opacity=".16"/><path d="${dn.line}" fill="none" stroke="${INK}" stroke-width="2.4"/>
<path d="${up.area}" fill="${UP}" opacity=".16"/><path d="${up.line}" fill="none" stroke="${UP}" stroke-width="2.4"/>
<rect x="632" y="422" width="504" height="1" fill="#363636"/>
${lat}
<text x="72" y="574" font-size="26" font-weight="600" fill="${INK}">${HOST}</text>
<text x="1128" y="574" font-size="22" fill="#a0a0a0" text-anchor="end">↓ ↑ · ping · jitter · bufferbloat</text>
</svg>`;
}

await mkdir(new URL("og/", pub), { recursive: true });
for (const f of (await readdir(new URL("i18n/", src))).filter(f => f.endsWith(".mjs"))) {
  const lang = f.slice(0, -4), d = (await import(new URL("i18n/" + f, src).href)).default;
  const png = render(await card(lang, d));
  await writeFile(new URL(`og/${lang.toLowerCase()}.png`, pub), png);
  console.log(`og/${lang.toLowerCase()}.png ${Math.round(png.length / 1024)} KB`);
}
