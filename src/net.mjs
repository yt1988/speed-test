// Which way the test goes: the exit Cloudflare sees, and signs that it isn't the visitor's own line (as the
// me2cloud tool reads them): the device's time zone in one country and the exit in another, an exit on a data-center
// network, and the two test services seeing addresses from different networks (split routing). Pure, unit-tested.

export const DC_RE = /amazon|google|microsoft|azure|digitalocean|vultr|choopa|constant company|linode|akamai|ovh|hetzner|oracle|alibaba|aliyun|tencent|huawei|m247|datacamp|cloudflare|leaseweb|contabo|hostinger|it7|racknerd|colocrossing|psychz|zenlayer|g-core|gcore|hostwinds|scaleway|ionos|kamatera|upcloud|bandwagon|dmit|cogent|quadranet|servers\.com|packet|equinix|fastly|cdn77|datapacket|tzulo|hostdare|greencloud|nexeon|frantech|buyvm/i;

export const TZ_CC = Object.fromEntries(("Asia/Shanghai:CN Asia/Chongqing:CN Asia/Harbin:CN Asia/Urumqi:CN Asia/Hong_Kong:HK Asia/Macau:MO Asia/Taipei:TW Asia/Tokyo:JP " +
  "Asia/Seoul:KR Asia/Singapore:SG Asia/Kuala_Lumpur:MY Asia/Bangkok:TH Asia/Jakarta:ID Asia/Manila:PH Asia/Ho_Chi_Minh:VN Asia/Saigon:VN " +
  "Asia/Kolkata:IN Asia/Calcutta:IN Asia/Dubai:AE Asia/Riyadh:SA Asia/Qatar:QA Asia/Jerusalem:IL Asia/Tel_Aviv:IL Asia/Karachi:PK " +
  "Europe/London:GB Europe/Dublin:IE Europe/Paris:FR Europe/Berlin:DE Europe/Amsterdam:NL Europe/Brussels:BE Europe/Zurich:CH Europe/Rome:IT " +
  "Europe/Madrid:ES Europe/Lisbon:PT Europe/Stockholm:SE Europe/Oslo:NO Europe/Helsinki:FI Europe/Copenhagen:DK Europe/Warsaw:PL Europe/Vienna:AT " +
  "Europe/Prague:CZ Europe/Moscow:RU Europe/Istanbul:TR Europe/Kiev:UA Europe/Kyiv:UA Europe/Athens:GR Europe/Bucharest:RO Europe/Budapest:HU " +
  "Australia/Sydney:AU Australia/Melbourne:AU Australia/Brisbane:AU Australia/Perth:AU Australia/Adelaide:AU Pacific/Auckland:NZ " +
  "America/New_York:US America/Chicago:US America/Denver:US America/Los_Angeles:US America/Phoenix:US America/Anchorage:US Pacific/Honolulu:US " +
  "America/Toronto:CA America/Vancouver:CA America/Montreal:CA America/Edmonton:CA America/Mexico_City:MX America/Sao_Paulo:BR America/Santiago:CL " +
  "America/Bogota:CO America/Lima:PE America/Argentina/Buenos_Aires:AR Africa/Johannesburg:ZA Africa/Cairo:EG Africa/Lagos:NG Africa/Nairobi:KE")
  .split(" ").map(p => p.split(":")));

// Cloudflare's /meta answer (or its /cdn-cgi/trace as key=value lines) → the exit
export function fromMeta(j) {
  if (!j || !j.clientIp) return null;
  const c = j.colo || {};
  return { ip: j.clientIp, cc: j.country || "", city: j.city || "", asn: j.asn || null, org: j.asOrganization || "",
    colo: c.iata || "", coloCity: c.city || "", coloCc: c.cca2 || "", http: j.httpProtocol || "" };
}
export function fromTrace(text) {
  const d = Object.fromEntries(String(text || "").trim().split("\n").map(l => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]));
  return d.ip ? { ip: d.ip, cc: d.loc && d.loc !== "XX" ? d.loc : "", city: "", asn: null, org: "", colo: d.colo || "", coloCity: "", coloCc: "", http: d.http || "" } : null;
}

// The network an address belongs to: /16 for IPv4, /64 for IPv6 (CGNAT pools and temporary IPv6 addresses vary inside)
const v6 = a => { const [h, tl = ""] = a.toLowerCase().split("::"), H = h ? h.split(":") : [], T = tl ? tl.split(":") : []; return [...H, ...Array(Math.max(0, 8 - H.length - T.length)).fill("0"), ...T].map(g => g.padStart(4, "0")); };
export const netOf = ip => !ip ? "" : ip.includes(":") ? v6(ip).slice(0, 4).join(":") : ip.split(".").slice(0, 2).join(".");
export const family = ip => ip && ip.includes(":") ? 6 : 4;

// "1.2.3.4:5678" or "[2001:db8::1]:5678" (M-Lab's ConnectionInfo.Client) → the address
export const hostOf = s => { const m = /^\[([^\]]+)\]:\d+$/.exec(s || "") || /^([\d.]+):\d+$/.exec(s || ""); return m ? m[1] : ""; };

// M-Lab's locate service gives a server near where it sees the visitor (by the country of the address it sees). The
// countries with M-Lab servers (siteinfo, 2026-11) and their continents; and where visitors from a few countries
// without one are usually placed.
const CONT = Object.fromEntries(("AR:SA AU:OC BE:EU BG:EU BR:SA CA:NA CH:EU CL:SA CO:SA CZ:EU DE:EU ES:EU FI:EU FR:EU GB:EU GR:EU HK:AS ID:AS IE:EU " +
  "IL:AS IN:AS IT:EU JP:AS KE:AF KR:AS ME:EU MG:AF MX:NA MZ:AF NG:AF NL:EU NO:EU NZ:OC PE:SA PH:AS PL:EU PT:EU QA:AS RS:EU SE:EU SG:AS TN:AF " +
  "TW:AS US:NA ZA:AF").split(" ").map(p => p.split(":")));
const NEAR = { CN: ["HK", "TW", "KR"], MO: ["HK", "TW"] };
// Whether M-Lab sees the visitor somewhere else than Cloudflare does: true when its server is outside the exit's
// country and its usual neighbors (another continent, for countries with servers of their own), false when it fits,
// null when it can't be told. True means M-Lab's requests leave by another exit: in practice a proxy.
export function mlabAway(exit, srv) {
  if (!exit || !exit.cc || !srv || !srv.country) return null;
  if (srv.country === exit.cc) return false;
  if (NEAR[exit.cc]) return !NEAR[exit.cc].includes(srv.country);
  if (CONT[exit.cc] && CONT[srv.country]) return CONT[exit.cc] !== CONT[srv.country];
  return null;
}

// Whether the connection M-Lab's server sees ends somewhere other than the browser: the server's own round trip
// (TCPInfo.MinRTT) far below what opening the connection took in the browser. Direct, opening takes a few round
// trips (TCP, TLS, the WebSocket upgrade, perhaps a DNS lookup); through a proxy, the proxy opens the TCP connection
// near the server, so the server sees a tiny round trip while the browser waited for the whole tunnel.
// (Seen: 2 ms at the server, 620 ms in the browser, through a proxy node near the server.)
export const tcpElsewhere = (openMs, minRtt) => openMs > 0 && minRtt > 0 ? openMs > 10 * minRtt + 50 : null;

// ipinfo.io's answer for an address ({ org: "AS16509 Amazon.com, Inc." }) → { asn, org }, or null
export function fromIpinfo(j) {
  const m = /^AS(\d+)\s+(.+)$/.exec((j && j.org) || "");
  return m ? { asn: +m[1], org: m[2] } : null;
}
// M-Lab sees a data-center network while Cloudflare sees one that isn't: M-Lab's requests go through a proxy or VPN
export const dcOnlyMlab = (exit, mlOrg) => !!(exit && mlOrg && DC_RE.test(mlOrg.org) && !(exit.org && DC_RE.test(exit.org)));

// Signs that the test doesn't measure the visitor's own line, each { k: string key, ...values }:
//   r_tz     the device's time zone is in one country, the exit in another (Hong Kong and Macau count as China's)
//   r_dc     the exit is on a data-center network
//   r_split  M-Lab saw an address of the same family from another network than Cloudflare did
export function reasons(exit, { tz = "", mlabIp = "" } = {}) {
  const out = [];
  if (!exit) return out;
  const tzc = TZ_CC[tz];
  if (tzc && exit.cc && tzc !== exit.cc && !(tzc === "CN" && ["HK", "MO"].includes(exit.cc))) out.push({ k: "r_tz", a: tzc, b: exit.cc });
  if (exit.org && DC_RE.test(exit.org)) out.push({ k: "r_dc", org: exit.org + (exit.asn ? " (AS" + exit.asn + ")" : "") });
  if (mlabIp && exit.ip && family(mlabIp) === family(exit.ip) && netOf(mlabIp) !== netOf(exit.ip)) out.push({ k: "r_split", a: exit.ip, b: mlabIp });
  return out;
}

// who an address belongs to, for the address M-Lab saw (open to any origin, no key)
export const IPINFO = "https://ipinfo.io";
