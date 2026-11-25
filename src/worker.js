// The Speed Test Worker. Files in ./public are served before it runs, so it only sees paths that are not files:
//   /r/<code>, /<lang>/r/<code>   a shared result: that language's page with the speeds in its title and description
//                         (what chat apps show as the link's preview), not indexed; the page itself reads the code and
//                         shows the result (src/share.mjs)
//                         A code it can't read is a 404 like any other path.
//   anything else         a bare 404; 1ms-shell puts the shared 1ms.dog 404 page in front of it

import { decode, sharePath } from "./share.mjs";
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
    const r = sp && STR[sp.slug] && env.ASSETS && decode(sp.code);
    if (r) return shared(req, env, url, sp.slug, r);
    return new Response(req.method === "HEAD" ? null : "Not found\n", {
      status: 404,
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=0, must-revalidate" },
    });
  },
};

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
  return new Response(req.method === "HEAD" ? null : out.body, { status: 200, headers: h });
}
