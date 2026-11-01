// M-Lab's ndt7 test (https://github.com/m-lab/ndt-server/blob/main/spec/ndt7-protocol.md), optional and run only when
// the visitor asks: M-Lab publishes every test it serves, with the client's IP address, as open data.
// One TCP connection (a WebSocket) to the nearest M-Lab server, outside the visitor's ISP, for about 10 s each way.
// The server sends its own measurements as text messages (TCPInfo, AppInfo); they're used when present, since they
// count what really crossed the network rather than what the browser buffered.

export const LOCATE = "https://locate.measurementlab.net/v2/nearest/ndt/ndt7";
const PROTO = "net.measurementlab.ndt.v7";

// The nearest server and its two test URLs (each carries a short-lived access token)
export async function locate(signal) {
  const r = await fetch(LOCATE + "?client_name=speed-test&client_version=1", { signal });
  if (!r.ok) throw new Error("locate " + r.status);
  const s = ((await r.json()).results || [])[0];
  if (!s) throw new Error("no server");
  const u = s.urls || {};
  return { machine: s.machine || "", site: site(s.machine), city: (s.location && s.location.city) || "", country: (s.location && s.location.country) || "",
    down: u["wss:///ndt/v7/download"], up: u["wss:///ndt/v7/upload"] };
}
// The site's airport code in a machine name, for servers listed without a city: mlab1-hnd02.mlab-oti… and
// ndt-hnd63770-db645cea.….autojoin… are both in Tokyo ("HND")
export const site = machine => { const m = /(?:^|[-.])([a-z]{3})\d{2,}/.exec(machine || ""); return m ? m[1].toUpperCase() : ""; };

// a server measurement → { mbps, minRtt (ms) }, from whichever of its fields it has
export function fromServer(m, dir) {
  const out = {};
  const ti = m && m.TCPInfo, ai = m && m.AppInfo;
  if (ti && ti.MinRTT) out.minRtt = ti.MinRTT / 1000;
  if (dir === "up" && ti && ti.BytesReceived && ti.ElapsedTime) out.mbps = ti.BytesReceived * 8 / ti.ElapsedTime;
  if (dir === "down" && ai && ai.NumBytes && ai.ElapsedTime) out.mbps = ai.NumBytes * 8 / ai.ElapsedTime;
  return out;
}

// random bytes, so nothing on the way can compress them (getRandomValues fills at most 64 KB per call)
function random(n) {
  const a = new Uint8Array(n);
  for (let i = 0; i < n; i += 65536) crypto.getRandomValues(a.subarray(i, i + 65536));
  return a;
}

function open(url, signal) {
  const ws = new WebSocket(url, PROTO);
  ws.binaryType = "arraybuffer";
  signal && signal.addEventListener("abort", () => ws.close(), { once: true });
  return ws;
}

// Download: the server sends for ~10 s and closes. onTick({ ms, mbps }) about every 250 ms.
// The address M-Lab's server sees (its first measurement carries ConnectionInfo.Client, "ip:port") is passed to
// onClient as soon as it arrives.
export function download(url, { signal, onTick, onClient } = {}) {
  return new Promise((res, rej) => {
    const ws = open(url, signal);
    let t0 = 0, bytes = 0, last = 0, srv = {}, minRtt = null, client = "";
    const guard = setTimeout(() => ws.close(), 15000);
    ws.onopen = () => { t0 = performance.now(); };
    ws.onmessage = e => {
      if (typeof e.data === "string") {
        try {
          const j = JSON.parse(e.data), s = fromServer(j, "down");
          if (s.mbps) srv = s; if (s.minRtt) minRtt = s.minRtt;
          if (!client && j.ConnectionInfo && j.ConnectionInfo.Client) { client = j.ConnectionInfo.Client; onClient && onClient(client); }
        } catch (x) {}
        bytes += e.data.length;
      } else bytes += e.data.byteLength;
      const ms = performance.now() - t0;
      if (onTick && ms - last >= 250) { last = ms; onTick({ ms, mbps: srv.mbps || bytes * 8 / ms / 1000 }); }
    };
    ws.onerror = () => { clearTimeout(guard); rej(new Error("websocket")); };
    ws.onclose = () => {
      clearTimeout(guard);
      if (!t0) return rej(new Error("closed"));
      const ms = performance.now() - t0;
      res({ mbps: srv.mbps || bytes * 8 / ms / 1000, minRtt, ms, client });
    };
  });
}

// Upload: send for 10 s, keeping the socket's buffer full; messages grow from 8 KB to 1 MB as the line allows (the
// spec's rule: grow once 16 messages' worth has been sent)
export function upload(url, { signal, onTick } = {}) {
  return new Promise((res, rej) => {
    const ws = open(url, signal);
    let t0 = 0, sent = 0, last = 0, srv = {}, minRtt = null, size = 1 << 13, msg = null, timer = 0;
    const guard = setTimeout(() => ws.close(), 15000);
    const fill = () => {
      if (ws.readyState !== 1) return;
      const ms = performance.now() - t0;
      if (ms >= 10000) { ws.close(); return; }
      while (ws.bufferedAmount < 7 * size) {
        ws.send(msg); sent += size;
        if (size < (1 << 20) && sent >= 16 * size) { size *= 2; msg = random(size); }
      }
      if (onTick && ms - last >= 250) { last = ms; onTick({ ms, mbps: srv.mbps || (sent - ws.bufferedAmount) * 8 / ms / 1000 }); }
      timer = setTimeout(fill, 5);
    };
    ws.onopen = () => { t0 = performance.now(); msg = random(size); fill(); };
    ws.onmessage = e => {
      if (typeof e.data !== "string") return;
      try { const s = fromServer(JSON.parse(e.data), "up"); if (s.mbps) srv = s; if (s.minRtt) minRtt = s.minRtt; } catch (x) {}
    };
    ws.onerror = () => { clearTimeout(guard); clearTimeout(timer); rej(new Error("websocket")); };
    ws.onclose = () => {
      clearTimeout(guard); clearTimeout(timer);
      if (!t0) return rej(new Error("closed"));
      const ms = Math.min(performance.now() - t0, 10000);
      res({ mbps: srv.mbps || Math.max(0, sent - ws.bufferedAmount) * 8 / ms / 1000, minRtt, ms });
    };
  });
}
