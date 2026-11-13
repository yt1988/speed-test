// Speed Test page. Waits for Start unless the visitor turned on testing when the page opens (remembered here).
// Order: idle latency, download, upload (src/measure.mjs), each shown live in the hero's fixed slots; at the end what
// the line is good for and the bufferbloat grade (how much latency load adds). Strings: window.L1MS.
import { CF, ping, download, upload, median, jitter, exit } from "./measure.mjs";
import { reasons, fromMe } from "./net.mjs";
import { fmtMbps, fmtMs, msTier, speedTier, bloat, grade, gradeKey, gradeTier, uses, USES } from "./verdict.mjs";
import { FORMATS, FORMAT_NAMES, items as ruleItems, inline as ruleInline, remote as ruleRemote } from "./rules.mjs";
import { parse as parseHist, add as addHist, change, isPeak } from "./history.mjs";
import { encode as encodeShare, decode as decodeShare, sharePath } from "./share.mjs";
import { udp, quic } from "./rtc.mjs";

(function () {
  "use strict";
  const $ = s => document.querySelector(s), $$ = s => [...document.querySelectorAll(s)];
  const D = JSON.parse($("#data").textContent);
  const L = window.L1MS || {};
  const t = (k, v) => { let s = L[k] ?? k; if (v) for (const x in v) s = s.split("{" + x + "}").join(v[x]); return s; };
  // a sentence with a count: key_one, key_few… by the language's plural rule, else the key itself
  // (1ms-shell translation.md section 2, "Plurals")
  const PR = new Intl.PluralRules(D.lang);
  const tn = (k, n, v) => { const p = k + "_" + PR.select(n); return t(p in L ? p : k, { n, ...v }); };
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
  const latLive = (k, a, base) => a.length ? latCell(k, median(a), jitter(a), base, tn("lat_n", a.length)) : latCell(k, null, null, null, t("lat_now"));
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
  // the UDP and QUIC row, to rtc.1ms.dog in Tokyo: only on speed.1ms.dog (and its local copy), where that server is
  const RTC_ON = /^(speed\.1ms\.dog|localhost|127\.0\.0\.1)$/.test(location.hostname) && typeof RTCPeerConnection === "function";
  if (RTC_ON) $("#udp").hidden = false;
  const udpCell = (k, val, em, cls) => {
    const li = $(`#udp [data-u="${k}"]`), b = li.querySelector("b");
    b.className = cls || ""; b.innerHTML = val; li.querySelector("em").innerHTML = em || "&nbsp;";
  };
  const lossTier = p => p < 1 ? "t1" : p < 3 ? "t3" : "t5";
  const fmtPct = p => p < 0.05 ? "0" : p < 10 ? p.toFixed(1) : String(Math.round(p));
  const udpClear = () => { for (const k of [0, 1, 2, "q"]) udpCell(k, "–"); };
  const lossCell = (k, p, n) => udpCell(k, `${fmtPct(p.loss)}<small>%</small>`,
    [p.jit != null && esc(t("jit_v", { ms: fmtMs(p.jit) })), n && esc(tn("lat_n", n))].filter(Boolean).join(" · "), "n " + lossTier(p.loss));
  // during a test, every 0.5 s from the packets so far: each phase that has some shows its loss and jitter, the one
  // being measured says how many; the others wait their turn. UDP that never connected says why at once.
  function udpLive(U, now) {
    if (U.state === "blocked" || U.state === "down") { for (const k of [0, 1, 2]) udpCell(k, "–", esc(t(U.state === "blocked" ? "udp_blocked" : "rtc_down"))); return; }
    const l = U.live();
    for (const k of [0, 1, 2]) {
      if (l && l[k]) lossCell(k, l[k], k === now && l[k].n);
      else udpCell(k, "···", esc(t(k === now ? "lat_now" : "lat_wait")), "wait");
    }
  }
  function showLoss(u) {
    const lossMax = Math.max(0, ...((u.state === "open" && u.phases) || []).filter(Boolean).map(p => p.loss));
    if (laggy(R, lossMax)) { addLag(); addPing(); }
    for (const k of [0, 1, 2]) {
      const p = u.phases && u.phases[k];
      if (u.state !== "open") udpCell(k, "–", esc(t(u.state === "blocked" ? "udp_blocked" : "rtc_down")));
      else if (!p) udpCell(k, "–");
      else lossCell(k, p);
    }
  }
  function showQuic(q) {
    const v = q.verdict, ms = { q: q.wt && fmtMs(q.wt.rtt), t: q.ws && fmtMs(q.ws.rtt) };
    if (v === "na") udpCell("q", esc(t("quic_na")), esc(t("quic_na_em")), "w");
    else if (v === "down") udpCell("q", "–", esc(t("rtc_down")));
    else if (v === "blocked") udpCell("q", esc(t("quic_blocked")), esc(t("quic_blocked_em", ms)), "w t5");
    else udpCell("q", esc(t(v === "ok" ? "quic_ok" : "quic_slow")), esc(t("quic_em", ms)), "w " + (v === "ok" ? "t1" : "t3"));
  }
  // The row runs beside Cloudflare's test, not after it: UDP from the start (live, above), QUIC against TCP in the
  // first seconds, shown as soon as it's known. When the test ends, the last packets get 1.5 s to come back, then
  // the final loss (with the server's count). A new test started meanwhile (RTC_N moved on) owns the row.
  let RTC_N = 0;
  function startRtc(run) {
    let U = null;
    try { U = udp(); } catch (e) { udpClear(); return null; }
    let now = 0;
    const live = setInterval(() => { if (run === RTC_N) udpLive(U, now); }, 500);
    udpLive(U, 0); udpCell("q", "···", esc(t("lat_now")), "wait");
    const Q = quic().catch(() => ({ verdict: "down" }));
    Q.then(q => { if (run === RTC_N) showQuic(q); });
    return {
      phase(p) { now = p; U.phase(p); udpLive(U, p); },
      // the test is done: final loss, and both for the checkup report
      async done() { clearInterval(live); const [u, q] = await Promise.all([U.stop(), Q]); if (run === RTC_N) showLoss(u); return { u, q }; },
      // stopped or failed: nothing to show
      cancel() { clearInterval(live); U.stop().catch(() => {}); udpClear(); },
    };
  }
  function showUses(r) {
    const u = uses(r);
    for (const k of USES) {
      const li = $(`#uses [data-u="${k}"]`);
      li.dataset.lv = u[k];
      li.querySelector(".lv").textContent = u[k] ? t("lv_" + u[k]) : "";
    }
  }
  const mb = bytes => bytes >= 1e9 ? (bytes / 1e9).toFixed(2) + " GB" : Math.max(1, Math.round(bytes / 1e6)) + " MB";
  // names and flags as in the other 1ms.dog tools (1ms-shell tool-contract.md section 5): Intl.DisplayNames and the
  // self-hosted flag-icons SVG (MIT), no third-party request; TW alone has a fixed name and the cn flag
  const TW = { "zh-CN": "中国台湾", "zh-TW": "中國台灣", en: "Taiwan, China", ja: "中国台湾", ko: "중국 대만", es: "Taiwán, China", fr: "Taïwan, Chine", de: "Taiwan, China", pt: "Taiwan, China", ru: "Тайвань, Китай" };
  const regionName = (cc, lang) => cc === "TW" ? TW[lang] : new Intl.DisplayNames([lang], { type: "region" }).of(cc);
  const flagCode = cc => cc === "TW" ? "cn" : cc.toLowerCase();
  const country = cc => { if (!cc) return ""; try { return regionName(cc, D.lang); } catch (e) { return cc; } };
  const flag = cc => /^[A-Z]{2}$/.test(cc || "") ? `<img class="flag" src="/flags/${flagCode(cc)}.svg" alt="${esc(country(cc))}" width="18" height="14">` : "";
  document.addEventListener("error", e => { if (e.target.matches && e.target.matches("img.flag")) e.target.remove(); }, true);

  /* ---------- which way the test goes: asked as the page loads, before any test ---------- */
  // The exit Cloudflare sees: first from 1ms-shell's /_ms/me on this page's host, then from the test's own host (/meta,
  // which the test reaches anyway). The test host's answer wins when its address differs (a proxy that splits by
  // host, or the direct rules in use: what counts is the way the test goes) and adds its data center's city.
  // The device's time zone in another country than the exit, or a data-center exit, means the test isn't measuring
  // the visitor's own line (src/net.mjs); the direct rules fix that.
  const IPQS = document.querySelector('meta[name="ipqs"]'), EGRESS = document.querySelector('meta[name="egress"]');
  const TZ = (() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone; } catch (e) { return ""; } })();
  const NET = { cf: null, cfDone: false, reasons: [] };
  // a link to another 1ms.dog tool: its text, then the external-link icon (the same on every tool)
  const XL = '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M9 2.5h4.5V7M13.5 2.5 7.5 8.5M12 10v3.5H2.5V4H6"/></svg>';
  const xlink = (href, html) => `<a class="xl" href="${esc(href)}" target="_blank" rel="noopener">${html}${XL}</a>`;
  // a data value (an IP, a network) linked to its page on another tool: no icon, a dotted underline, where it goes in the title
  const dlink = (href, html, title, cls = "") => `<a class="dv${cls ? " " + cls : ""}" href="${esc(href)}" target="_blank" rel="noopener" title="${esc(title)}">${html}</a>`;
  const ipLink = ip => IPQS ? dlink(IPQS.content.replace(/\/+$/, "") + D.paths[D.lang] + "?ip=" + encodeURIComponent(ip), esc(ip), t("ipqs_tip"), "ip") : `<span class="m">${esc(ip)}</span>`;
  // the other 1ms.dog tools, each linked only when the page announces it: the full checkup (check.1ms.dog; not in
  // embed mode), Me2Cloud (latency to the other clouds), the DNS test, ASN Lookup (the exit's network, /AS<n>), the
  // IPv6 test (when the test went over IPv4), and Global Ping (beside the conclusion, with the line below)
  const tool = name => { const m = document.querySelector(`meta[name="${name}"]`); return m ? m.content.replace(/\/+$/, "") + D.paths[D.lang] : ""; };
  const CHECK = tool("check"), M2C = tool("m2c"), DNS = tool("dns"), ASN = tool("asn"), IPV6 = tool("ipv6"), LAG = tool("lag");
  // Network Diagnosis (lag.1ms.dog), right after the conclusion once a result shows the line stutters: UDP loss of 1%
  // or more, jitter of 30 ms or more, a bufferbloat grade of C or worse, or calls or games that struggle
  const laggy = (r, lossMax) => lossMax >= 1 || (r.jit != null && r.jit >= 30) || /^[CDF]/.test(grade(r) || "") || ["call", "game"].some(k => uses(r)[k] === "poor");
  const lagLink = () => LAG && !EMBED ? `<a class="xl lag" href="${esc(LAG)}" target="_blank" rel="noopener">${esc(t("rel_lag"))}${XL}</a>` : "";
  const addLag = () => { if (!$("#noteL .lag") && lagLink()) $("#noteL").insertAdjacentHTML("beforeend", " " + lagLink()); };
  // Global Ping (ping.1ms.dog) beside that link, at the same moment: how far the service this test runs against
  // (Cloudflare's speed test endpoints) is from 18 places around the world, so a slow result can be told apart from a
  // slow endpoint. The target rides along as ?t=, which there only fills in the field; it starts no test.
  const PING = tool("ping");
  const pingLink = () => PING && !EMBED ? `<a class="xl ping" href="${esc(PING)}?t=${encodeURIComponent(new URL(CF).host)}" target="_blank" rel="noopener">${esc(t("rel_ping"))}${XL}</a>` : "";
  const addPing = () => { if (!$("#noteL .ping") && pingLink()) $("#noteL").insertAdjacentHTML("beforeend", " " + pingLink()); };
  function renderRel() {
    const e = NET.cf;
    const v4 = e && e.ip && !e.ip.includes(":");
    const links = [CHECK && !EMBED && xlink(CHECK, esc(t("rel_check"))), M2C && xlink(M2C, esc(t("rel_m2c"))), DNS && xlink(DNS, esc(t("rel_dns"))), IPV6 && v4 && xlink(IPV6, esc(t("rel_v6")))].filter(Boolean);
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
  const ME = fetch("/_ms/me", { cache: "no-store", signal: AbortSignal.timeout(6000) }).then(r => r.ok ? r.json() : null).then(fromMe).catch(() => null);
  ME.then(e => { if (e && !NET.cfDone) { NET.cf = e; NET.cfDone = true; renderNet(); } });
  exit().then(async c => {
    const m = await ME;
    NET.cf = c && (!m || c.ip !== m.ip) ? c : m && c ? { ...m, colo: c.colo || m.colo, coloCity: c.coloCity, coloCc: c.coloCc } : m;
    NET.cfDone = true; renderNet();
  });

  /* ---------- the test ---------- */
  let RUN = null, LAST = null, META = null, RECV = null;   // RECV: the shared-result banner, while one shows
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
    LAST = null; $("#shareBtn").disabled = true; rpShow(false);
  }

  async function start() {
    if (RUN) { RUN.abort(new DOMException("stopped", "AbortError")); return; }
    // someone else's result gives way to the visitor's own (no compare mode here: the banner goes with it)
    if (RECV) { RECV.remove(); RECV = null; history.replaceState(null, "", D.paths[D.lang]); }
    const ctl = RUN = new AbortController(), sig = ctl.signal, t0 = performance.now();
    reset(); showPrev(HIST[0]); setGo("run", t("ph_ping"));
    // UDP to Tokyo for the whole test, tagged by phase (src/rtc.mjs)
    const run = ++RTC_N;
    const U = RTC_ON ? startRtc(run) : null;
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
      if (U) U.phase(1);
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
      if (U) U.phase(2);
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
      if (laggy(R, 0)) { addLag(); addPing(); }   // UDP loss, when there is some, adds them a moment later (showLoss)
      ring(1);
      const peak = isPeak(new Date());
      $("#progTxt").textContent = t("done", { s: ((performance.now() - t0) / 1000).toFixed(0), mb: mb(bytes) }) + (peak ? " · " + t("peak") : "");
      document.title = `↓ ${fmtMbps(R.down)} ↑ ${fmtMbps(R.up)} Mbps · ${TITLE}`;
      LAST = { ts: Date.now(), cc: cc || "", colo: META.colo || (NET.cf && NET.cf.colo) || "", ...R };
      $("#shareBtn").disabled = false; rpShow(true);
      saveRun({ ts: LAST.ts, ...R, ip: (NET.cf && NET.cf.ip) || META.ip || "", cc: cc || "", org: (NET.cf && NET.cf.org) || "", peak });
      setGo("done", t("used", { mb: mb(bytes) }));
      const rtc = U ? U.done() : null;
      if (EMBED) {
        post({ type: "progress", done: 100, total: 100, text: $("#progTxt").textContent });
        post(checkup(cc, rtc && await rtc));   // the checkup report waits the few seconds UDP and QUIC take
      }
    } catch (e) {
      gauge("down", R.down); gauge("up", R.up); showLat(R); ring(0); document.title = TITLE;
      if (U) U.cancel();
      if (sig.aborted) { $("#progTxt").textContent = t("stopped"); setGo("idle"); }
      else { $("#progTxt").innerHTML = "&nbsp;"; $("#noteL").textContent = t("e_fail"); setGo("idle"); post({ type: "error", text: t("e_fail") }); }
    } finally {
      if (RUN === ctl) RUN = null;
    }
  }
  $("#go").onclick = start;

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
  // the component, its version in the address: a copy cached before an update must not answer for the new one
  const SHARE_JS = "/assets/share/share.js?v=10";
  const shareLink = show => location.origin + D.paths[D.lang] + "r/" + encodeShare({ ...LAST, cc: show ? LAST.cc : "", colo: show ? LAST.colo : "" });
  // what the box adds to the card: the country and the Cloudflare node, on their own line under the speeds (the
  // footer is too short for them in de or fr, and a card must not clip them: tool-contract.md, "Share card")
  const cardWhere = (S, show) => show ? [S.cc && country(S.cc), S.colo && "Cloudflare " + S.colo].filter(Boolean).join("  ·  ") : "";
  // the card's middle: the two speeds, where they were measured, the latencies and the grade, what the line is good for
  async function drawResult(x, kit) {
    const { W, P, F, M, v, roundRect, clip, fit, img, top } = kit, S = LAST, where = cardWhere(S, kit.show), d = where ? 44 : 0;
    const y = n => top + n + (n > 200 ? d : 0);
    x.textBaseline = "alphabetic";
    const big = (label, val, at, color) => {
      x.fillStyle = color; x.font = `600 28px ${F}`; x.fillText(label, at, y(50));
      x.fillStyle = v("fg"); x.font = `700 112px ${M}`; x.fillText(fmtMbps(val), at, y(160));
      const w = x.measureText(fmtMbps(val)).width;
      x.fillStyle = v("muted"); x.font = `500 30px ${F}`; x.fillText("Mbps", at + w + 14, y(160));
    };
    big("↓ " + t("k_down"), S.down, P, v("ink")); big("↑ " + t("k_up"), S.up, P + 560, v("up"));
    if (where) {
      let at = P;
      if (/^[A-Z]{2}$/.test(S.cc || "")) try { x.drawImage(await img(`/flags/${flagCode(S.cc)}.svg`), P, top + 182, 30, 22); at += 42; } catch (e) {}
      x.fillStyle = v("muted"); fit(x, where, W - P - at, 24, 18, 500); x.fillText(clip(x, where, W - P - at), at, top + 202);
    }
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
    const S = LAST, { share } = await import(SHARE_JS);
    share({
      lang: D.lang, name: t("app_name"), file: "speed-test",
      show: ["country", "colo"], never: ["ip"], canShow: !!(S.cc || S.colo),
      link: shareLink, home: location.origin + D.paths[D.lang],
      text: () => t("share_text", { down: fmtMbps(S.down), up: fmtMbps(S.up), ms: fmtMs(S.idle), grade: grade(S) || "–" }),
      height: (x, kit) => 760 + (cardWhere(S, kit.show) ? 44 : 0), draw: drawResult,
      foot: () => [t("card_sub")],
      ts: S.ts,
    }).open();
  };

  /* ---------- a shared result: the 1ms.dog banner above it (/assets/share/), whose button runs the visitor's own test ---------- */
  async function showShared(S) {
    reset(); showPrev(null);                // the visitor's own last result says nothing about someone else's
    gauge("down", S.down); gauge("up", S.up);
    showLat(S);
    showUses(S);
    $("#noteL").innerHTML = gradeLine(S) || "&nbsp;";
    LAST = S; $("#shareBtn").disabled = false; rpShow(true);
    setGo("idle");
    const { received } = await import(SHARE_JS);
    if (!RUN && LAST === S) RECV = received({ lang: D.lang, ts: S.ts, at: $(".hero"), test: () => { if (!RUN) start(); } });
  }

  /* ---------- the result for the Connection Checkup ---------- */
  // the grade line as the headline; the speeds, latency and grade; what needs attention (a test that isn't measuring the
  // visitor's own line, what the line struggles with), worst first; the facts its cross-tool rules read; the share
  // link without the country and data center, as the share box starts
  // UDP loss over the whole test (all three phases, by packets sent), and whether the QUIC handshake got through:
  // 1ms-shell docs/checkup.md, "line and tunnel keys". Not measured: no key.
  const rtcFacts = rtc => {
    const f = {};
    const ps = rtc && rtc.u.state === "open" && (rtc.u.phases || []).filter(Boolean);
    const sent = ps ? ps.reduce((s, p) => s + p.sent, 0) : 0;
    if (sent) f.udpLoss = Math.round(ps.reduce((s, p) => s + p.sent * p.loss, 0) / sent * 10) / 10;
    const v = rtc && rtc.q.verdict;
    if (v === "ok" || v === "slow") f.quic = true; else if (v === "blocked") f.quic = false;
    return f;
  };
  function checkup(cc, rtc) {
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
    const facts = { down: n1(R.down), up: n1(R.up), idle: n1(R.idle), jitter: n1(R.jit), ldown: n1(R.ldown), lup: n1(R.lup), bloat: g || undefined, ...rtcFacts(rtc) };
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

  /* ---------- the site's "report a problem" dialog (1ms-shell docs/tool-contract.md, "报告问题") ---------- */
  // What this page read, for the dialog's "the tool's own result" row: a line in the visitor's language, the JSON that
  // reproduces the run (the address masked; a shared result says so instead of posing as a test this visitor ran), and
  // the readings as one-tap answers behind the "numbers look wrong?" entry under the conclusion. Nothing before a
  // result, and only where the host provides the dialog: a copy someone deploys themselves has none, and then the
  // entry stays hidden and msReport is never asked.
  const RP = typeof window.msOpenReport === "function" && !EMBED;
  const rpShow = has => { const b = $("#rpRes"); if (b) b.hidden = !(RP && has); };
  const maskIp = ip => !ip ? "" : ip.includes(":") ? ip.split(":").slice(0, 2).join(":") + ":…" : ip.split(".").slice(0, 2).join(".") + ".•.•";
  const num = v => v == null || !isFinite(v) ? null : Math.round(v * 10) / 10;
  window.msReport = () => {
    if (!LAST) return null;
    const g = grade(LAST), u = uses(LAST), e = NET.cf || META || {}, shared = !!RECV;
    const Mbps = v => v == null ? "–" : fmtMbps(v) + " Mbps", Ms = v => v == null ? "–" : fmtMs(v) + " ms";
    const node = [e.coloCity, e.colo].filter(Boolean).join(" ") || "Cloudflare";
    const summary = t(shared ? "rp_sum_shared" : "rp_sum",
      { down: Mbps(LAST.down), up: Mbps(LAST.up), ms: Ms(LAST.idle), jit: Ms(LAST.jit), grade: g || "–", node });
    // what the page reads for real: the speeds, the latencies, the grade, then any use the line struggles with
    const sep = /^(zh|ja)/.test(D.lang) ? "：" : ": ";
    const pick = (k, v) => v == null || v === "–" ? null : (t(k) + sep + v).slice(0, 60);
    const picks = [
      pick("k_down", Mbps(LAST.down)), pick("k_up", Mbps(LAST.up)), pick("k_idle", Ms(LAST.idle)), pick("k_jit", Ms(LAST.jit)),
      pick("k_grade", g || "–"), pick("k_ldown", Ms(LAST.ldown)), pick("k_lup", Ms(LAST.lup)),
      ...USES.filter(k => u[k] === "poor").map(k => pick("u_" + k, t("lv_poor"))),
    ].filter(Boolean).slice(0, 8);
    // the run as it can be replayed, in a shared link's terms: the numbers, and a link that shows them; the address
    // masked; the country and network as the page shows them (the report is private, and both say whether the line or
    // the path is at fault); no city, no history, and a shared result carries only its own numbers
    const data = {
      v: 1, at: new Date(LAST.ts).toISOString(), lang: D.lang, mode: EMBED ? "embed" : "page", shared,
      result: { down: num(LAST.down), up: num(LAST.up), idle: num(LAST.idle), jit: num(LAST.jit),
        ldown: num(LAST.ldown), lup: num(LAST.lup), jdown: num(LAST.jdown), jup: num(LAST.jup), grade: g || null },
      link: D.paths[D.lang] + "r/" + encodeShare({ ...LAST, cc: "", colo: "" }),
      node: { host: new URL(CF).host, colo: LAST.colo || null },
      exit: shared ? null : { ip: maskIp(e.ip), org: e.org || null, cc: e.cc || null },
      tz: shared ? null : TZ || null,
      proxy: shared ? null : NET.reasons.map(r => r.k),
    };
    return { summary: summary.slice(0, 300), data, picks };
  };
  rpShow(!!LAST);
  setGo("idle");
  const SP = sharePath(location.pathname), SHARED = SP && decodeShare(SP.code);
  if (EMBED) start();
  else if (SHARED) showShared(SHARED);
  else if (autoBox.checked) start();
})();
