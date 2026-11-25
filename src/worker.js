// The Speed Test Worker. Pages are routed through it (wrangler.toml run_worker_first) so it can write the site's
// measurement endpoints into their <head> from env.MS_RTC / env.MS_ANCHORS (the values are secrets; nothing set
// means no endpoints and the page hides them). Other files are served as they are.
//   /r/<code>, /<lang>/r/<code>   a shared result: that language's page with the speeds in its title and description
//                         (what chat apps show as the link's preview), not indexed; the page itself reads the code and
//                         shows the result (src/share.mjs)
//                         A code it can't read is a 404 like any other path.
//   a page                the asset, with the ms-* metas and their origins added to connect-src
//   anything else         the asset as it is, or a bare 404; 1ms-shell puts the shared 404 page in front of it

import { decode, sharePath } from "./share.mjs";
import { metaTags, extendCsp } from "./endpointenv.mjs";
import { fmtMbps, fmtMs, grade } from "./verdict.mjs";
import en from "./i18n/en.mjs";
import zhCN from "./i18n/zh-CN.mjs";
import zhTW from "./i18n/zh-TW.mjs";
import ja from "./i18n/ja.mjs";
import ko from "./i18n/ko.mjs";
import es from "./i18n/es.mjs";
import fr from "./i18n/fr.mjs";
import de from "./i18n/de.mjs";
import pt from "./i18n/pt.mjs";
import ru from "./i18n/ru.mjs";

// each language's strings by its folder ("" is English, at the root)
const STR = { "": en, "zh-cn": zhCN, "zh-tw": zhTW, ja, ko, es, fr, de, pt, ru };
const fill = (s, v) => s.replace(/\{(\w+)\}/g, (m, k) => k in v ? v[k] : m);

export default {
  async fetch(req, env) {
    const url = new URL(req.url);
    if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed\n", { status: 405 });
    const sp = sharePath(url.pathname);
    if (sp) {
      const r = env.ASSETS && STR[sp.slug] && decode(sp.code);
      if (r) return shared(req, env, url, sp.slug, r);
      // a result code that can't be read is a 404, not the page without a result
      return new Response(req.method === "HEAD" ? null : "Not found\n", {
        status: 404,
        headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
      });
    }
    if (env.ASSETS) {
      const res = await env.ASSETS.fetch(req);
      return res.ok && (res.headers.get("content-type") || "").includes("text/html") ? withEndpoints(res, env, req) : res;
    }
    return new Response(req.method === "HEAD" ? null : "Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
    });
  },
};

// The endpoints a deployment injected, as metas in <head>, and their origins added to the page's connect-src. The
// page's ETag is made from the asset's plus a hash of the tags, so a changed secret is a new page rather than a 304
// that keeps yesterday's endpoints in the browser.
const hash = s => { let h = 2166136261; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619) >>> 0; return h.toString(36); };
function withEndpoints(res, env, req) {
  const tags = metaTags(env);
  const before = res.headers.get("content-security-policy");
  const csp = extendCsp(before, env);
  if (!tags && csp === before) return res;
  const h = new Headers(res.headers);
  if (csp) h.set("content-security-policy", csp);
  if (!tags) return new Response(req.method === "HEAD" ? null : res.body, { status: res.status, statusText: res.statusText, headers: h });
  const base = (h.get("etag") || "").replace(/^W\//, "").replace(/"/g, "");
  const tag = base ? `"${base}-${hash(tags)}"` : "";
  if (tag) h.set("etag", tag);
  const inm = (req.headers.get("if-none-match") || "").split(",").map(s => s.trim());
  if (tag && (inm.includes(tag) || inm.includes("W/" + tag))) return new Response(null, { status: 304, headers: h });
  h.delete("content-length");
  if (req.method === "HEAD") return new Response(null, { status: res.status, statusText: res.statusText, headers: h });
  const src = new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
  return new HTMLRewriter().on("head", { element(e) { e.append(tags, { html: true }); } }).transform(src);
}

// A shared result: the language's page as it is, with the title, description and their Open Graph and Twitter copies
// carrying the speeds.
async function shared(req, env, url, slug, r) {
  const home = "/" + (slug ? slug + "/" : "");
  const S = STR[slug], v = { down: fmtMbps(r.down), up: fmtMbps(r.up), ms: fmtMs(r.idle), grade: grade(r) || "–" };
  const title = fill(S.share_title, v), desc = fill(S.share_desc, v);
  const page = await env.ASSETS.fetch(new Request(new URL(home, url), { headers: req.headers }));
  if (!page.ok) return page;
  const attr = (val, name = "content") => ({ element: e => e.setAttribute(name, val) });
  const out = new HTMLRewriter()
    .on("title", { element: e => e.setInnerContent(title) })
    .on('meta[name="description"]', attr(desc))
    .on('meta[property="og:title"]', attr(title)).on('meta[name="twitter:title"]', attr(title))
    .on('meta[property="og:description"]', attr(desc)).on('meta[name="twitter:description"]', attr(desc))
    .on('meta[property="og:url"]', attr(url.origin + url.pathname))
    .on('meta[name="robots"]', attr("noindex, follow"))
    .transform(page);
  const h = new Headers(out.headers);
  h.delete("etag");
  h.set("cache-control", "public, max-age=3600");
  h.set("x-robots-tag", "noindex");
  return withEndpoints(new Response(req.method === "HEAD" ? null : out.body, { status: 200, headers: h }), env, req);
}
