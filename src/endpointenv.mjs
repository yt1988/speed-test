// The site's own measurement endpoints are deploy-time data (docs/tool-contract.md §2 of the 1ms.dog repo): the
// Worker writes env.MS_RTC / env.MS_ANCHORS into <meta> tags, and a static build can do the same from MS_RTC /
// MS_ANCHORS environment variables. Nothing injected means the page hides what it cannot measure.
//
//   <meta name="ms-rtc" content="sig=https://…:2087;ice=…:40100-40101;wt=https://…:40101
//                                ;sig_cn=https://…:2087;ice_cn=…:40100-40101;wt_cn=https://…:40101">
//   <meta name="ms-anchors" content="cn=https://…;intl=https://…">
//
// sig and wt feed the browser's WebRTC and WebTransport checks; ice is for the server's own configuration and is not
// under connect-src. The optional *_cn keys are the domestic measurement point of the speed/lag comparison; the
// plain keys are the cross-border one.

export const pairs = text => {
  const out = {};
  for (const part of String(text || "").split(";")) {
    const at = part.indexOf("=");
    if (at < 1) continue;
    const k = part.slice(0, at).trim(), v = part.slice(at + 1).trim();
    if (k && v) out[k] = v;
  }
  return out;
};

const ENV = { "ms-anchors": "MS_ANCHORS", "ms-rtc": "MS_RTC" };
const esc = s => String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;");

// the <meta> tags for whatever the deployment set, empty when nothing is
export const metaTags = env => Object.entries(ENV)
  .filter(([, key]) => env && env[key])
  .map(([name, key]) => `<meta name="${name}" content="${esc(env[key])}">`).join("");

const origin = s => { try { return new URL(s).origin; } catch (e) { return ""; } };

// every origin the injected endpoints make the page ask: the WebSocket and WebTransport on the rtc hosts (the offer
// is https, the echo wss), and the anchors' https origins
export const connectOrigins = env => {
  const out = new Set(), rtc = pairs(env && env.MS_RTC), an = pairs(env && env.MS_ANCHORS);
  for (const k of ["sig", "sig_cn"]) {
    const o = origin(rtc[k]);
    if (o) { out.add(o); out.add(o.replace(/^https/, "wss")); }
  }
  for (const k of ["wt", "wt_cn"]) { const o = origin(rtc[k]); if (o) out.add(o); }
  for (const k of ["cn", "intl"]) { const o = origin(an[k]); if (o) out.add(o); }
  return [...out];
};

// a Content-Security-Policy string with those origins added to connect-src
export const extendCsp = (csp, env) => {
  const add = connectOrigins(env);
  if (!add.length) return csp;
  const parts = String(csp || "").split(";").map(s => s.trim()).filter(Boolean);
  const i = parts.findIndex(p => /^connect-src\b/.test(p));
  if (i < 0) return [...parts, "connect-src " + add.join(" ")].join("; ");
  const seen = new Set(parts[i].split(/\s+/).filter(Boolean));
  for (const o of add) seen.add(o);
  parts[i] = [...seen].join(" ");
  return parts.join("; ");
};
