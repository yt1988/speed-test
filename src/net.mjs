// Which way the test goes: the exit Cloudflare sees, and the site's one egress verdict (src/egress.js, vendored from
// 1ms.dog; the rules are in its docs/egress-contract.md): is this the visitor's own line, or a proxy? Pure, unit-tested.

import { classify } from "./egress.js";

// Cloudflare's /meta answer (or its /cdn-cgi/trace as key=value lines) → the exit
export function fromMeta(j) {
  if (!j || !j.clientIp) return null;
  const c = j.colo || {};
  return { ip: j.clientIp, cc: j.country || "", city: j.city || "", asn: j.asn || null, org: j.asOrganization || "",
    colo: c.iata || "", coloCity: c.city || "", coloCc: c.cca2 || "", http: j.httpProtocol || "" };
}
// 1ms-shell's /_ms/me: what Cloudflare knows of this connection to the page's own host (a 404 when self-hosted)
export function fromMe(j) {
  if (!j || !j.ip) return null;
  return { ip: j.ip, cc: j.country || "", city: j.city || "", asn: j.asn || null, org: j.org || "", colo: j.colo || "", coloCity: "", coloCc: "", http: j.http || "" };
}
export function fromTrace(text) {
  const d = Object.fromEntries(String(text || "").trim().split("\n").map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return d.ip ? { ip: d.ip, cc: d.loc && d.loc !== "XX" ? d.loc : "", city: "", asn: null, org: "", colo: d.colo || "", coloCity: "", coloCc: "", http: d.http || "" } : null;
}

// The page's one exit as an answer for the core: from the test host's /meta or trace, or the shell's /_ms/me when the
// test host couldn't say. The group is what the single-exit mode looks for first; there is no second exit here.
const answerOf = e => ({ id: "test", group: "web", ip: e.ip, org: e.org || "", asn: e.asn || null, family: e.ip.includes(":") ? 6 : 4 });

// The core's single-exit verdict — direct, proxy or unknown — and the reasons behind it, each { k, ...values }:
//   r_tz   the device's time zone is in one country, the exit in another (Hong Kong and Macau count as China's)
//   r_dc   the exit is on a data-center network
//   r_vpn  the exit is on a VPN provider's network
// (r_warp, r_rtc and r_fam need inputs this page doesn't have.)
export function egress(exit, { tz = "", warp = "" } = {}) {
  const answers = exit && exit.ip ? [answerOf(exit)] : [];
  const { verdict, reasons } = classify({ mode: "single", tz, cc: (exit && exit.cc) || "", warp, answers });
  return { verdict, reasons };
}
// for callers that only need the signs
export const reasons = (exit, opts) => egress(exit, opts).reasons;

