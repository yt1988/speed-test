# 网速测试

[English](README.md) · **简体中文**

你的网速到底有多快？[网速测试](https://speed.1ms.dog/zh-cn/)直接在浏览器里测下载、上传速度、延迟、抖动和满载延迟（缓冲膨胀），从你自己的网络测到最近的 Cloudflare 节点，并告诉你这条线路适合干什么：4K 视频、视频通话、网络游戏、云游戏、直播推流。

**在线使用：** https://speed.1ms.dog/zh-cn/

## 测什么

| | 怎么测 |
|---|---|
| **延迟、抖动** | 在已建立的连接上依次发 16 个空下载请求。每个请求的耗时（Resource Timing）减去服务器自己的处理时间（`Server-Timing: cfSpeedWorker`）；延迟取中位数，抖动取相邻两次差值的平均。 |
| **下载** | 同时保持几个 `GET /__down?bytes=N` 请求在传输，从响应流里每收到一块就计数。请求大小随当前速度增长（每个约 1.2 秒的数据量，256 KB 到 50 MB）。 |
| **上传** | 同样的做法，用 `POST /__up` 和 XHR 的上传进度（fetch 拿不到上传进度），请求体是随机数据，途中无法压缩。 |
| **速度** | 取前 30% 时间之后（连接已经提速完毕）的平均值。每个方向至少 5 秒，最近 2.5 秒里每秒速度相差在 8% 以内就结束，最长 10 秒。 |
| **满载延迟** | 传输数据时每 0.4 秒发一个空请求。比空闲延迟增加的部分就是缓冲膨胀：30 毫秒以内算低，100 毫秒以内算中，再高就是严重。 |
| **M-Lab（可选）** | M-Lab 的 [ndt7](https://github.com/m-lab/ndt-server/blob/main/spec/ndt7-protocol.md)，走 WebSocket：一条 TCP 连接，每个方向 10 秒，连到运营商网络之外最近的服务器；服务器发来自己的计数（TCPInfo、AppInfo）时用它们。只在点击后运行：M-Lab 会把每次测试连同客户端 IP 作为开放数据公开。 |

测速服务器是 Cloudflare 自己的测速端点，也就是 speed.cloudflare.com 和 Cloudflare 以 MIT 协议开源的 [@cloudflare/speedtest](https://github.com/cloudflare/speedtest) 用的那套，允许任何来源调用。浏览器里所有请求共用一条 HTTP/2 或 HTTP/3 连接，所以长距离线路上会比开很多条 TCP 连接的工具测得低（帮助里有解释，也说明了为什么在中国大陆更低：Cloudflare 的节点在境外）。

页面默认等用户点「开始」（一次测试上下行各按最高速度跑 5 到 10 秒）；打开「打开页面时自动测试」就会自动运行，选择记在浏览器里。

### 开着代理时

测试会经过代理，测到的是代理节点。「直连规则」按钮给出 Clash/Mihomo、Surge、Shadowrocket、Quantumult X、Loon、sing-box、Xray 的规则，只把 `speed.cloudflare.com`、`locate.measurementlab.net` 和 `*.measurement-lab.org` 设成直连。远程规则集：`/rules/clash.yaml`、`surge.list`、`loon.list`、`quanx.list`、`singbox.json`。

### 分享

结果编进链接 `/r/<code>`（格式见 `src/share.mjs`，带版本号）：Worker 把速度写进页面标题和预览，页面显示这份结果。分享弹窗还会在浏览器里画一张结果图。两者都不含 IP 和网络信息；勾选后才带上国家/地区和测速节点。

## 文件

```
src/measure.mjs     对 Cloudflare 的测试：延迟、下载、上传、满载延迟；纯函数有单元测试
src/mlab.mjs        M-Lab 的 ndt7（WebSocket）
src/verdict.mjs     档位、缓冲膨胀、线路适合干什么
src/rules.mjs       代理工具的直连规则
src/share.mjs       把结果编进链接
src/app.js          页面脚本
src/worker.js       /r/<code> 的预览；其他路径返回不带 HTML 的 404
src/i18n/*.mjs      10 种语言
scripts/build.mjs   生成 public/（页面、资源、规则集、CSP）
scripts/assets.mjs  链接预览图（public/og/）
scripts/verify.mjs  用很小的请求检查端点（GitHub Actions 每周跑一次）
```

## 运行和部署

```bash
npm install
npm run build      # 生成 public/
npm test           # public/ 是否最新、约定、文案、单元测试
npm run verify     # 端点是否仍按页面预期应答
npm run dev        # http://localhost:8796
npx wrangler deploy
```

整站是 Cloudflare Worker 上的静态文件：文件直接返回，不运行脚本，这部分请求不计费；`src/worker.js` 只处理 `/r/<code>` 和 404。在 1ms.dog 上，推送到 `main` 后由 Workers Builds 自动部署（先 `npm ci && npm test`，再 `npx wrangler deploy`；`public/` 没有重新生成或测试不通过时不会部署）。`wrangler.toml` 不绑定域名：在 1ms.dog 上由公共外壳把 `speed.1ms.dog` 路由过来。自己部署时，在 Cloudflare 控制台给 Worker 绑定你的域名，并用 `SITE_URL=https://你的域名 npm run build` 构建。

## 许可

MIT
