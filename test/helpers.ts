import http from "node:http";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createApp } from "../src/daemon/server.ts";
import { Store } from "../src/daemon/store.ts";
import type { RuntimeFactory } from "../src/daemon/types.ts";

const webDir = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "web");

export const tempHome = () => mkdtempSync(join(tmpdir(), "bot-platform-test-"));

export async function boot(factory: RuntimeFactory, opts: { home?: string; idleMs?: number; quota?: () => Promise<any>; refine?: (i: any) => Promise<string>; reveal?: (path: string) => Promise<void> } = {}) {
  const home = opts.home ?? tempHome();
  const store = new Store(home);
  let port = 0;
  const app = createApp({ store, factory, webDir, port: () => port, idleMs: opts.idleMs, pollMs: 30, sshPollMs: 30, quota: opts.quota, refine: opts.refine, reveal: opts.reveal, status: async () => ({ claude: { installed: true, loggedIn: true, models: [] }, codex: { installed: true, loggedIn: true, models: [] } }) });
  await new Promise<void>((r) => app.server.listen(0, "127.0.0.1", r));
  port = (app.server.address() as { port: number }).port;
  const base = `http://127.0.0.1:${port}`;
  const events: any[] = [];
  const sse = http.get(`${base}/api/events`, (res) => {
    let buf = "";
    res.setEncoding("utf8");
    res.on("data", (c: string) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf("\n\n")) >= 0) {
        const block = buf.slice(0, i);
        buf = buf.slice(i + 2);
        if (block.startsWith("data: ")) events.push(JSON.parse(block.slice(6)));
      }
    });
    res.on("error", () => {});
  });
  sse.on("error", () => {});
  const api = async (method: string, path: string, body?: unknown) => {
    const res = await fetch(base + path, { method, headers: body !== undefined ? { "content-type": "application/json" } : {}, body: body !== undefined ? JSON.stringify(body) : undefined });
    return { status: res.status, body: (await res.json().catch(() => null)) as any };
  };
  const raw = (method: string, path: string, headers: Record<string, string>, body?: string) =>
    new Promise<number>((resolve, reject) => {
      const req = http.request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.on("error", reject);
      if (body) req.write(body);
      req.end();
    });
  const waitFor = async (check: () => unknown, label = "condition", ms = 3000) => {
    const end = Date.now() + ms;
    for (;;) {
      const v = await check();
      if (v) return v;
      if (Date.now() > end) throw new Error(`timed out waiting for ${label}`);
      await new Promise((r) => setTimeout(r, 15));
    }
  };
  const close = () => {
    sse.destroy();
    app.close();
    store.close();
  };
  return { app, store, home, api, raw, base, port, events, waitFor, close };
}
