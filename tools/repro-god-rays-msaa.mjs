import { spawn } from "node:child_process";
import { once } from "node:events";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createServer } from "vite";

const chromeCandidates = process.platform === "win32"
  ? [
      "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
      "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    ]
  : ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
const chrome = chromeCandidates.find(existsSync);
if (!chrome) {
  console.error("RED god-rays-msaa no supported Chromium executable found");
  process.exitCode = 1;
} else {
  const profile = await mkdtemp(join(tmpdir(), "god-rays-msaa-"));
  const server = await createServer({
    clearScreen: false,
    logLevel: "error",
    server: { host: "127.0.0.1", port: 0, strictPort: false },
  });

  try {
    await server.listen();
    const address = server.httpServer?.address();
    if (!address || typeof address === "string") throw new Error("Vite did not expose a TCP port");
    const url = `http://127.0.0.1:${address.port}/tests/fixtures/god-rays-msaa-repro.html`;
    const child = spawn(chrome, [
      "--headless=new",
      "--disable-background-networking",
      "--disable-extensions",
      "--disable-gpu-sandbox",
      "--enable-unsafe-swiftshader",
      "--enable-webgl",
      "--ignore-gpu-blocklist",
      "--no-default-browser-check",
      "--no-first-run",
      "--remote-debugging-port=0",
      "--use-angle=swiftshader",
      `--user-data-dir=${profile}`,
      "about:blank",
    ], { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    let stderr = "";
    child.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });

    const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));
    const waitForChild = async (milliseconds) => {
      if (child.exitCode !== null) return;
      await Promise.race([once(child, "close"), delay(milliseconds)]);
    };
    const deadline = Date.now() + 15_000;
    let devTools;
    while (Date.now() < deadline) {
      try {
        devTools = await readFile(join(profile, "DevToolsActivePort"), "utf8");
        break;
      } catch {
        await delay(20);
      }
    }
    if (!devTools) throw new Error("Chromium did not expose DevTools within 15 seconds");
    const [port] = devTools.trim().split(/\r?\n/);
    const targets = await fetch(`http://127.0.0.1:${port}/json/list`).then((response) => response.json());
    const page = targets.find((target) => target.type === "page");
    if (!page?.webSocketDebuggerUrl) throw new Error("Chromium exposed no page target");

    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    let commandId = 0;
    const pending = new Map();
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
    });
    const call = (method, params = {}) => new Promise((resolve, reject) => {
      const id = ++commandId;
      pending.set(id, { reject, resolve });
      socket.send(JSON.stringify({ id, method, params }));
    });

    try {
      await call("Page.enable");
      await call("Page.navigate", { url });
      let html = "";
      while (Date.now() < deadline) {
        const evaluation = await call("Runtime.evaluate", {
          expression: "document.body?.outerHTML ?? ''",
          returnByValue: true,
        });
        html = evaluation.result.value;
        if (/data-status="(?:pass|fail)"/.test(html)) break;
        await delay(20);
      }
      const body = html.match(/<(?:body)[^>]*>([^<]*)<\/(?:body)>/i)?.[1]?.trim();
      const passed = /data-status="pass"/.test(html);
      console.log(body || "RED god-rays-msaa browser page did not produce a verdict");
      if (!passed) {
        const signal = stderr.split(/\r?\n/).filter((line) => /ERROR|WebGL|GL_/.test(line)).slice(-8);
        if (signal.length > 0) console.error(signal.join("\n"));
        process.exitCode = 1;
      }
      await call("Browser.close");
    } finally {
      socket.close();
      await waitForChild(2_000);
      if (child.exitCode === null) {
        child.kill();
        await waitForChild(2_000);
      }
    }
  } finally {
    await server.close();
    await rm(profile, { force: true, recursive: true });
  }
}
