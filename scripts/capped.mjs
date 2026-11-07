// A local copy of the site that costs almost no traffic: serves public/ and caps every speed request at 16 KB (the
// page asks for up to 50 MB at a time, and a real run moves hundreds of MB). Use it to check layout, strings and
// the flow of a test; the speeds it shows are meaningless, and so is the "MB used" figure (it counts what the page
// asked for). Shared-result links work too: /zh-cn/r/<code>.
//   node scripts/capped.mjs [port]        then open http://localhost:8870/zh-cn/
// The UDP and QUIC row still talks to the server set in src/rtc.mjs (when it allows localhost), a few hundred KB a test.
import http from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../public/", import.meta.url));
const port = +process.argv[2] || 8870;
const CAP = `<script>(()=>{const C=16000,f=fetch;window.fetch=(u,o)=>{if(typeof u==="string")u=u.replace(/([?&]bytes=)(\\d+)/,(m,a,n)=>a+Math.min(+n,C));return f(u,o)};
const s=XMLHttpRequest.prototype.send;XMLHttpRequest.prototype.send=function(b){if(b&&(b.size||b.byteLength||b.length)>C)b=b.slice(0,C);return s.call(this,b)}})()</script>`;
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".woff2": "font/woff2", ".json": "application/json", ".png": "image/png", ".txt": "text/plain", ".xml": "application/xml" };

http.createServer(async (req, res) => {
  const u = new URL(req.url, "http://localhost");
  // a shared result (/r/<code>) is the language's page; the page script reads the code from the address
  const p = u.pathname.includes("/r/") ? u.pathname.replace(/\/r\/.*$/, "/") + "index.html" : u.pathname.endsWith("/") ? u.pathname + "index.html" : u.pathname;
  try {
    let b = await readFile(join(root, decodeURIComponent(p)));
    if (extname(p) === ".html") b = b.toString().replace("<head>", "<head>" + CAP);
    res.writeHead(200, { "content-type": TYPES[extname(p)] || "application/octet-stream" }); res.end(b);
  } catch (e) { res.writeHead(404); res.end("404"); }
}).listen(port, () => console.log(`http://localhost:${port}/ (speed requests capped at 16 KB)`));
