// Direct (bypass) rules for proxy tools: with a proxy on, the test's requests go through it and the page measures the
// proxy's route and node, not the visitor's own line. These rules send exactly the test's host DIRECT: Cloudflare's
// speed test host by exact name. (Domain-suffix rules are supported too, for a test server that changes from test to
// test; none is used now.)
// Used by scripts/build.mjs (the remote rule sets under /rules/) and by the page (the rules dialog).
import { CF } from "./measure.mjs";

export const FORMATS = ["clash", "surge", "shadowrocket", "quanx", "loon", "singbox", "xray", "plain"];
export const FORMAT_NAMES = { clash: "Clash / Mihomo", surge: "Surge", shadowrocket: "Shadowrocket", quanx: "Quantumult X", loon: "Loon", singbox: "sing-box", xray: "Xray / v2rayN" };

// [{ n: what it's for, d: exact host } | { n, s: domain and every name under it }], in list order
export function items() {
  return [
    { n: "Cloudflare", d: new URL(CF).hostname },
  ];
}

const exact = it => it.filter(i => i.d).map(i => i.d);
const suffix = it => it.filter(i => i.s).map(i => i.s);

// one rule; withPolicy: inline in the tool's own config (a remote set carries no policy)
function line(f, i, withPolicy) {
  if (f === "quanx") return i.d ? `host, ${i.d}, direct` : `host-suffix, ${i.s}, direct`;
  const p = withPolicy ? ",DIRECT" : "";
  return i.d ? `DOMAIN,${i.d}${p}` : `DOMAIN-SUFFIX,${i.s}${p}`;
}

// a comment before each group's rules
const listed = (it, f, ind, withPolicy) => it.map((i, k) => (k && it[k - 1].n === i.n ? "" : `${ind}# ${i.n}\n`) + ind + (ind && f === "clash" ? "- " : "") + line(f, i, withPolicy)).join("\n");

// everything pasted into the tool's own config
export function inline(f, notes, it = items()) {
  if (f === "singbox") return JSON.stringify({ route: { rules: [{ domain: exact(it), domain_suffix: suffix(it), outbound: "direct" }] } }, null, 2);
  if (f === "xray") return JSON.stringify({ routing: { rules: [{ type: "field", domain: [...exact(it).map(d => "full:" + d), ...suffix(it).map(d => "domain:" + d)], outboundTag: "direct" }] } }, null, 2);
  if (f === "plain") return [...exact(it), ...suffix(it).map(d => "*." + d)].join("\n");
  const head = { clash: "rules:", surge: "[Rule]", shadowrocket: "[Rule]", loon: "[Rule]", quanx: "[filter_local]" }[f];
  return head + `\n${f === "clash" ? "  " : ""}# ${notes.top}\n` + listed(it, f, f === "clash" ? "  " : "", true);
}

// the lines that point the tool at our rule set (null: the tool has no remote rule sets)
export function remote(f, site, notes) {
  const u = site + "/rules/";
  switch (f) {
    case "clash": return `rule-providers:\n  speed-test:\n    type: http\n    behavior: classical\n    format: yaml\n    url: ${u}clash.yaml\n    path: ./ruleset/speed-test.yaml\n    interval: 86400\n\nrules:\n  - RULE-SET,speed-test,DIRECT   # ${notes.top}`;
    case "surge": return `[Rule]\n# ${notes.top}\nRULE-SET,${u}surge.list,DIRECT,update-interval=86400`;
    case "shadowrocket": return `[Rule]\n# ${notes.top}\nRULE-SET,${u}surge.list,DIRECT`;
    case "quanx": return `[filter_remote]\n${u}quanx.list, tag=Speed Test, force-policy=direct, update-interval=86400, opt-parser=false, enabled=true`;
    case "loon": return `[Remote Rule]\n${u}loon.list, policy=DIRECT, tag=Speed Test, enabled=true`;
    case "singbox": return JSON.stringify({ route: { rule_set: [{ tag: "speed-test", type: "remote", format: "source", url: u + "singbox.json", download_detour: "direct", update_interval: "1d" }],
      rules: [{ rule_set: "speed-test", outbound: "direct" }] } }, null, 2);
  }
  return null;
}

// the remote rule set files, written by scripts/build.mjs
export function ruleSets(site, it = items()) {
  const head = `# Speed Test: the hosts the speed test talks to, to be sent DIRECT. ${it.length} rule${it.length === 1 ? "" : "s"}.\n# ${site}/ · https://github.com/yt1988/speed-test\n`;
  return {
    "clash.yaml": head + "payload:\n" + listed(it, "clash", "  ", false) + "\n",
    "surge.list": head + listed(it, "surge", "", false) + "\n",
    "loon.list": head + listed(it, "loon", "", false) + "\n",
    "quanx.list": head + listed(it, "quanx", "", false) + "\n",
    "singbox.json": JSON.stringify({ version: 2, rules: [{ domain: exact(it), domain_suffix: suffix(it) }] }, null, 2) + "\n",
  };
}
