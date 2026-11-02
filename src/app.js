// Speed Test page. Waits for Start unless the visitor turned on testing when the page opens (remembered here).
// Order: idle latency, download, upload (src/measure.mjs), each shown live in the hero's fixed slots; at the end what
// the line is good for and the bufferbloat grade (how much latency load adds). Strings: window.L1MS.
import { ping, download, upload, median, jitter, exit } from "./measure.mjs";
import { reasons } from "./net.mjs";
import { fmtMbps, fmtMs, msTier, speedTier, bloat, grade, gradeKey, gradeTier, uses, USES } from "./verdict.mjs";
import { FORMATS, FORMAT_NAMES, items as ruleItems, inline as ruleInline, remote as ruleRemote } from "./rules.mjs";
import { parse as parseHist, add as addHist, change, isPeak } from "./history.mjs";
import { encode as encodeShare, decode as decodeShare, sharePath } from "./share.mjs";

(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent);
  const L = window.L1MS || {};
  const t = (k, v) => { let s = L[k] ?? k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const K = { theme: "speedtest:theme", lang: "speedtest:lang", rules: "speedtest:rules", auto: "speedtest:auto", hist: "speedtest:hist" };

  /* ---------- embedded in the Connection Checkup (1ms-shell docs/checkup.md) ---------- */
  // ?embed=checkup, and only when the page embedding this one is the checkup the shell announces (<meta name="check">);
  // otherwise the parameter is ignored. Messages go to that origin only.
  const EMBED = (() => {
    const m = document.querySelector('meta[name="check"]');
    if (!m || new URLSearchParams(location.search).get("embed") !== "checkup" || parent === window) return "";
    try { const o = new URL(m.content).origin; return new URL(document.referrer).origin === o ? o : ""; } catch (e) { return ""; }
  })();
  const post = msg => { if (EMBED) parent.postMessage({ ms: "checkup", v: 1, tool: "speed", ...msg }, EMBED); };
  if (EMBED) {
    document.documentElement.dataset.embed = "checkup";
    let lastH = 0;
    new ResizeObserver(() => {
      const h = Math.ceil($(".app").getBoundingClientRect().height);
      if (h !== lastH) post({ type: "size", height: lastH = h });
    }).observe($(".app"));
  }

  /* ---------- theme and language (synced across the 1ms.dog tools) ---------- */
  const thBtn = $("#theme"), TH = ["system", "light", "dark"];
  const applyTheme = th => {
    if (th === "light" || th === "dark") document.documentElement.setAttribute("data-theme", th); else document.documentElement.removeAttribute("data-theme");
    thBtn.dataset.th = th; thBtn.title = t("th_" + th); thBtn.setAttribute("aria-label", t("th_" + th));
    drawChart();
  };
  thBtn.onclick = () => { const n = TH[(TH.indexOf(thBtn.dataset.th) + 1) % 3]; store.set(K.theme, n); applyTheme(n); };
  $("#lang").onchange = e => { const l = e.target.value; store.set(K.lang, l); location.href = D.paths[l] + location.search; };

  /* ---------- dialogs ---------- */
  function openDlg(id) { $("#" + id).hidden = false; document.documentElement.style.overflow = "hidden"; $("#" + id + " [data-close]").focus(); }
  function closeDlg() { $$(".scrim").forEach(s => { s.hidden = true; }); document.documentElement.style.overflow = ""; }
  $$("[data-close]").forEach(b => { b.onclick = closeDlg; });
  $$(".scrim").forEach(s => s.addEventListener("click", e => { if (e.target === s) closeDlg(); }));
  document.addEventListener("keydown", e => { if (e.key === "Escape") closeDlg(); });
  // help: one answer at a time; a picker with previous / next on phones
  let helpIdx = 0;
  const helpN = $$("#helpNav [data-hq]").length;
  $("#helpSel").innerHTML = $$("#helpNav [data-hq]").map((b, i) => `<option value="${i}">${i + 1} / ${helpN} · ${esc(b.textContent)}</option>`).join("");
  function showHelp(i) {
    helpIdx = Math.max(0, Math.min(helpN - 1, i));
    $$("#helpNav [data-hq]").forEach(b => b.setAttribute("aria-selected", +b.dataset.hq === helpIdx));
    $$("#helpC [data-hqb]").forEach(a => { a.hidden = +a.dataset.hqb !== helpIdx; });
    $("#helpSel").value = helpIdx;
    $$("[data-hstep]").forEach(b => { b.disabled = helpIdx + +b.dataset.hstep < 0 || helpIdx + +b.dataset.hstep >= helpN; });
    $("#helpC").scrollTop = 0;
  }
  $("#helpBtn").onclick = () => { showHelp(helpIdx); openDlg("help"); };
  $$("#helpNav [data-hq]").forEach(b => { b.onclick = () => showHelp(+b.dataset.hq); });
  $("#helpSel").onchange = e => showHelp(+e.target.value);
  $$("[data-hstep]").forEach(b => { b.onclick = () => showHelp(helpIdx + +b.dataset.hstep); });

  /* ---------- direct rules for proxy tools ---------- */
  // this site's address for the remote rule sets; the public one when running locally
  const SITE = /^(localhost|127\.|\[)/.test(location.hostname) ? "https://speed.1ms.dog" : location.origin;
  let ruleFmt = FORMATS.includes(store.get(K.rules)) ? store.get(K.rules) : "clash";
  const codeBox = text => `<div class="codebox"><textarea readonly spellcheck="false" rows="${Math.min(14, text.split("\n").length + 1)}">${esc(text)}</textarea><button class="btn" type="button" data-copyta>${esc(t("copy"))}</button></div>`;
  function renderRules() {
    const notes = { top: t("rules_top") }, n = ruleItems().length;
    $("#ruleTabs").innerHTML = FORMATS.map(f => `<button type="button" role="tab" data-f="${f}" aria-selected="${f === ruleFmt}">${esc(FORMAT_NAMES[f] || t("rules_plain"))}</button>`).join("");
    const r = ruleRemote(ruleFmt, SITE, notes);
    $("#ruleBody").innerHTML = r
      ? `<section class="rblk"><b>${esc(t("rules_remote_h"))}</b><span class="note">${esc(t("rules_remote_s"))}</span>${codeBox(r)}</section>` +
        `<details class="rblk"><summary>${esc(t("rules_inline_h", { n }))}</summary>${codeBox(ruleInline(ruleFmt, notes))}</details>`
      : `<section class="rblk"><b>${esc(t("rules_inline_only", { n }))}</b>${codeBox(ruleInline(ruleFmt, notes))}</section>`;
  }
  $("#rulesBtn").onclick = () => { renderRules(); openDlg("rules"); };
  $("#ruleTabs").addEventListener("click", e => { const b = e.target.closest("[data-f]"); if (b) { ruleFmt = b.dataset.f; store.set(K.rules, ruleFmt); renderRules(); } });
  $("#ruleBody").addEventListener("click", e => {
    const b = e.target.closest("[data-copyta]"); if (!b) return;
    const ta = b.parentNode.querySelector("textarea");
    (navigator.clipboard ? navigator.clipboard.writeText(ta.value) : Promise.reject()).catch(() => { ta.select(); document.execCommand("copy"); })
      .finally(() => { b.textContent = t("copied"); setTimeout(() => { b.textContent = t("copy"); }, 1200); });
  });

  /* ---------- tooltips (data-why) ---------- */
  let tipEl;
  function showTip(el) {
    if (!tipEl) { tipEl = document.body.appendChild(Object.assign(document.createElement("div"), { className: "tip" })); addEventListener("scroll", () => tipEl.classList.remove("on"), { passive: true }); }
    tipEl.textContent = el.dataset.why;
    const b = el.getBoundingClientRect(), w = tipEl.offsetWidth;
    tipEl.style.left = Math.max(8, Math.min(innerWidth - w - 8, b.left + b.width / 2 - w / 2)) + "px";
    tipEl.style.top = b.bottom + 6 + "px"; tipEl.classList.add("on");
  }
  document.addEventListener("mouseover", e => { const el = e.target.closest && e.target.closest("[data-why]"); if (el) showTip(el); else if (tipEl) tipEl.classList.remove("on"); });
  document.addEventListener("focusin", e => { const el = e.target.closest && e.target.closest("[data-why]"); if (el) showTip(el); });

  /* ---------- live curves: each speed tile draws its own, behind the number ---------- */
  const SPAN = 10000, SERIES = { down: [], up: [] };
  function drawSpark(k) {
    const cv = $(k === "down" ? "#gDown .spark" : "#gUp .spark");
    const dpr = devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!W || !H) return;
    if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) { cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr); }
    const x = cv.getContext("2d"), c = getComputedStyle(document.documentElement).getPropertyValue(k === "down" ? "--ink" : "--up").trim();
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
    const s = SERIES[k];
    if (s.length < 2) return;
    const top = Math.max(1, ...s.map(p => p[1])) * 1.12;
    const px = p => Math.min(1, p[0] / SPAN) * W, py = p => H - (p[1] / top) * (H - 4);
    x.beginPath(); x.moveTo(px(s[0]), H);
    s.forEach(p => x.lineTo(px(p), py(p)));
    x.lineTo(px(s[s.length - 1]), H); x.closePath();
    const g = x.createLinearGradient(0, 0, 0, H); g.addColorStop(0, c + "40"); g.addColorStop(1, c + "00");
    x.fillStyle = g; x.fill();
    x.beginPath(); s.forEach((p, i) => i ? x.lineTo(px(p), py(p)) : x.moveTo(px(p), py(p)));
    x.strokeStyle = c; x.lineWidth = 2; x.lineJoin = "round"; x.stroke();
  }
  function drawChart() { drawSpark("down"); drawSpark("up"); }
  addEventListener("resize", drawChart);
  applyTheme(TH.includes(store.get(K.theme)) ? store.get(K.theme) : "system");

  /* ---------- the hero's slots ---------- */
  const gauge = (k, mbps, on) => {
    const g = $(k === "down" ? "#gDown" : "#gUp");
    g.querySelector(".g-v").textContent = fmtMbps(mbps);
    g.classList.toggle("on", !!on);
  };
  // a latency tile: the median (and, under load, its rise over idle), the jitter below. During a test `note` says
  // where it stands (waiting, measuring, how many samples so far); a tile with nothing yet shows "···" then.
  const latCell = (k, ms, jit, base, note) => {
    const li = $(`.lat [data-l="${k}"]`), b = li.querySelector("b"), em = li.querySelector("em");
    if (ms == null) {
      b.className = note ? "wait" : ""; b.textContent = note ? "···" : "–";
      em.innerHTML = note ? esc(note) : "&nbsp;";
      return;
    }
    b.className = "n " + msTier(ms);
    b.innerHTML = `${fmtMs(ms)}<small>ms</small>` + (base != null ? `<i>+${fmtMs(Math.max(0, ms - base))}</i>` : "");
    em.innerHTML = [jit != null && esc(t("jit_v", { ms: fmtMs(jit) })), note && esc(note)].filter(Boolean).join(" · ") || "&nbsp;";
  };
  // live, from the samples so far
  const latLive = (k, a, base) => a.length ? latCell(k, median(a), jitter(a), base, t("lat_n", { n: a.length })) : latCell(k, null, null, null, t("lat_now"));
  // the grade tile: the letter, tinted by how good it is, and the latency load adds (during a test: when it comes)
  const gradeCell = (r, note) => {
    const li = $('.lat [data-l="grade"]'), g = r ? grade(r) : "";
    li.className = gradeTier(g); g ? li.dataset.g = g : delete li.dataset.g;
    li.querySelector("b").className = !g && note ? "wait" : "";
    li.querySelector("b").textContent = g || (note ? "···" : "–");
    li.querySelector("em").innerHTML = g ? esc(t("grade_sub", { ms: fmtMs(bloat(r)) })) : note ? esc(note) : "&nbsp;";
  };
  const gradeLine = r => { const g = grade(r); return g ? esc(t("grade_" + gradeKey(g), { ms: fmtMs(bloat(r)) })) : ""; };
  const showLat = r => {
    latCell("idle", r.idle, r.jit); latCell("ldown", r.ldown, r.jdown, r.idle); latCell("lup", r.lup, r.jup, r.idle); gradeCell(r);
  };
  function showUses(r) {
    const u = uses(r);
    for (const k of USES) {
      const li = $(`#uses [data-u="${k}"]`);
      li.dataset.lv = u[k];
      li.querySelector(".lv").textContent = u[k] ? t("lv_" + u[k]) : "";
    }
  }
  const mb = bytes => bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + " GB" : Math.max(1, Math.round(bytes / 1e6)) + " MB";
  const country = cc => { if (!cc) return ""; try { return new Intl.DisplayNames([D.lang], { type: "region" }).of(cc); } catch (e) { return cc; } };
  // self-hosted flag-icons SVG (MIT), one small file per country, no third-party request; Taiwan is shown with
  // China's flag, as in the other 1ms.dog tools
  const flag = cc => /^[A-Z]{2}$/.test(cc || "") ? `<img class="flag" src="/flags/${cc === "TW" ? "cn" : cc.toLowerCase()}.svg" alt="${esc(country(cc))}" width="18" height="14">` : "";
  document.addEventListener("error", e => { if (e.target.matches && e.target.matches("img.flag")) e.target.remove(); }, true);

  /* ---------- which way the test goes: asked as the page loads, before any test ---------- */
  // The exit Cloudflare sees (/meta). The device's time zone in another country than the exit, or a data-center exit,
  // means the test isn't measuring the visitor's own line (src/net.mjs); the direct rules fix that.
  const IPQS = document.querySelector('meta[name="ipqs"]'), EGRESS = document.querySelector('meta[name="egress"]');
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ""; } })();
  const NET = { cf: null, cfDone: false, reasons: [] };
  // a link to another 1ms.dog tool: its text, then the external-link icon (the same on every tool)
  const XL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>';
  const xlink = (href, html) => `<a class="xl" href="${esc(href)}" target="_blank" rel="noopener">${html}${XL}</a>`;
  // a data value (an IP, a network) linked to its page on another tool: no icon, a dotted underline, where it goes in the title
  const dlink = (href, html, title, cls = "") => `<a class="dv${cls ? " " + cls : ""}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${html}</a>`;
  const ipLink = ip => IPQS ? dlink(IPQS.content.replace(/\/+$/, "") + D.paths[D.lang] + "?ip=" + encodeURIComponent(ip), esc(ip), t("ipqs_tip"), "ip") : `<span class="m">${esc(ip)}</span>`;
  // the other 1ms.dog tools, each linked only when the page announces it: Me2Cloud (latency to the other clouds), the
  // DNS test, ASN Lookup (the exit's network, /AS<n>), the IPv6 test (when the test went over IPv4)
  const tool = name => { const m = document.querySelector(`meta[name="${name}"]`); return m ? m.content.replace(/\/+$/, "") + D.paths[D.lang] : ""; };
  const M2C = tool("m2c"), DNS = tool("dns"), ASN = tool("asn"), IPV6 = tool("ipv6");
  function renderRel() {
    const e = NET.cf;
    const v4 = e && e.ip && !e.ip.includes(":");
    const links = [M2C && xlink(M2C, esc(t("rel_m2c"))), DNS && xlink(DNS, esc(t("rel_dns"))), IPV6 && v4 && xlink(IPV6, esc(t("rel_v6")))].filter(Boolean);
    $("#rel").innerHTML = links.join("");
    $("#rel").hidden = !links.length;
  }
  const orgHTML = e => !e.org ? "" : ` <span class="m">· ${ASN && e.asn ? dlink(ASN + "AS" + e.asn, esc(e.org), t("asn_tip", { n: e.asn })) : esc(e.org)}</span>`;
  function renderNet() {
    const e = NET.cf;
    if (NET.cfDone) {
      $("#netCf").innerHTML = !e ? `<span class="m">${esc(t("net_fail"))}</span>`
        : flag(e.cc) + esc([e.city, country(e.cc)].filter(Boolean).join(", ") || "–") + orgHTML(e) + ` <span class="m">·</span> ` + ipLink(e.ip);
      $("#netCfX").innerHTML = e && e.colo ? t("net_node", { node: flag(e.coloCc) + esc([e.coloCity, e.colo].filter(Boolean).join(" ")) }) : "";
    }
    NET.reasons = reasons(e, { tz: TZ });
    renderRel();
    const st = !NET.cfDone ? "chk" : !e ? "unk" : NET.reasons.length ? "warn" : "good";
    $("#net").dataset.st = st; $("#netSt").textContent = t("st_" + st);
    $("#rulesBtn").classList.toggle("warn", st === "warn");
    if (!RUN && !LAST) $("#noteL").innerHTML = warnHTML() || esc(t("hint_idle"));
  }
  const reasonText = r => r.k === "r_tz" ? t("r_tz", { a: esc(country(r.a)), b: esc(country(r.b)) })
    : t("r_dc", { org: esc(r.org) });
  // the warnings, the way out (the rules), and where to see which IP each site gets (EgressLens, on 1ms.dog)
  function warnHTML() {
    if (!NET.reasons.length) return "";
    const eg = EGRESS ? " " + xlink(EGRESS.content.replace(/\/+$/, "") + D.paths[D.lang], esc(t("egress_link"))) : "";
    return `<span class="warn">${NET.reasons.map(reasonText).join(" ")}</span> ` + t("r_fix", { rules: `<button type="button" data-rules>${esc(t("rules_btn"))}</button>` }) + eg;
  }
  document.addEventListener("click", e => { if (e.target.closest && e.target.closest("[data-rules]")) $("#rulesBtn").click(); });
  renderRel();
  exit().then(e => { NET.cf = e; NET.cfDone = true; renderNet(); });

  /* ---------- the test ---------- */
  let RUN = null, LAST = null, META = null;
  const R = {};                       // this run's numbers: down, up, idle, jit, ldown, lup, jdown, jup
  const TITLE = document.title;
  const phaseW = { ping: .12, down: .44, up: .44 };
  const ring = f => { $("#ring").style.strokeDasharray = `${(Math.min(1, f) * 100).toFixed(1)} 100`; };
  function progress(phase, frac, label) {
    const f = { ping: 0, down: phaseW.ping, up: phaseW.ping + phaseW.down }[phase] + phaseW[phase] * Math.min(1, frac);
    ring(f);
    $("#progTxt").textContent = label;
    post({ type: "progress", done: Math.round(f * 100), total: 100, text: label });
  }
  function setGo(state, sub) {
    $("#go").dataset.st = state;
    $("#goT").textContent = t({ idle: "start", run: "stop", done: "again" }[state]);
    $("#goS").innerHTML = sub ? esc(sub) : "&nbsp;";
  }
  function reset() {
    for (const k in R) delete R[k];
    SERIES.down = []; SERIES.up = []; drawChart();
    gauge("down", null); gauge("up", null);
    showLat({});
    showUses({}); $("#noteL").innerHTML = warnHTML() || "&nbsp;";
    ring(0); document.title = TITLE;
    LAST = null; $("#shareBtn").disabled = true;
  }

  async function start() {
    if (RUN) { RUN.abort(); return; }
    if (!$("#shared").hidden) { $("#shared").hidden = true; history.replaceState(null, "", D.paths[D.lang]); }
    const ctl = RUN = new AbortController(), sig = ctl.signal, t0 = performance.now();
    reset(); showPrev(HIST[0]); setGo("run", t("ph_ping"));
    // every tile says where it stands while the test runs
    latLive("idle", []);
    latCell("ldown", null, null, null, t("lat_wait")); latCell("lup", null, null, null, t("lat_wait"));
    gradeCell({}, t("grade_wait"));
    let bytes = 0;
    try {
      const idle = [];
      const p = await ping({ signal: sig, onSample: (ms, i, n) => {
        progress("ping", i / n, t("prog_ping", { n: i, of: n }));
        idle.push(ms); latLive("idle", idle);
      } });
      if (sig.aborted) throw new DOMException("", "AbortError");
      META = p.meta;
      R.idle = median(p.samples); R.jit = jitter(p.samples);
      latCell("idle", R.idle, R.jit);

      setGo("run", t("ph_down"));
      latLive("ldown", []);
      const d = await download({ signal: sig, onTick: s => {
        SERIES.down.push([s.ms, s.mbps]); drawSpark("down"); gauge("down", s.mbps, true);
        latLive("ldown", s.loaded, R.idle);
        document.title = "↓ " + fmtMbps(s.mbps) + " Mbps · " + TITLE;
        progress("down", s.ms / SPAN, t("prog_dir", { dir: t("k_down"), s: (s.ms / 1000).toFixed(1), mb: mb(s.bytes) }));
      } });
      bytes += d.bytes;
      if (sig.aborted) throw new DOMException("", "AbortError");
      R.down = d.mbps; gauge("down", R.down);
      R.ldown = median(d.loaded); R.jdown = jitter(d.loaded); latCell("ldown", R.ldown, R.jdown, R.idle);

      setGo("run", t("ph_up"));
      latLive("lup", []);
      const u = await upload({ signal: sig, onTick: s => {
        SERIES.up.push([s.ms, s.mbps]); drawSpark("up"); gauge("up", s.mbps, true);
        latLive("lup", s.loaded, R.idle);
        document.title = "↑ " + fmtMbps(s.mbps) + " Mbps · " + TITLE;
        progress("up", s.ms / SPAN, t("prog_dir", { dir: t("k_up"), s: (s.ms / 1000).toFixed(1), mb: mb(bytes + s.bytes) }));
      } });
      bytes += u.bytes;
      if (sig.aborted) throw new DOMException("", "AbortError");
      R.up = u.mbps; gauge("up", R.up);
      R.lup = median(u.loaded); R.jup = jitter(u.loaded); latCell("lup", R.lup, R.jup, R.idle);
      gradeCell(R);

      showUses(R);
      const lines = [gradeLine(R)].filter(Boolean);
      const cc = (NET.cf && NET.cf.cc) || META.country;
      if (cc === "CN" && !NET.reasons.length) lines.push(esc(t("cn_note")));
      if (NET.reasons.length) lines.push(warnHTML());
      $("#noteL").innerHTML = lines.join(" ") || "&nbsp;";
      ring(1);
      const peak = isPeak(new Date());
      $("#progTxt").textContent = t("done", { s: ((performance.now() - t0) / 1000).toFixed(0), mb: mb(bytes) }) + (peak ? " · " + t("peak") : "");
      document.title = `↓ ${fmtMbps(R.down)} ↑ ${fmtMbps(R.up)} Mbps · ${TITLE}`;
      LAST = { ts: Date.now(), cc: cc || "", colo: META.colo || (NET.cf && NET.cf.colo) || "", ...R };
      $("#shareBtn").disabled = false;
      saveRun({ ts: LAST.ts, ...R, ip: (NET.cf && NET.cf.ip) || META.ip || "", cc: cc || "", org: (NET.cf && NET.cf.org) || "", peak });
      setGo("done", t("used", { mb: mb(bytes) }));
      if (EMBED) {
        post({ type: "progress", done: 100, total: 100, text: $("#progTxt").textContent });
        post(checkup(cc));
      }
    } catch (e) {
      gauge("down", R.down); gauge("up", R.up); showLat(R); ring(0); document.title = TITLE;
      if (sig.aborted) { $("#progTxt").textContent = t("stopped"); setGo("idle"); }
      else { $("#progTxt").innerHTML = "&nbsp;"; $("#noteL").textContent = t("e_fail"); setGo("idle"); post({ type: "error", text: t("e_fail") }); }
    } finally {
      if (RUN === ctl) RUN = null;
    }
  }
  $("#go").onclick = start;
  $("#testMine").onclick = () => { if (!RUN) start(); };

  const autoBox = $("#auto");
  autoBox.checked = store.get(K.auto) === "1";
  autoBox.onchange = () => store.set(K.auto, autoBox.checked ? "1" : "0");

  /* ---------- history: past results, kept only in this browser (src/history.mjs) ---------- */
  let HIST = parseHist(store.get(K.hist));
  const pct = c => c == null ? "" : ` <span class="${c >= 0 ? "up" : "dn"}">${c >= 0 ? "+" : "−"}${Math.abs(c)}%</span>`;
  // under each speed: the last result, and once a test ends, the change from it
  function showPrev(prev, now) {
    for (const k of ["down", "up"]) {
      $(k === "down" ? "#gDown .g-p" : "#gUp .g-p").innerHTML = prev && prev[k] != null
        ? esc(t("prev", { v: fmtMbps(prev[k]) })) + (now ? pct(change(now[k], prev[k])) : "") : "";
    }
  }
  function saveRun(rec) {
    const prev = HIST[0];
    HIST = addHist(HIST, rec); store.set(K.hist, JSON.stringify(HIST));
    showPrev(prev, rec);
  }
  function renderHist() {
    const when = ts => new Date(ts).toLocaleString(D.lang, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
    const head = `<div class="hr"><span>${esc(t("c_time"))}</span><span>${esc(t("k_down"))}</span><span>${esc(t("k_up"))}</span><span>${esc(t("k_idle"))}</span><span>${esc(t("c_exit"))}</span></div>`;
    $("#histBody").innerHTML = HIST.length ? head + HIST.map(r => `<div class="hr"><span>${esc(when(r.ts))}${r.peak ? `<i class="pk">${esc(t("peak"))}</i>` : ""}</span>` +
      `<span>${fmtMbps(r.down)}</span><span>${fmtMbps(r.up)}</span><span>${fmtMs(r.idle)}</span><span>${flag(r.cc)}${esc(r.org || r.ip)}</span></div>`).join("")
      : `<p class="empty">${esc(t("hist_empty"))}</p>`;
    $("#histClear").hidden = !HIST.length;
  }
  $("#histBtn").onclick = () => { renderHist(); openDlg("hist"); };
  $("#histClear").onclick = () => { HIST = []; store.set(K.hist, "[]"); showPrev(null); renderHist(); };
  showPrev(HIST[0]);

  /* ---------- share: the 1ms.dog share dialog (/assets/share/, copied verbatim from 1ms-shell), loaded on use ---------- */
  // It makes the link short, draws the card's frame (logo, name, QR code, date) and offers copy, download and the
  // system share sheet; this page gives the link, the card's middle and the footer. The box adds the country and the
  // Cloudflare data center to both; the address is never in either.
  const shareLink = show => location.origin + D.paths[D.lang] + "r/" + encodeShare({ ...LAST, cc: show ? LAST.cc : "", colo: show ? LAST.colo : "" });
  // the card's middle: the two speeds, the latencies and the grade, what the line is good for
  async function drawResult(x, kit) {
    const { W, P, F, M, v, roundRect, clip, top } = kit, S = LAST, y = n => top + n;
    x.textBaseline = "alphabetic";
    const big = (label, val, at, color) => {
      x.fillStyle = color; x.font = `600 28px ${F}`; x.fillText(label, at, y(50));
      x.fillStyle = v("fg"); x.font = `700 112px ${M}`; x.fillText(fmtMbps(val), at, y(160));
      const w = x.measureText(fmtMbps(val)).width;
      x.fillStyle = v("muted"); x.font = `500 30px ${F}`; x.fillText("Mbps", at + w + 14, y(160));
    };
    big("↓ " + t("k_down"), S.down, P, v("ink")); big("↑ " + t("k_up"), S.up, P + 560, v("up"));
    const lat = [["k_idle", S.idle, S.jit], ["k_ldown", S.ldown, S.jdown], ["k_lup", S.lup, S.jup]], cw = (W - P * 2) / 4;
    x.fillStyle = v("line"); x.fillRect(P, y(210), W - P * 2, 2);
    lat.forEach(([k, ms, jit], i) => {
      const at = P + i * cw;
      x.fillStyle = v("muted"); x.font = `500 22px ${F}`; x.fillText(clip(x, t(k), cw - 16), at, y(252));
      x.fillStyle = ms == null ? v("muted") : v(msTier(ms)); x.font = `600 40px ${M}`;
      x.fillText(ms == null ? "–" : fmtMs(ms) + " ms", at, y(300));
      if (jit != null) { x.fillStyle = v("muted"); x.font = `400 19px ${F}`; x.fillText(clip(x, t("jit_v", { ms: fmtMs(jit) }), cw - 16), at, y(330)); }
    });
    const g = grade(S);
    if (g) {
      const at = P + 3 * cw, col = v(gradeTier(g));
      x.fillStyle = col + "1f"; roundRect(x, at - 14, y(222), cw - 2, 122, 14); x.fill();
      x.fillStyle = v("muted"); x.font = `500 22px ${F}`; x.fillText(clip(x, t("k_grade"), cw - 30), at, y(252));
      x.fillStyle = col; x.font = `800 48px ${F}`; x.fillText(g, at, y(304));
      x.fillStyle = v("muted"); x.font = `400 19px ${F}`; x.fillText(clip(x, t("grade_sub", { ms: fmtMs(bloat(S)) }), cw - 30), at, y(332));
    }
    const u = uses(S);
    let ux = P;
    x.font = `600 22px ${F}`;
    for (const k of USES) {
      if (!u[k]) continue;
      const label = (u[k] === "poor" ? "✕ " : "✓ ") + t("u_" + k), w = x.measureText(label).width + 32;
      if (ux + w > W - P) break;
      const col = v(u[k] === "good" ? "t1" : u[k] === "ok" ? "t3" : "t5");
      x.fillStyle = col + "22"; roundRect(x, ux, y(374), w, 46, 23); x.fill();
      x.fillStyle = col; x.fillText(label, ux + 16, y(405));
      ux += w + 12;
    }
  }
  $("#shareBtn").onclick = async () => {
    if (!LAST) return;
    const S = LAST, { share } = await import("/assets/share/share.js");
    share({
      lang: D.lang, name: t("app_name"), file: "speed-test",
      show: ["country", "colo"], never: ["ip"], canShow: !!(S.cc || S.colo),
      link: shareLink, home: location.origin + D.paths[D.lang],
      text: () => t("share_text", { down: fmtMbps(S.down), up: fmtMbps(S.up), ms: fmtMs(S.idle), grade: grade(S) || "–" }),
      height: 760, draw: drawResult,
      foot: show => [t("card_sub"), show && S.cc && country(S.cc), show && S.colo && "Cloudflare " + S.colo],
      ts: S.ts,
    }).open();
  };

  /* ---------- a shared result ---------- */
  function showShared(S) {
    reset(); showPrev(null);                // the visitor's own last result says nothing about someone else's
    gauge("down", S.down); gauge("up", S.up);
    showLat(S);
    showUses(S);
    $("#noteL").innerHTML = gradeLine(S) || "&nbsp;";
    $("#sharedTxt").textContent = t("shared_on", { where: S.cc ? t("shared_where", { where: country(S.cc) }) : "", date: new Date(S.ts).toLocaleString(D.lang, { dateStyle: "medium", timeStyle: "short" }) });
    $("#shared").hidden = false;
    LAST = S; $("#shareBtn").disabled = false;
    setGo("idle");
  }

  /* ---------- the result for the Connection Checkup ---------- */
  // the grade line as the headline; the speeds, latency and grade; what needs attention (a test that isn't measuring the
  // visitor's own line, what the line struggles with), worst first; the facts its cross-tool rules read; the share
  // link without the country and data center, as the share box starts
  function checkup(cc) {
    const plain = h => { const d = document.createElement("div"); d.innerHTML = h; return d.textContent; };
    const g = grade(R), u = uses(R), n1 = v => v == null ? undefined : Math.round(v * 10) / 10;
    const good = USES.filter(k => u[k] === "good").map(k => t("u_" + k));
    const lv = { bad: 0, warn: 1, ok: 2 };
    const findings = [
      ...NET.reasons.map(r => ({ level: "warn", text: plain(reasonText(r)) })),
      ...(cc === "CN" && !NET.reasons.length ? [{ level: "warn", text: t("cn_note") }] : []),
      ...USES.filter(k => u[k] === "poor" || u[k] === "ok").map(k => ({ level: u[k] === "poor" ? "bad" : "warn", text: t("u_" + k) + " · " + t("lv_" + u[k]) })),
      ...(good.length ? [{ level: "ok", text: new Intl.ListFormat(D.lang).format(good) + " · " + t("lv_good") }] : []),
    ].sort((a, b) => lv[a.level] - lv[b.level]).slice(0, 4);
    const facts = { down: n1(R.down), up: n1(R.up), idle: n1(R.idle), jitter: n1(R.jit), ldown: n1(R.ldown), lup: n1(R.lup), bloat: g || undefined };
    for (const k in facts) if (facts[k] === undefined) delete facts[k];
    return {
      type: "result", lang: D.lang,
      path: D.paths[D.lang] + "r/" + encodeShare({ ...LAST, cc: "", colo: "" }),
      grade: g || null, score: null,
      headline: plain(gradeLine(R)),
      stats: [
        { label: t("k_down"), value: fmtMbps(R.down) + " Mbps" }, { label: t("k_up"), value: fmtMbps(R.up) + " Mbps" },
        { label: t("k_idle"), value: fmtMs(R.idle) + " ms" }, { label: t("k_grade"), value: g || "–" },
      ],
      findings, facts,
    };
  }

  setGo("idle");
  const SP = sharePath(location.pathname), SHARED = SP && decodeShare(SP.code);
  if (EMBED) start();
  else if (SHARED) showShared(SHARED);
  else if (autoBox.checked) start();
})();
