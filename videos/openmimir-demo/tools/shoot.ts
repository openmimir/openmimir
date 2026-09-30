// Screenshots the running demo instance at 1920x1080 once the app has rendered.
// Usage: bun tools/shoot.ts <url> <out.png> [waitMs]
import { spawn } from "node:child_process";

const [url, out, wait = "3500"] = process.argv.slice(2);
if (!url || !out) throw new Error("usage: bun tools/shoot.ts <url> <out.png> [waitMs]");

const port = 9333 + Math.floor(Math.random() * 500);
const chrome = spawn(
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  [
    "--headless=new",
    `--remote-debugging-port=${port}`,
    "--hide-scrollbars",
    "--force-device-scale-factor=1",
    "--window-size=1920,1080",
    `--user-data-dir=/tmp/om-shoot-${port}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let target: { webSocketDebuggerUrl: string } | undefined;
for (let i = 0; i < 50 && !target; i++) {
  await sleep(100);
  try {
    const list = (await (await fetch(`http://127.0.0.1:${port}/json/list`)).json()) as Array<{
      type: string;
      webSocketDebuggerUrl: string;
    }>;
    target = list.find((t) => t.type === "page");
  } catch {}
}
if (!target) throw new Error("chrome did not start");

const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => ws.addEventListener("open", r, { once: true }));
let id = 0;
const pending = new Map<number, (v: unknown) => void>();
ws.addEventListener("message", (e) => {
  const msg = JSON.parse(String(e.data));
  if (msg.id && pending.has(msg.id)) pending.get(msg.id)?.(msg.result);
});
const send = (method: string, params: Record<string, unknown> = {}) =>
  new Promise<any>((resolve) => {
    const n = ++id;
    pending.set(n, resolve);
    ws.send(JSON.stringify({ id: n, method, params }));
  });

await send("Emulation.setDeviceMetricsOverride", { width: 1920, height: 1080, deviceScaleFactor: 1, mobile: false });
await send("Page.enable");
// PANEL=open shows the sessions panel on the desk view.
await send("Page.addScriptToEvaluateOnNewDocument", {
  source: `localStorage.setItem("mimir.panel", ${JSON.stringify(process.env.PANEL ?? "closed")});`,
});
await send("Page.navigate", { url });
await sleep(Number(wait));
const shot = await send("Page.captureScreenshot", { format: "png" });
await Bun.write(out, Buffer.from(shot.data, "base64"));
ws.close();
chrome.kill();
console.log(`shot ${out}`);
