import { spawn } from "node:child_process";
import { agentEnv } from "./adapters/process.ts";

const MAGPIE_URL = "http://127.0.0.1:3425/v1/magpie/quotas";
const PROVIDER_LABEL: Record<string, string> = { claude: "Claude", codex: "Codex", grok: "Grok", antigravity: "Antigravity", gemini: "Gemini", deepseek: "DeepSeek", copilot: "Copilot" };

export interface QuotaWindow {
  name: string;
  pool: string | null;
  remaining: number;
  resetsAt: string | null;
}
export interface QuotaAccount {
  provider: string;
  label: string;
  plan: string | null;
  account: string;
  windows: QuotaWindow[];
  readAt: string | null;
}
export interface QuotaReport {
  source: "magpie" | "codex" | "none";
  accounts: QuotaAccount[];
  note: string | null;
}

const maskEmail = (s: string) => s.replace(/([\w.%+-]{1,3})[\w.%+-]*@([\w.-]+)/g, "$1***@$2");

// Only what a person needs to see. Identifiers, spend details and reset-credit ids stay out of the browser.
export function normalizeMagpie(raw: unknown): QuotaAccount[] {
  // The gateway wraps the list in { data }; `magpie quota --json` prints it bare.
  const list = Array.isArray(raw) ? raw : (raw as any)?.data;
  if (!Array.isArray(list)) return [];
  const out: QuotaAccount[] = [];
  const seen = new Set<string>();
  for (const a of list as any[]) {
    if (a?.kind && a.kind !== "subscription") continue;
    const provider = String(a?.provider ?? "");
    if (!provider || !Array.isArray(a?.windows) || !a.windows.length) continue;
    const windows: QuotaWindow[] = [];
    const seenWindow = new Set<string>();
    for (const w of a.windows) {
      if (typeof w?.remaining !== "number") continue;
      const key = `${w.name}|${w.pool ?? ""}`;
      if (seenWindow.has(key)) continue;
      seenWindow.add(key);
      windows.push({ name: String(w.name ?? "").slice(0, 60), pool: w.pool ? String(w.pool).slice(0, 60) : null, remaining: Math.max(0, Math.min(100, w.remaining)), resetsAt: typeof w.resetsAt === "string" ? w.resetsAt : null });
    }
    if (!windows.length) continue;
    const account = maskEmail(String(a.user ?? a.name ?? ""));
    const key = `${provider}|${account}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ provider, label: PROVIDER_LABEL[provider] ?? provider, plan: a.plan ? String(a.plan).slice(0, 40) : null, account, windows, readAt: a.readAt ?? a.asOf ?? null });
  }
  return out;
}

export function normalizeCodex(result: any): QuotaAccount[] {
  const s = result?.rateLimits;
  if (!s) return [];
  const windows: QuotaWindow[] = [];
  for (const w of [s.primary, s.secondary]) {
    if (typeof w?.usedPercent !== "number") continue;
    const mins = w.windowDurationMins;
    windows.push({ name: mins === 300 ? "5 小时" : mins === 10080 ? "每周" : mins ? `${mins} 分钟` : "额度", pool: null, remaining: Math.max(0, 100 - w.usedPercent), resetsAt: w.resetsAt ? new Date(w.resetsAt * 1000).toISOString() : null });
  }
  return windows.length ? [{ provider: "codex", label: "Codex", plan: s.planType ?? null, account: "", windows, readAt: new Date().toISOString() }] : [];
}

function readCodexOfficial(): Promise<QuotaAccount[]> {
  return new Promise((resolve) => {
    const child = spawn("codex", ["app-server", "-c", 'openai_base_url="https://chatgpt.com/backend-api/codex"'], { env: agentEnv(), stdio: ["pipe", "pipe", "ignore"] });
    let buf = "";
    let done = false;
    const finish = (v: QuotaAccount[]) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      child.kill();
      resolve(v);
    };
    const timer = setTimeout(() => finish([]), 15000);
    child.on("error", () => finish([]));
    child.on("close", () => finish([]));
    child.stdin.on("error", () => {});
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (d: string) => {
      buf += d;
      let i: number;
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const m = JSON.parse(line);
          if (m.id === 1) {
            child.stdin.write(JSON.stringify({ method: "initialized" }) + "\n");
            child.stdin.write(JSON.stringify({ id: 2, method: "account/rateLimits/read" }) + "\n");
          } else if (m.id === 2) finish(m.error ? [] : normalizeCodex(m.result));
        } catch {}
      }
    });
    child.stdin.write(JSON.stringify({ id: 1, method: "initialize", params: { clientInfo: { name: "bot_platform", title: "Bot Platform", version: "0.1.0" } } }) + "\n");
  });
}

// Reads the vendors' usage endpoints. None of this calls a model, so checking costs no tokens.
export async function readQuotas(o: { url?: string; codex?: () => Promise<QuotaAccount[]> } = {}): Promise<QuotaReport> {
  try {
    const res = await fetch(o.url ?? MAGPIE_URL, { signal: AbortSignal.timeout(20000) });
    if (res.ok) {
      const accounts = normalizeMagpie(await res.json());
      if (accounts.length) return { source: "magpie", accounts, note: null };
    }
  } catch {}
  const codex = await (o.codex ?? readCodexOfficial)();
  if (codex.length) return { source: "codex", accounts: codex, note: "Magpie 没有运行，只能读到 Codex 的额度。打开 Magpie 后可以看到其他家。" };
  return { source: "none", accounts: [], note: "暂时读不到额度。打开 Magpie 后可以看到所有订阅。" };
}
