/**
 * QR login flow: terminal QR + web server fallback for token refresh.
 */

import http from "node:http";
import { execFileSync } from "node:child_process";
import QRCode from "qrcode";
import { saveCredentials } from "./profile.js";
import { BOT_TYPE, type AccountData, type QRCodeResponse, type QRStatusResponse } from "./types.js";

const QR_SERVER_BASE_PORT = 9876;
const QR_SERVER_MAX_PORT = 9886;

export async function fetchQRCode(baseUrl: string): Promise<QRCodeResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(BOT_TYPE)}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`QR fetch failed: ${res.status}`);
  return (await res.json()) as QRCodeResponse;
}

export async function pollQRStatus(baseUrl: string, qrcode: string): Promise<QRStatusResponse> {
  const base = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
  const url = `${base}ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 35_000);
  try {
    const res = await fetch(url, {
      headers: { "iLink-App-ClientVersion": "1" },
      signal: controller.signal,
    });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`QR status failed: ${res.status}`);
    return (await res.json()) as QRStatusResponse;
  } catch (err) {
    clearTimeout(timer);
    if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
    throw err;
  }
}

export async function doQRLogin(
  baseUrl: string,
  credentialsFile: string,
  log: (msg: string) => void,
): Promise<AccountData | null> {
  log("正在获取微信登录二维码...");
  const qrResp = await fetchQRCode(baseUrl);

  log(`\n扫码链接:\n${qrResp.qrcode_img_content}\n`);
  try {
    const qrterm = await import("qrcode-terminal");
    await new Promise<void>((resolve) => {
      qrterm.default.generate(qrResp.qrcode_img_content, { small: true }, (qr: string) => {
        process.stderr.write(qr + "\n");
        resolve();
      });
    });
  } catch { /* qrcode-terminal unavailable */ }

  log("等待扫码...");
  const deadline = Date.now() + 480_000;
  let scannedPrinted = false;

  while (Date.now() < deadline) {
    const status = await pollQRStatus(baseUrl, qrResp.qrcode);
    switch (status.status) {
      case "wait": break;
      case "scaned":
        if (!scannedPrinted) { log("已扫码，请在微信中确认..."); scannedPrinted = true; }
        break;
      case "expired":
        log("二维码已过期");
        return null;
      case "confirmed": {
        if (!status.ilink_bot_id || !status.bot_token) { log("登录失败：未返回完整信息"); return null; }
        const account: AccountData = {
          token: status.bot_token,
          baseUrl: status.baseurl || baseUrl,
          accountId: status.ilink_bot_id,
          userId: status.ilink_user_id,
          savedAt: new Date().toISOString(),
        };
        saveCredentials(credentialsFile, account);
        log("微信连接成功！");
        return account;
      }
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  log("登录超时");
  return null;
}

// ── Web server QR login (for token refresh while running) ──────────────────

async function generateQRSvg(data: string): Promise<string> {
  return QRCode.toString(data, { type: "svg", width: 280, margin: 1 });
}

async function buildQRPageHtml(qrSvg: string, qrUrl: string, profileName: string): Promise<string> {
  return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>微信重新登录 - ${profileName}</title>
<style>
body{font-family:-apple-system,sans-serif;display:flex;justify-content:center;align-items:center;min-height:100vh;margin:0;background:#f5f5f5}
.card{background:#fff;padding:40px;border-radius:16px;box-shadow:0 4px 24px rgba(0,0,0,.1);text-align:center;max-width:400px}
h2{margin:0 0 8px;color:#333}
.hint{color:#999;font-size:14px;margin-bottom:20px}
#status{margin-top:20px;font-size:18px;color:#666}
.success{color:#07c160!important;font-weight:bold}
.expired{color:#e74c3c!important}
#qr-container svg{width:280px;height:280px}
</style></head><body>
<div class="card">
<h2>微信重新登录</h2>
<p class="hint">Profile: ${profileName} | Token 已过期</p>
<div id="qr-container">${qrSvg}</div>
<p style="font-size:13px;color:#999">或打开: <a href="${qrUrl}" target="_blank">扫码链接</a></p>
<div id="status">等待扫码...</div>
</div>
<script>
async function poll(){
  try{const r=await fetch("/qr-status");const d=await r.json();const el=document.getElementById("status");
  if(d.status==="scaned"){el.textContent="已扫码，请确认...";}
  else if(d.status==="confirmed"){el.textContent="登录成功!";el.className="success";return;}
  else if(d.status==="expired"){
    el.textContent="二维码已过期，正在刷新...";el.className="expired";
    try{const nr=await fetch("/qr-refresh");if(nr.ok){location.reload();}}
    catch{el.textContent="刷新失败，请手动刷新页面";}
    }}catch{}
  setTimeout(poll,2000);}
poll();
</script></body></html>`;
}

export async function doQRLoginWithWebServer(
  baseUrl: string,
  profileName: string,
  credentialsFile: string,
  log: (msg: string) => void,
): Promise<AccountData | null> {
  log("Token 过期，启动 Web 二维码...");
  let qrResp = await fetchQRCode(baseUrl);
  let currentHtml = await buildQRPageHtml(
    await generateQRSvg(qrResp.qrcode_img_content),
    qrResp.qrcode_img_content,
    profileName,
  );

  let latestStatus: QRStatusResponse = { status: "wait" };
  let loginResolved = false;
  let currentQrCode = qrResp.qrcode;

  return new Promise<AccountData | null>((resolve) => {
    const server = http.createServer(async (req, res) => {
      if (req.url === "/qr-status") {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ status: latestStatus.status }));
      } else if (req.url === "/qr-refresh") {
        // Auto-refresh: fetch a new QR code and rebuild the page
        try {
          qrResp = await fetchQRCode(baseUrl);
          currentQrCode = qrResp.qrcode;
          currentHtml = await buildQRPageHtml(
            await generateQRSvg(qrResp.qrcode_img_content),
            qrResp.qrcode_img_content,
            profileName,
          );
          latestStatus = { status: "wait" };
          log("二维码已刷新");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
        } catch (err) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: false }));
        }
      } else {
        res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        res.end(currentHtml);
      }
    });

    function tryListen(port: number) {
      server.once("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE" && port < QR_SERVER_MAX_PORT) tryListen(port + 1);
        else { log(`❌ 扫码页面启动失败（端口可能被占用），请稍后重试`); resolve(null); }
      });
      server.listen(port, "127.0.0.1", () => {
        const addr = server.address();
        const actualPort = typeof addr === "object" && addr ? addr.port : port;
        log(`二维码页面: http://localhost:${actualPort}`);
        const openCmd = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
        try { execFileSync(openCmd, [`http://localhost:${actualPort}`]); } catch {
          log(`如果浏览器没有自动打开，请手动访问: http://localhost:${actualPort}`);
        }
        startQRPolling();
      });
    }

    async function startQRPolling() {
      const deadline = Date.now() + 480_000;
      while (Date.now() < deadline && !loginResolved) {
        try {
          latestStatus = await pollQRStatus(baseUrl, currentQrCode);
          if (latestStatus.status === "confirmed") {
            if (!latestStatus.ilink_bot_id || !latestStatus.bot_token) {
              loginResolved = true; server.close(); resolve(null); return;
            }
            const account: AccountData = {
              token: latestStatus.bot_token,
              baseUrl: latestStatus.baseurl || baseUrl,
              accountId: latestStatus.ilink_bot_id,
              userId: latestStatus.ilink_user_id,
              savedAt: new Date().toISOString(),
            };
            saveCredentials(credentialsFile, account);
            log("Token 刷新成功！");
            loginResolved = true;
            setTimeout(() => server.close(), 3000);
            resolve(account);
            return;
          }
          // Don't exit on expired — let the web page auto-refresh via /qr-refresh
        } catch (err) { log(`扫码状态查询异常: ${String(err)}`); }
        await new Promise((r) => setTimeout(r, 2000));
      }
      if (!loginResolved) { loginResolved = true; server.close(); resolve(null); }
    }

    tryListen(QR_SERVER_BASE_PORT);
  });
}
