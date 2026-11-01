// Speed Test page. Waits for Start unless the visitor turned on testing when the page opens (remembered here).
// Order: idle latency, download, upload (src/measure.mjs), each shown live in the hero's fixed slots; at the end what
// the line is good for and how much latency load adds. Strings: window.L1MS.
import { ping, download, upload, median, jitter, exit } from "./measure.mjs";
import { reasons } from "./net.mjs";
import { fmtMbps, fmtMs, msTier, speedTier, bloat, bloatLevel, uses, USES } from "./verdict.mjs";
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
  const latCell = (k, ms, base) => {
    const b = $(`.lat [data-l="${k}"] b`);
    if (ms == null) { b.className = ""; b.textContent = "–"; return; }
    b.className = "n " + (k === "jit" ? msTier(ms * 4) : msTier(ms));
    b.innerHTML = `${fmtMs(ms)}<small>ms</small>` + (base != null ? `<i>+${fmtMs(Math.max(0, ms - base))}</i>` : "");
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
  const ipLink = ip => IPQS ? `<a href="${esc(IPQS.content.replace(/\/+$/, "") + D.paths[D.lang] + "?ip=" + encodeURIComponent(ip))}" target="_blank" rel="noopener" title="${esc(t("ipqs_tip"))}">${esc(ip)}</a>` : `<span class="m">${esc(ip)}</span>`;
  function renderNet() {
    const e = NET.cf;
    if (NET.cfDone) {
      $("#netCf").innerHTML = !e ? `<span class="m">${esc(t("net_fail"))}</span>`
        : flag(e.cc) + esc([e.city, country(e.cc)].filter(Boolean).join(", ") || "–") + (e.org ? ` <span class="m">· ${esc(e.org)}</span>` : "") + ` <span class="m">·</span> ` + ipLink(e.ip);
      $("#netCfX").innerHTML = e && e.colo ? t("net_node", { node: flag(e.coloCc) + esc([e.coloCity, e.colo].filter(Boolean).join(" ")) }) : "";
    }
    NET.reasons = reasons(e, { tz: TZ });
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
    const eg = EGRESS ? ` <a href="${esc(EGRESS.content.replace(/\/+$/, "") + D.paths[D.lang])}" target="_blank" rel="noopener">${esc(t("egress_link"))} ↗</a>` : "";
    return `<span class="warn">${NET.reasons.map(reasonText).join(" ")}</span> ` + t("r_fix", { rules: `<button type="button" data-rules>${esc(t("rules_btn"))}</button>` }) + eg;
  }
  document.addEventListener("click", e => { if (e.target.closest && e.target.closest("[data-rules]")) $("#rulesBtn").click(); });
  exit().then(e => { NET.cf = e; NET.cfDone = true; renderNet(); });

  /* ---------- the test ---------- */
  let RUN = null, LAST = null, META = null;
  const R = {};                       // this run's numbers: down, up, idle, jit, ldown, lup
  const TITLE = document.title;
  const phaseW = { ping: .12, down: .44, up: .44 };
  const ring = f => { $("#ring").style.strokeDasharray = `${(Math.min(1, f) * 100).toFixed(1)} 100`; };
  function progress(phase, frac, label) {
    ring({ ping: 0, down: phaseW.ping, up: phaseW.ping + phaseW.down }[phase] + phaseW[phase] * Math.min(1, frac));
    $("#progTxt").textContent = label;
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
    ["idle", "jit", "ldown", "lup"].forEach(k => latCell(k, null));
    showUses({}); $("#noteL").innerHTML = warnHTML() || "&nbsp;";
    ring(0); document.title = TITLE;
    LAST = null; $("#shareBtn").disabled = true;
  }

  async function start() {
    if (RUN) { RUN.abort(); return; }
    if (!$("#shared").hidden) { $("#shared").hidden = true; history.replaceState(null, "", D.paths[D.lang]); }
    const ctl = RUN = new AbortController(), sig = ctl.signal, t0 = performance.now();
    reset(); showPrev(HIST[0]); setGo("run", t("ph_ping"));
    let bytes = 0;
    try {
      const p = await ping({ signal: sig, onSample: (ms, i, n) => progress("ping", i / n, t("prog_ping", { n: i, of: n })) });
      if (sig.aborted) throw new DOMException("", "AbortError");
      META = p.meta;
      R.idle = median(p.samples); R.jit = jitter(p.samples);
      latCell("idle", R.idle); latCell("jit", R.jit);

      setGo("run", t("ph_down"));
      const d = await download({ signal: sig, onTick: s => {
        SERIES.down.push([s.ms, s.mbps]); drawSpark("down"); gauge("down", s.mbps, true);
        document.title = "↓ " + fmtMbps(s.mbps) + " Mbps · " + TITLE;
        progress("down", s.ms / SPAN, t("prog_dir", { dir: t("k_down"), s: (s.ms / 1000).toFixed(1), mb: mb(s.bytes) }));
      } });
      bytes += d.bytes;
      if (sig.aborted) throw new DOMException("", "AbortError");
      R.down = d.mbps; gauge("down", R.down);
      R.ldown = median(d.loaded); latCell("ldown", R.ldown, R.idle);

      setGo("run", t("ph_up"));
      const u = await upload({ signal: sig, onTick: s => {
        SERIES.up.push([s.ms, s.mbps]); drawSpark("up"); gauge("up", s.mbps, true);
        document.title = "↑ " + fmtMbps(s.mbps) + " Mbps · " + TITLE;
        progress("up", s.ms / SPAN, t("prog_dir", { dir: t("k_up"), s: (s.ms / 1000).toFixed(1), mb: mb(bytes + s.bytes) }));
      } });
      bytes += u.bytes;
      if (sig.aborted) throw new DOMException("", "AbortError");
      R.up = u.mbps; gauge("up", R.up);
      R.lup = median(u.loaded); latCell("lup", R.lup, R.idle);

      showUses(R);
      const b = bloat(R), lines = [];
      if (b != null) lines.push(esc(t("bloat_" + bloatLevel(b), { ms: fmtMs(b) })));
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
    } catch (e) {
      gauge("down", R.down); gauge("up", R.up); ring(0); document.title = TITLE;
      if (sig.aborted) { $("#progTxt").textContent = t("stopped"); setGo("idle"); }
      else { $("#progTxt").innerHTML = "&nbsp;"; $("#noteL").textContent = t("e_fail"); setGo("idle"); }
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

  /* ---------- share: a link that carries the result, an image drawn here, the system share sheet ---------- */
  const shareLink = () => {
    const where = $("#shareCc").checked;
    return location.origin + D.paths[D.lang] + "r/" + encodeShare({ ...LAST, cc: where ? LAST.cc : "", colo: where ? LAST.colo : "" });
  };
  let shortFor = null;
  async function shortLink(long) {
    const meta = document.querySelector('meta[name="shortener"]');          // present on 1ms.dog; absent when self-hosted
    if (!meta) return long;
    if (shortFor && shortFor[0] === long) return shortFor[1];
    try {
      const r = await fetch(meta.content, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ url: long }), signal: AbortSignal.timeout(5000) });
      const j = await r.json(); if (j.url) { shortFor = [long, j.url]; return j.url; }
    } catch (e) {}
    return long;
  }
  let shareBlob = null, shareRun = 0;
  async function prepareShare() {
    const run = ++shareRun, long = shareLink();
    $("#shareUrl").value = long; $("#shareImg").removeAttribute("src"); shareBlob = null;
    loadQR().catch(() => {});
    const url = await shortLink(long);
    if (run !== shareRun) return;
    $("#shareUrl").value = url;
    // the QR code carries the short link; a long one would be too dense to scan, so then it points at the page
    const c = await drawCard(url.length <= 300 ? url : location.origin + D.paths[D.lang]).catch(() => null);
    if (!c || run !== shareRun) return;
    $("#shareImg").src = c.toDataURL("image/png"); c.toBlob(b => { shareBlob = b; }, "image/png");
  }
  $("#shareBtn").onclick = () => {
    if (!LAST) return;
    $("#shareCc").disabled = !LAST.cc && !LAST.colo;
    $("#nativeShare").hidden = !navigator.share;
    openDlg("shareDlg");
    prepareShare();
  };
  $("#shareCc").onchange = prepareShare;
  let qrP = null;
  const loadQR = () => qrP ||= new Promise((res, rej) => {
    const el = document.createElement("script"); el.src = QR_JS;
    el.onload = () => res(self.QR1MS); el.onerror = () => { qrP = null; rej(); };
    document.head.appendChild(el);
  });
  const flash = (btn, k) => { const o = btn.textContent; btn.textContent = t(k); setTimeout(() => { btn.textContent = o; }, 1500); };
  $("#copyLink").onclick = async e => { try { await navigator.clipboard.writeText($("#shareUrl").value); flash(e.target, "copied"); } catch (x) { $("#shareUrl").select(); } };
  $("#copyImg").onclick = async e => { try { await navigator.clipboard.write([new ClipboardItem({ "image/png": shareBlob })]); flash(e.target, "copied"); } catch (x) {} };
  $("#dlImg").onclick = () => { const a = document.createElement("a"); a.href = $("#shareImg").src; a.download = "speed-test.png"; a.click(); };
  $("#nativeShare").onclick = async () => {
    const text = t("share_text", { down: fmtMbps(LAST.down), up: fmtMbps(LAST.up), ms: fmtMs(LAST.idle) });
    const file = shareBlob && new File([shareBlob], "speed-test.png", { type: "image/png" });
    try { await navigator.share(file && navigator.canShare && navigator.canShare({ files: [file] }) ? { text, url: $("#shareUrl").value, files: [file] } : { text, url: $("#shareUrl").value }); } catch (e) {}
  };

  // The card: brand, the two speeds, the latencies, what the line is good for, a QR code for the link; in the page's
  // own theme. Country and data center only when the visitor ticked the box.
  const img = src => new Promise((res, rej) => { const i = new Image(); i.onload = () => res(i); i.onerror = rej; i.src = src; });
  function roundRect(x, a, b, w, h, r) { x.beginPath(); x.moveTo(a + r, b); x.arcTo(a + w, b, a + w, b + h, r); x.arcTo(a + w, b + h, a, b + h, r); x.arcTo(a, b + h, a, b, r); x.arcTo(a, b, a + w, b, r); x.closePath(); }
  function clip(x, s, w) { if (x.measureText(s).width <= w) return s; while (s && x.measureText(s + "…").width > w) s = s.slice(0, -1); return s + "…"; }
  async function drawCard(link) {
    const W = 1200, H = 760, P = 56, where = $("#shareCc").checked, S = LAST;
    const F = "Geist, 'PingFang SC', 'Microsoft YaHei', 'Hiragino Sans', 'Malgun Gothic', sans-serif", M = "'Geist Mono', Consolas, monospace";
    const css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue("--" + n).trim(), dark = css.colorScheme === "dark";
    const c = document.createElement("canvas"); c.width = W; c.height = H;
    const x = c.getContext("2d");
    x.fillStyle = v("bg"); x.fillRect(0, 0, W, H);
    const logo = await img(dark ? "/assets/logo-dark.svg" : "/assets/logo-light.svg");
    x.drawImage(logo, P, 40, 150, 60);
    x.textBaseline = "alphabetic";
    x.fillStyle = v("muted"); x.font = `600 24px ${F}`; x.fillText(t("app_name") + "  ·  " + location.host, P + 170, 80);
    const QS = 150;
    const qr = link && await loadQR().then(Q => { const q = Q(0, "M"); q.addData(link); q.make(); return q; }).catch(() => null);
    if (qr) {
      const n = qr.getModuleCount(), s = (QS - 16) / n, qx = W - P - QS, qy = 36;
      x.fillStyle = "#fff"; roundRect(x, qx, qy, QS, QS, 12); x.fill();
      x.fillStyle = "#111";
      for (let i = 0; i < n; i++) for (let j = 0; j < n; j++) if (qr.isDark(i, j)) x.fillRect(qx + 8 + j * s, qy + 8 + i * s, s + .3, s + .3);
    }
    // the two speeds
    const big = (label, val, at, color) => {
      x.fillStyle = color; x.font = `600 28px ${F}`; x.fillText(label, at, 250);
      x.fillStyle = v("fg"); x.font = `700 112px ${M}`; x.fillText(fmtMbps(val), at, 360);
      const w = x.measureText(fmtMbps(val)).width;
      x.fillStyle = v("muted"); x.font = `500 30px ${F}`; x.fillText("Mbps", at + w + 14, 360);
    };
    big("↓ " + t("k_down"), S.down, P, v("ink")); big("↑ " + t("k_up"), S.up, P + 560, v("up"));
    // the latencies
    const lat = [["k_idle", S.idle], ["k_jit", S.jit], ["k_ldown", S.ldown], ["k_lup", S.lup]], cw = (W - P * 2) / 4;
    x.fillStyle = v("line"); x.fillRect(P, 410, W - P * 2, 2);
    lat.forEach(([k, ms], i) => {
      const at = P + i * cw;
      x.fillStyle = v("muted"); x.font = `500 22px ${F}`; x.fillText(clip(x, t(k), cw - 16), at, 460);
      x.fillStyle = ms == null ? v("muted") : v(k === "k_jit" ? msTier(ms * 4) : msTier(ms)); x.font = `600 40px ${M}`;
      x.fillText(ms == null ? "–" : fmtMs(ms) + " ms", at, 510);
    });
    // what it's good for
    const u = uses(S);
    let ux = P;
    x.font = `600 22px ${F}`;
    for (const k of USES) {
      if (!u[k]) continue;
      const label = (u[k] === "poor" ? "✕ " : "✓ ") + t("u_" + k), w = x.measureText(label).width + 32;
      if (ux + w > W - P) break;
      const col = v(u[k] === "good" ? "t1" : u[k] === "ok" ? "t3" : "t5");
      x.fillStyle = col + "22"; roundRect(x, ux, 560, w, 46, 23); x.fill();
      x.fillStyle = col; x.fillText(label, ux + 16, 591);
      ux += w + 12;
    }
    x.fillStyle = v("muted"); x.font = `400 20px ${F}`;
    const foot = [t("card_sub"), new Date(S.ts).toLocaleDateString(D.lang), where && S.cc && country(S.cc), where && S.colo && "Cloudflare " + S.colo].filter(Boolean).join("  ·  ");
    x.fillText(clip(x, foot, W - P * 2), P, H - 34);
    return c;
  }

  /* ---------- a shared result ---------- */
  function showShared(S) {
    reset(); showPrev(null);                // the visitor's own last result says nothing about someone else's
    gauge("down", S.down); gauge("up", S.up);
    latCell("idle", S.idle); latCell("jit", S.jit); latCell("ldown", S.ldown, S.idle); latCell("lup", S.lup, S.idle);
    showUses(S);
    const b = bloat(S);
    $("#noteL").innerHTML = b != null ? esc(t("bloat_" + bloatLevel(b), { ms: fmtMs(b) })) : "&nbsp;";
    $("#sharedTxt").textContent = t("shared_on", { where: S.cc ? t("shared_where", { where: country(S.cc) }) : "", date: new Date(S.ts).toLocaleString(D.lang, { dateStyle: "medium", timeStyle: "short" }) });
    $("#shared").hidden = false;
    LAST = S; $("#shareBtn").disabled = false;
    setGo("idle");
  }

  setGo("idle");
  const SP = sharePath(location.pathname), SHARED = SP && decodeShare(SP.code);
  if (SHARED) showShared(SHARED);
  else if (autoBox.checked) start();
})();
