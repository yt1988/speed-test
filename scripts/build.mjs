#!/usr/bin/env node
// Builds the static site in public/ from src/:
//   index.html, <lang>/index.html              the page per language
//   assets/app.<hash>.js, assets/app.<hash>.css the page's code and styles, shared by every language
//   assets/l.<lang>.<hash>.js                    the strings the browser code needs, per language
//   assets/qr.<hash>.js                          QR encoder for the share card, loaded only when someone shares
//   og/<lang>.png                                link preview images: made by scripts/assets.mjs, committed, not here
//   rules/*                                     direct rules for proxy tools (src/rules.mjs)
//   sitemap.xml, robots.txt, llms.txt, _headers  SEO and security headers (CSP: the test's hosts)
// The Worker (src/worker.js: shared results' preview titles) is deployed from source by wrangler.
// Usage: node scripts/build.mjs          write the files
//        node scripts/build.mjs --check  exit 1 if anything in public/ is out of date (CI)
import { mkdir, readFile, readdir, writeFile, rm } from "node:fs/promises";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { build as bundle, transform } from "esbuild";
import { ruleSets } from "../src/rules.mjs";
import { CF } from "../src/measure.mjs";
import { LOCATE } from "../src/mlab.mjs";
import { USES } from "../src/verdict.mjs";
import { IPINFO } from "../src/net.mjs";

const SITE = (process.env.SITE_URL || "https://speed.1ms.dog").replace(/\/+$/, "");
const pub = new URL("../public/", import.meta.url), src = new URL("../src/", import.meta.url);
// language, URL folder, og:locale; the first is the root
export const LANGS = [["en", "", "en_US"], ["zh-CN", "zh-cn", "zh_CN"], ["zh-TW", "zh-tw", "zh_TW"], ["ja", "ja", "ja_JP"], ["ko", "ko", "ko_KR"],
  ["es", "es", "es_ES"], ["fr", "fr", "fr_FR"], ["de", "de", "de_DE"], ["pt", "pt", "pt_BR"], ["ru", "ru", "ru_RU"]];

// Runs before first paint: apply the saved theme. On the English root, send visitors to their language's page
// (a saved choice first, then the browser languages); crawlers and English readers stay.
const PREPAINT = `(function(){var d=document.documentElement,th=null,s=null;try{th=localStorage.getItem("speedtest:theme");s=localStorage.getItem("speedtest:lang")}catch(e){}if(th==="light"||th==="dark")d.setAttribute("data-theme",th);if(!d.hasAttribute("data-root"))return;var P=JSON.parse(d.getAttribute("data-paths")||"{}"),l=null;try{var q=new URLSearchParams(location.search).get("lang");if(P[q])l=q}catch(e){}if(!l&&P[s])l=s;for(var ls=navigator.languages||[navigator.language||"en"],i=0;!l&&!s&&i<ls.length;i++){var x=String(ls[i]).toLowerCase(),b=x.split("-")[0];l=b==="zh"?(/tw|hk|mo|hant/.test(x)?"zh-TW":"zh-CN"):P[b]?b:null}if(l&&l!=="en")location.replace(P[l]+location.search+location.hash)})();`;

const esc = s => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
const hash = s => createHash("sha256").update(s).digest("hex").slice(0, 10);
const sha = s => createHash("sha256").update(s).digest("base64");

async function loadI18n() {
  const out = {};
  for (const f of (await readdir(new URL("i18n/", src))).filter(f => f.endsWith(".mjs")))
    out[f.slice(0, -4)] = (await import(new URL("i18n/" + f, src).href + "?" + Date.now())).default;
  return out;
}

// Strings only the build uses (the page already shows them); everything else goes to the browser
const BUILD_ONLY = new Set(["name", "seo_title", "seo_desc", "seo_kw", "og_sub", "h1", "docs", "lang_label", "faq_h", "share_desc", "share_title"]);

// every origin the page asks (M-Lab's servers are WebSockets under measurement-lab.org, a wildcard in the CSP)
export const ORIGINS = [new URL(CF).origin, new URL(LOCATE).origin, IPINFO];
export const WS = "wss://*.measurement-lab.org";

export async function build({ check = false } = {}) {
  const I = await loadI18n(), en = I.en;
  const langs = LANGS.filter(([l]) => I[l]);
  for (const [l] of langs) for (const k of Object.keys(en)) if (!(k in I[l])) throw new Error(`i18n/${l}.mjs is missing "${k}"`);
  const tpl = await readFile(new URL("page.html", src), "utf8");

  const root = fileURLToPath(new URL("..", import.meta.url));
  // the QR encoder for the share card stays out of the app bundle: only a visitor who shares downloads it
  const qr = (await bundle({ stdin: { contents: 'import q from "qrcode-generator"; self.QR1MS = q;', resolveDir: root },
    bundle: true, minify: true, format: "iife", target: "es2020", legalComments: "none", write: false })).outputFiles[0].text;
  const qrName = `qr.${hash(qr)}.js`;
  const js = (await bundle({ entryPoints: [fileURLToPath(new URL("app.js", src))], bundle: true, minify: true, format: "iife", target: "es2020",
    legalComments: "none", write: false, absWorkingDir: root, define: { QR_JS: JSON.stringify("/assets/" + qrName) } })).outputFiles[0].text;
  const cssFull = (await Promise.all(["fonts.css", "base.css", "style.css"].map(f => readFile(new URL(f, src), "utf8")))).join("\n");
  const css = (await transform(cssFull, { loader: "css", minify: true, legalComments: "none" })).code;
  const jsName = `app.${hash(js)}.js`, cssName = `app.${hash(css)}.css`;
  const files = { ["assets/" + jsName]: js, ["assets/" + cssName]: css, ["assets/" + qrName]: qr };

  const path = slug => "/" + (slug ? slug + "/" : "");
  for (const [lang, slug, locale] of langs) {
    const d = I[lang], T = k => { if (!(k in d)) throw new Error(`i18n/${lang}.mjs has no "${k}"`); return d[k]; };
    const strings = Object.fromEntries(Object.keys(en).filter(k => !BUILD_ONLY.has(k)).map(k => [k, T(k)]));
    const sjs = `window.L1MS=${JSON.stringify(strings).replace(/</g, "\\u003c")};\n`;
    const sName = `l.${lang.toLowerCase()}.${hash(sjs)}.js`;
    files["assets/" + sName] = sjs;

    const url = SITE + path(slug), docs = T("docs");
    const alts = langs.map(([l, sl]) => `<link rel="alternate" hreflang="${l}" href="${SITE + path(sl)}">`).join("\n") + `\n<link rel="alternate" hreflang="x-default" href="${SITE}/">`;
    const graph = [
      { "@type": "WebApplication", name: T("app_name") + " · 1ms.dog", url, applicationCategory: "UtilitiesApplication", operatingSystem: "Any",
        browserRequirements: "Requires JavaScript", description: T("seo_desc"), inLanguage: lang, isAccessibleForFree: true,
        offers: { "@type": "Offer", price: "0", priceCurrency: "USD" } },
      { "@type": "FAQPage", mainEntity: docs.map(([q, a]) => ({ "@type": "Question", name: q, acceptedAnswer: { "@type": "Answer", text: a.replace(/\n+/g, " ") } })) },
    ];
    const head = [
      `<title>${esc(T("seo_title"))}</title>`,
      `<meta name="description" content="${esc(T("seo_desc"))}">`,
      `<meta name="keywords" content="${esc(T("seo_kw"))}">`,
      ...(lang === "zh-CN" ? [`<meta http-equiv="Cache-Control" content="no-transform">`, `<meta http-equiv="Cache-Control" content="no-siteapp">`, `<meta name="applicable-device" content="pc,mobile">`] : []),
      `<meta name="robots" content="index, follow, max-image-preview:large">`,
      `<meta name="application-name" content="${esc(T("app_name"))}">`,
      `<meta name="theme-color" content="#f6f6f7" media="(prefers-color-scheme: light)">`,
      `<meta name="theme-color" content="#1c1c1c" media="(prefers-color-scheme: dark)">`,
      `<link rel="canonical" href="${url}">`, alts,
      `<link rel="icon" href="/favicon.ico" sizes="any">`, `<link rel="icon" type="image/png" sizes="32x32" href="/favicon-32.png">`, `<link rel="apple-touch-icon" href="/apple-touch-icon.png">`,
      // the test server's connection starts while the page loads
      `<link rel="preconnect" href="${ORIGINS[0]}" crossorigin>`,
      `<meta property="og:type" content="website">`, `<meta property="og:site_name" content="1ms.dog">`,
      `<meta property="og:title" content="${esc(T("seo_title"))}">`, `<meta property="og:description" content="${esc(T("og_sub"))}">`, `<meta property="og:url" content="${url}">`,
      `<meta property="og:locale" content="${locale}">`,
      `<meta property="og:image" content="${SITE}/og/${lang.toLowerCase()}.png">`, `<meta property="og:image:width" content="1200">`, `<meta property="og:image:height" content="630">`,
      `<meta property="og:image:alt" content="${esc(T("seo_title"))}">`,
      `<meta name="twitter:card" content="summary_large_image">`, `<meta name="twitter:image" content="${SITE}/og/${lang.toLowerCase()}.png">`,
      `<meta name="twitter:title" content="${esc(T("seo_title"))}">`, `<meta name="twitter:description" content="${esc(T("og_sub"))}">`,
      `<script type="application/ld+json">${JSON.stringify({ "@context": "https://schema.org", "@graph": graph }).replace(/</g, "\\u003c")}</script>`,
    ].join("\n");

    const helpNav = docs.map(([q], i) => `<button type="button" role="tab" data-hq="${i}" aria-selected="${i === 0}">${esc(q)}</button>`).join("");
    const helpC = docs.map(([q, a], i) => `<article data-hqb="${i}"${i ? " hidden" : ""}><h3>${esc(q)}</h3>${a.split(/\n+/).map(p => `<p>${esc(p)}</p>`).join("")}</article>`).join("");
    const langOpts = langs.map(([l]) => `<option value="${l}"${l === lang ? " selected" : ""}>${esc(I[l].name)}</option>`).join("");
    const paths = Object.fromEntries(langs.map(([l, sl]) => [l, path(sl)]));
    const uses = USES.map(k => `<li data-u="${k}" data-lv=""><span>${esc(T("u_" + k))}</span><span class="lv"></span></li>`).join("");

    const html = tpl
      .replace(/(<(\w+)\b[^>]*\sdata-i="(\w+)"[^>]*>)([^<]*)(<\/\2>)/g, (m, open, tag, k, inner, close) => open + esc(T(k)) + close)
      .replace(/\{\{a:(\w+)\}\}/g, (m, k) => esc(T(k)))   // translated attribute values (aria-label, tooltips)
      .replace(/\{\{(k_\w+)\}\}/g, (m, k) => esc(T(k)))   // labels that carry a tooltip
      .replace("{{lang}}", lang).replace("{{pathsAttr}}", esc(JSON.stringify(paths))).replace("{{rootAttr}}", slug ? "" : " data-root")
      .replace("{{prepaint}}", PREPAINT).replace("{{head}}", head).replace("{{css}}", cssName).replace("{{js}}", jsName).replace("{{strings}}", sName)
      .split("{{homeHref}}").join(path(slug)).replace("{{langOpts}}", langOpts).replace("{{h1}}", esc(T("h1"))).replace("{{uses}}", uses)
      .replace("{{helpNav}}", helpNav).replace("{{helpC}}", helpC).replace("{{data}}", JSON.stringify({ lang, paths }).replace(/</g, "\\u003c"));
    if (/\{\{[\w:]+\}\}/.test(html)) throw new Error("unfilled placeholder in " + path(slug) + ": " + /\{\{[\w:]+\}\}/.exec(html)[0]);
    files[(slug ? slug + "/" : "") + "index.html"] = html;
  }

  files["sitemap.xml"] = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">\n` +
    langs.map(([, s]) => `  <url>\n    <loc>${SITE + path(s)}</loc>\n` + langs.map(([l, s2]) => `    <xhtml:link rel="alternate" hreflang="${l}" href="${SITE + path(s2)}"/>`).join("\n") +
      `\n    <xhtml:link rel="alternate" hreflang="x-default" href="${SITE}/"/>\n  </url>`).join("\n") + "\n</urlset>\n";
  for (const [name, text] of Object.entries(ruleSets(SITE))) files["rules/" + name] = text;
  files["robots.txt"] = `User-agent: *\nAllow: /\n\nSitemap: ${SITE}/sitemap.xml\n`;
  files["llms.txt"] = `# ${en.app_name} · 1ms.dog

> Free internet speed test in the browser: download and upload speed, idle latency, jitter, and latency under load
> (bufferbloat), measured from the visitor's own network against Cloudflare's speed test servers (the nearest
> Cloudflare data center). Several requests in flight, bytes counted as they arrive, speed taken after the ramp-up.
> Says what the line is good for (4K video, video calls, online games, cloud gaming, live streaming). Optional second
> opinion from M-Lab's ndt7 test (one connection, a server outside the visitor's ISP). Waits for Start by default.
> Nothing is sent to this site; requests go straight from the browser to the test servers.

- Page: ${SITE}/ (also ${langs.slice(1).map(([, s]) => "/" + s + "/").join(", ")})
- Shared results: ${SITE}/r/<code> (format in src/share.mjs)
- Direct rules for proxy tools (so the test measures your own line, not the proxy): ${SITE}/rules/clash.yaml, surge.list, loon.list, quanx.list, singbox.json
- Source code: https://github.com/yt1988/speed-test

`;
  // The only inline script is the pre-paint snippet, identical on every page: one hash covers the site.
  const csp = ["default-src 'self'", `script-src 'self' 'sha256-${sha(PREPAINT)}'`, "style-src 'self' 'unsafe-inline'", "font-src 'self'", "img-src 'self' data: blob:",
    "connect-src 'self' " + [...ORIGINS, WS].join(" "),
    "manifest-src 'self'", "object-src 'none'", "base-uri 'none'", "form-action 'none'", "frame-ancestors 'none'"].join("; ");
  files["_headers"] = `# Generated by scripts/build.mjs
/*
  Content-Security-Policy: ${csp}
  Referrer-Policy: strict-origin-when-cross-origin
  X-Content-Type-Options: nosniff
  X-Frame-Options: DENY
  Cross-Origin-Opener-Policy: same-origin
  Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), usb=(), interest-cohort=()
/assets/*
  Cache-Control: public, max-age=604800
/assets/app.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/l.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/qr.*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/assets/fonts/*
  ! Cache-Control
  Cache-Control: public, max-age=31536000, immutable
/og/*
  Cache-Control: public, max-age=604800
/rules/*
  Access-Control-Allow-Origin: *
  Cache-Control: public, max-age=3600
/rules/*.json
  Content-Type: application/json; charset=utf-8
/rules/*.yaml
  Content-Type: text/plain; charset=utf-8
/rules/*.list
  Content-Type: text/plain; charset=utf-8
/llms.txt
  Access-Control-Allow-Origin: *
  Content-Type: text/plain; charset=utf-8
`;

  // generated files that are no longer produced (old hashes) are stale too
  const gen = async () => { try { return (await readdir(new URL("assets/", pub))).filter(f => /^(app|l|qr)\..+\.(js|css)$/.test(f)).map(f => "assets/" + f); } catch (e) { return []; } };
  const stale = [];
  for (const [f, body] of Object.entries(files)) {
    let cur = null; try { cur = await readFile(new URL(f, pub), "utf8"); } catch (e) {}
    if (cur !== body) stale.push(f);
  }
  const orphans = (await gen()).filter(f => !(f in files));
  if (check) return [...stale, ...orphans];
  for (const f of stale) { await mkdir(new URL(".", new URL(f, pub)), { recursive: true }); await writeFile(new URL(f, pub), files[f]); }
  for (const f of orphans) await rm(new URL(f, pub));
  return [...stale, ...orphans];
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const check = process.argv.includes("--check");
  const changed = await build({ check });
  if (check && changed.length) { console.error("public/ is out of date: " + changed.join(", ") + "\nRun npm run build and commit public/."); process.exit(1); }
  console.log(check ? "public/ is up to date" : changed.length ? "wrote " + changed.join(", ") : "nothing to do");
}
