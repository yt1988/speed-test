// Speed Test page. Waits for Start unless the visitor turned on testing when the page opens (remembered here).
// Order: idle latency, download, upload (src/measure.mjs), each shown live in the hero's fixed slots; at the end what
// the line is good for and how much latency load adds. M-Lab's single-connection test runs only when asked
// (src/mlab.mjs). Strings: window.L1MS.
import { ping, download, upload, median, jitter } from "./measure.mjs";
import * as ndt from "./mlab.mjs";
import { fmtMbps, fmtMs, msTier, speedTier, bloat, bloatLevel, uses, USES } from "./verdict.mjs";
import { FORMATS, FORMAT_NAMES, items as ruleItems, inline as ruleInline, remote as ruleRemote } from "./rules.mjs";
import { encode as encodeShare, decode as decodeShare, sharePath } from "./share.mjs";

(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent);
  const L = window.L1MS || {};
  const t = (k, v) => { let s = L[k] ?? k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  const esc = s => String(s ?? "").replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  const K = { theme: "speedtest:theme", lang: "speedtest:lang", rules: "speedtest:rules", auto: "speedtest:auto" };

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

  /* ---------- the live chart: download on the left half, upload on the right ---------- */
  const chart = $("#chart"), SERIES = { down: [], up: [] }, SPAN = 10000;
  function drawChart() {
    if (!chart) return;
    const dpr = devicePixelRatio || 1, W = chart.clientWidth, H = chart.clientHeight;
    if (!W) return;
    if (chart.width !== Math.round(W * dpr)) { chart.width = Math.round(W * dpr); chart.height = Math.round(H * dpr); }
    const x = chart.getContext("2d"), css = getComputedStyle(document.documentElement), v = n => css.getPropertyValue("--" + n).trim();
    x.setTransform(dpr, 0, 0, dpr, 0, 0); x.clearRect(0, 0, W, H);
    const all = [...SERIES.down, ...SERIES.up].map(p => p[1]), top = Math.max(1, ...all) * 1.15, half = W / 2;
    x.fillStyle = v("line"); x.fillRect(half - .5, 6, 1, H - 12); x.fillRect(0, H - 1, W, 1);
    [["down", 0, v("ink")], ["up", half + 1, v("up")]].forEach(([k, x0, c]) => {
      const s = SERIES[k];
      if (s.length < 2) return;
      const px = p => x0 + Math.min(1, p[0] / SPAN) * (half - 2), py = p => H - 2 - (p[1] / top) * (H - 10);
      x.beginPath(); x.moveTo(px(s[0]), H - 1);
      s.forEach(p => x.lineTo(px(p), py(p)));
      x.lineTo(px(s[s.length - 1]), H - 1); x.closePath();
      x.fillStyle = c + "26"; x.fill();
      x.beginPath(); s.forEach((p, i) => i ? x.lineTo(px(p), py(p)) : x.moveTo(px(p), py(p)));
      x.strokeStyle = c; x.lineWidth = 1.6; x.lineJoin = "round"; x.stroke();
    });
  }
  addEventListener("resize", () => drawChart());
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
  const country = cc => { try { return new Intl.DisplayNames([D.lang], { type: "region" }).of(cc); } catch (e) { return cc; } };

  // where the test ran: the data center, the visitor's network and address (the address links to the IP quality
  // check on 1ms.dog)
  const IPQS = document.querySelector('meta[name="ipqs"]');
  // Cloudflare names the data center and network (cf-meta-colo, -asn) only for some visitors; the address always
  function showWhere(m) {
    const parts = [];
    if (m.colo) parts.push(t("where_colo", { colo: `<b>${esc(m.colo)}</b>` }));
    if (m.asn) parts.push(t("where_net", { asn: `<b>AS${esc(m.asn)}</b>` }));
    if (m.ip) parts.push(t("where_ip", { ip: IPQS ? `<a href="${esc(IPQS.content.replace(/\/+$/, "") + D.paths[D.lang] + "?ip=" + encodeURIComponent(m.ip))}" target="_blank" rel="noopener" title="${esc(t("ipqs_tip"))}">${esc(m.ip)} ↗</a>` : `<b>${esc(m.ip)}</b>` }));
    if (m.country) parts.push(esc(country(m.country)));
    $("#where").innerHTML = parts.join('<span class="dot">·</span>') || "&nbsp;";
  }
  // the visitor's country, from Cloudflare's trace on this site (it serves the page): for the mainland China note,
  // when the test server's headers don't carry it
  let CC = "";
  fetch("/cdn-cgi/trace", { cache: "no-store" }).then(r => r.ok ? r.text() : "").then(s => { const m = /\bloc=([A-Z]{2})/.exec(s); if (m) CC = m[1]; }).catch(() => {});

  /* ---------- the test ---------- */
  let RUN = null, LAST = null, META = null;
  const R = {};                       // this run's numbers: down, up, idle, jit, ldown, lup
  const phaseW = { ping: .12, down: .44, up: .44 };
  function progress(phase, frac, label) {
    const done = { ping: 0, down: phaseW.ping, up: phaseW.ping + phaseW.down }[phase] + phaseW[phase] * Math.min(1, frac);
    $("#prog i").style.transform = `scaleX(${done})`;
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
    showUses({}); $("#noteL").innerHTML = "&nbsp;";
    $("#prog").classList.remove("end");
    LAST = null; $("#shareBtn").disabled = true;
  }

  async function start() {
    if (RUN) { RUN.abort(); return; }
    if (!$("#shared").hidden) { $("#shared").hidden = true; history.replaceState(null, "", D.paths[D.lang]); }
    const ctl = RUN = new AbortController(), sig = ctl.signal, t0 = performance.now();
    reset(); setGo("run", t("ph_ping")); $("#mlRun").disabled = true;
    let bytes = 0;
    try {
      const p = await ping({ signal: sig, onSample: (ms, i, n) => progress("ping", i / n, t("prog_ping", { n: i, of: n })) });
      if (sig.aborted) throw new DOMException("", "AbortError");
      META = p.meta; if (!META.country && /^[A-Z]{2}$/.test(CC) && CC !== "XX") META.country = CC; showWhere(META);
      R.idle = median(p.samples); R.jit = jitter(p.samples);
      latCell("idle", R.idle); latCell("jit", R.jit);

      setGo("run", t("ph_down"));
      const d = await download({ signal: sig, onTick: s => {
        SERIES.down.push([s.ms, s.mbps]); drawChart(); gauge("down", s.mbps, true);
        progress("down", s.ms / SPAN, t("prog_dir", { dir: t("k_down"), s: (s.ms / 1000).toFixed(1), mb: mb(s.bytes) }));
      } });
      bytes += d.bytes;
      if (sig.aborted) throw new DOMException("", "AbortError");
      R.down = d.mbps; gauge("down", R.down);
      R.ldown = median(d.loaded); latCell("ldown", R.ldown, R.idle);

      setGo("run", t("ph_up"));
      const u = await upload({ signal: sig, onTick: s => {
        SERIES.up.push([s.ms, s.mbps]); drawChart(); gauge("up", s.mbps, true);
        progress("up", s.ms / SPAN, t("prog_dir", { dir: t("k_up"), s: (s.ms / 1000).toFixed(1), mb: mb(bytes + s.bytes) }));
      } });
      bytes += u.bytes;
      if (sig.aborted) throw new DOMException("", "AbortError");
      R.up = u.mbps; gauge("up", R.up);
      R.lup = median(u.loaded); latCell("lup", R.lup, R.idle);

      showUses(R);
      const b = bloat(R), lines = [];
      if (b != null) lines.push(t("bloat_" + bloatLevel(b), { ms: fmtMs(b) }));
      if (META && META.country === "CN") lines.push(t("cn_note"));
      $("#noteL").innerHTML = lines.map(esc).join(" ") || "&nbsp;";
      $("#prog").classList.add("end");
      $("#progTxt").textContent = t("done", { s: ((performance.now() - t0) / 1000).toFixed(0), mb: mb(bytes) });
      LAST = { ts: Date.now(), cc: META ? META.country : "", colo: META ? META.colo : "", ...R };
      $("#shareBtn").disabled = false;
      setGo("done", t("used", { mb: mb(bytes) }));
    } catch (e) {
      gauge("down", R.down); gauge("up", R.up);
      $("#prog").classList.add("end");
      if (sig.aborted) { $("#progTxt").textContent = t("stopped"); setGo("idle"); }
      else { $("#progTxt").innerHTML = "&nbsp;"; $("#noteL").textContent = t("e_fail"); setGo("idle"); }
    } finally {
      if (RUN === ctl) RUN = null;
      $("#mlRun").disabled = false;
    }
  }
  $("#go").onclick = start;
  $("#testMine").onclick = () => { if (!RUN) start(); };

  const autoBox = $("#auto");
  autoBox.checked = store.get(K.auto) === "1";
  autoBox.onchange = () => store.set(K.auto, autoBox.checked ? "1" : "0");

  /* ---------- M-Lab: a second opinion, from a server outside the visitor's ISP, on one connection ---------- */
  let ML = null;
  const mlCell = (k, html) => { $(`.ml-m [data-m="${k}"] b`).innerHTML = html; };
  async function runMlab() {
    if (RUN) return;
    if (ML) { ML.abort(); return; }
    const ctl = ML = new AbortController();
    $("#go").disabled = true; $("#mlRun").textContent = t("stop");
    ["down", "up", "rtt", "srv"].forEach(k => mlCell(k, "–"));
    $("#mlNote").textContent = t("ml_locating");
    try {
      const s = await ndt.locate(ctl.signal);
      mlCell("srv", esc([s.city || s.site, s.country].filter(Boolean).join(", ") || s.machine));
      $("#mlNote").textContent = t("ph_down");
      const d = await ndt.download(s.down, { signal: ctl.signal, onTick: x => mlCell("down", `<span class="n">${fmtMbps(x.mbps)}</span><small>Mbps</small>`) });
      if (ctl.signal.aborted) throw new Error("stopped");
      mlCell("down", `<span class="n">${fmtMbps(d.mbps)}</span><small>Mbps</small>`);
      if (d.minRtt != null) mlCell("rtt", `<span class="n ${msTier(d.minRtt)}">${fmtMs(d.minRtt)}</span><small>ms</small>`);
      $("#mlNote").textContent = t("ph_up");
      const u = await ndt.upload(s.up, { signal: ctl.signal, onTick: x => mlCell("up", `<span class="n">${fmtMbps(x.mbps)}</span><small>Mbps</small>`) });
      if (ctl.signal.aborted) throw new Error("stopped");
      mlCell("up", `<span class="n">${fmtMbps(u.mbps)}</span><small>Mbps</small>`);
      $("#mlNote").textContent = t("ml_done");
    } catch (e) {
      $("#mlNote").textContent = ctl.signal.aborted ? t("stopped") : t("ml_fail");
    } finally {
      ML = null; $("#go").disabled = false; $("#mlRun").textContent = t("ml_run");
    }
  }
  $("#mlRun").onclick = runMlab;

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
    reset();
    gauge("down", S.down); gauge("up", S.up);
    latCell("idle", S.idle); latCell("jit", S.jit); latCell("ldown", S.ldown, S.idle); latCell("lup", S.lup, S.idle);
    showUses(S);
    showWhere({ colo: S.colo, country: S.cc });
    $("#sharedTxt").textContent = t("shared_on", { where: S.cc ? t("shared_where", { where: country(S.cc) }) : "", date: new Date(S.ts).toLocaleString(D.lang, { dateStyle: "medium", timeStyle: "short" }) });
    $("#shared").hidden = false;
    $("#prog").classList.add("end");
    LAST = S; $("#shareBtn").disabled = false;
    setGo("idle");
  }

  setGo("idle");
  const SP = sharePath(location.pathname), SHARED = SP && decodeShare(SP.code);
  if (SHARED) showShared(SHARED);
  else if (autoBox.checked) start();
})();
