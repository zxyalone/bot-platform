import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { summarize } from "./research.ts";
import { readQuotas, type QuotaReport } from "./quota.ts";
import { refineRole, type RefineInput } from "./refine.ts";
import { CHIEF_ROLE, SETTING_DEFAULTS, type AppSettings } from "./store.ts";
import { isAbsolute, join } from "node:path";
import { Engine, HttpError, STEERABLE } from "./engine.ts";
import { Memory, type MemoryScope } from "./git.ts";
import { agentEnv } from "./adapters/process.ts";
import type { Store } from "./store.ts";
import { MODELS, type AgentKind, type ApprovalDecision, type Bot, type Group, type RuntimeFactory } from "./types.ts";

const MAX_BODY = 512 * 1024;
const MAX_MESSAGE = 200_000;
const STATIC: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/markdown.js": { file: "markdown.js", type: "text/javascript; charset=utf-8" },
  "/avatar.js": { file: "avatar.js", type: "text/javascript; charset=utf-8" },
  "/icons.js": { file: "icons.js", type: "text/javascript; charset=utf-8" },
  "/settings.js": { file: "settings.js", type: "text/javascript; charset=utf-8" },
  "/research.js": { file: "research.js", type: "text/javascript; charset=utf-8" },
  "/tasks.js": { file: "tasks.js", type: "text/javascript; charset=utf-8" },
  "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
};
const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";

const exec = (cmd: string, args: string[]) =>
  new Promise<{ ok: boolean; out: string }>((res) => {
    execFile(cmd, args, { env: agentEnv(), timeout: 15000 }, (e, stdout, stderr) => res({ ok: !e, out: `${stdout}${stderr}` }));
  });

export async function agentStatus() {
  const [cv, cl, xv, xl, gv, gl, av, al] = await Promise.all([exec("claude", ["--version"]), exec("claude", ["auth", "status"]), exec("codex", ["--version"]), exec("codex", ["login", "status"]), exec("grok", ["--version"]), exec("grok", ["models"]), exec("agy", ["--version"]), exec("agy", ["models"])]);
  let claudeIn = false;
  try {
    claudeIn = JSON.parse(cl.out).loggedIn === true;
  } catch {}
  return {
    claude: { installed: cv.ok, loggedIn: claudeIn, version: cv.ok ? cv.out.trim().split(" ")[0] : null, models: MODELS.claude },
    codex: { installed: xv.ok, loggedIn: xl.ok && /logged in/i.test(xl.out), version: xv.ok ? xv.out.trim().split(" ").pop() : null, models: MODELS.codex },
    grok: { installed: gv.ok, loggedIn: gl.ok && /logged in/i.test(gl.out), version: gv.ok ? gv.out.trim().split(" ")[1] : null, models: MODELS.grok },
    antigravity: { installed: av.ok, loggedIn: al.ok && /gemini/i.test(al.out), version: av.ok ? av.out.trim() : null, models: MODELS.antigravity },
  };
}

function validBudget(v: unknown) {
  const n = Number(v);
  if (!Number.isInteger(n) || n < 1000 || n > 50_000_000) throw new HttpError(400, "预算需要是 1000 到 5000 万之间的整数");
  return n;
}

// Every setting's allowed values. Anything else is refused rather than stored.
const SETTING_RULES: Record<string, string[] | [number, number] | "boolean"> = {
  theme: ["system", "light", "dark"],
  accent: ["indigo", "violet", "teal", "green", "amber", "rose"],
  font: ["small", "medium", "large"],
  density: ["comfortable", "compact"],
  width: ["normal", "wide"],
  details_open: "boolean",
  default_agent: Object.keys(MODELS),
  default_effort: ["low", "medium", "high"],
  default_permission: ["ask", "auto_edit", "read_only"],
  default_budget_bot: [1000, 50_000_000],
  default_budget_group: [1000, 50_000_000],
  idle_minutes: [1, 1440],
  max_depth: [1, 10],
  max_calls: [1, 100],
  max_active: [1, 10],
  task_timeout_minutes: [0, 1440],
  low_quota: [1, 90],
  quota_refresh_minutes: [1, 120],
};

function validateSettings(input: any): Partial<AppSettings> {
  const out: any = {};
  for (const [k, v] of Object.entries(input ?? {})) {
    if (!(k in SETTING_DEFAULTS)) throw new HttpError(400, `没有设置项 ${k}`);
    const rule = SETTING_RULES[k];
    const ok = rule === "boolean" ? typeof v === "boolean" : typeof rule[0] === "number" ? Number.isInteger(v) && (v as number) >= (rule[0] as number) && (v as number) <= (rule[1] as number) : (rule as string[]).includes(v as string);
    if (!ok) throw new HttpError(400, typeof rule[0] === "number" ? `${k} 需要是 ${rule[0]} 到 ${rule[1]} 之间的整数` : `${k} 的值无效`);
    out[k] = v;
  }
  return out;
}

async function validateBot(input: any, existing?: Bot, defaults: AppSettings = SETTING_DEFAULTS) {
  const out: any = {};
  const str = (k: string, max: number) => {
    if (input[k] === undefined) return;
    if (typeof input[k] !== "string") throw new HttpError(400, `${k} 必须是文本`);
    out[k] = input[k].trim();
    if (out[k].length > max) throw new HttpError(400, `${k} 太长`);
  };
  str("name", 40);
  str("role", 8000);
  str("cwd", 1024);
  if (input.name !== undefined && !out.name) throw new HttpError(400, "请填写 Bot 名称");
  const oneOf = (k: string, values: string[]) => {
    if (input[k] === undefined) return;
    if (!values.includes(input[k])) throw new HttpError(400, `${k} 的值无效`);
    out[k] = input[k];
  };
  oneOf("agent", Object.keys(MODELS));
  oneOf("effort", ["low", "medium", "high"]);
  oneOf("permission", ["ask", "auto_edit", "read_only"]);
  if (input.paused !== undefined) out.paused = input.paused ? 1 : 0;
  oneOf("route", ["official", "gateway"]);
  if (input.model !== undefined) {
    // The value becomes a command-line argument, so it must not be able to look like a flag.
    if (typeof input.model !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._\/-]{0,79}$/.test(input.model)) throw new HttpError(400, "模型名称无效");
    out.model = input.model;
  }
  if (out.cwd) {
    if (!isAbsolute(out.cwd)) throw new HttpError(400, "工作目录必须是绝对路径");
    const s = await stat(out.cwd).catch(() => null);
    if (!s?.isDirectory()) throw new HttpError(400, "工作目录不存在");
  }
  if (input.budget_tokens !== undefined) out.budget_tokens = validBudget(input.budget_tokens);
  if (input.can_call !== undefined) {
    if (input.can_call !== null && (!Array.isArray(input.can_call) || input.can_call.some((x: unknown) => typeof x !== "string"))) throw new HttpError(400, "can_call 无效");
    out.can_call = input.can_call === null ? null : JSON.stringify(input.can_call);
  }
  if (existing && out.agent && out.agent !== existing.agent && !out.model) out.model = MODELS[out.agent as AgentKind][0];
  if (!existing) {
    if (!out.name) throw new HttpError(400, "请填写 Bot 名称");
    if (!out.agent) throw new HttpError(400, "请选择 agent");
    out.model ??= MODELS[out.agent as AgentKind][0];
    out.role ??= "";
    out.effort ??= defaults.default_effort;
    out.permission ??= defaults.default_permission;
    out.route ??= "official";
  }
  return out;
}

export function createApp(o: { store: Store; factory: RuntimeFactory; idleMs?: number; webDir: string; port: () => number; status?: () => Promise<unknown>; pollMs?: number; sshPollMs?: number; quota?: () => Promise<QuotaReport>; refine?: (i: RefineInput) => Promise<string> }) {
  const checkBot = (input: any, existing?: Bot) => validateBot(input, existing, o.store.settings());
  const clients = new Set<ServerResponse>();
  const broadcast = (ev: { type: string; [k: string]: unknown }) => {
    const data = `data: ${JSON.stringify(ev)}\n\n`;
    for (const c of clients) c.write(data);
  };
  const engine = new Engine({ store: o.store, factory: o.factory, broadcast, idleMs: o.idleMs, busUrl: () => `http://127.0.0.1:${o.port()}/internal/bus`, validateBot: checkBot, pollMs: o.pollMs, sshPollMs: o.sshPollMs });
  const fetchStatus = o.status ?? agentStatus;
  let statusCache: { at: number; value: Promise<unknown> } | null = null;
  const status = () => {
    if (!statusCache || Date.now() - statusCache.at > 60000) statusCache = { at: Date.now(), value: fetchStatus() };
    return statusCache.value;
  };

  // Agents run with this user's files and accounts, so a web page must not be able to reach the API:
  // the Host check stops DNS rebinding, and the Origin and content-type checks stop cross-site requests.
  const allowed = (req: IncomingMessage) => {
    const p = o.port();
    const hosts = [`127.0.0.1:${p}`, `localhost:${p}`];
    if (!hosts.includes(req.headers.host ?? "")) return false;
    const origin = req.headers.origin;
    if (origin && !hosts.map((h) => `http://${h}`).includes(origin)) return false;
    if (req.method !== "GET" && req.method !== "HEAD") {
      const site = req.headers["sec-fetch-site"];
      if (site && site !== "same-origin" && site !== "none") return false;
    }
    return true;
  };

  const readJson = (req: IncomingMessage) =>
    new Promise<any>((res, rej) => {
      if (!/^application\/json\b/i.test(req.headers["content-type"] ?? "")) return rej(new HttpError(415, "需要 application/json"));
      let size = 0;
      const chunks: Buffer[] = [];
      req.on("data", (c: Buffer) => {
        size += c.length;
        if (size > MAX_BODY) {
          rej(new HttpError(413, "内容太大"));
          req.destroy();
        } else chunks.push(c);
      });
      req.on("end", () => {
        try {
          res(JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}"));
        } catch {
          rej(new HttpError(400, "JSON 格式错误"));
        }
      });
      req.on("error", rej);
    });

  const json = (res: ServerResponse, code: number, body: unknown) => {
    res.writeHead(code, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
    res.end(JSON.stringify(body));
  };

  const fetchQuota = o.quota ?? (() => readQuotas());
  let quotaCache: { at: number; value: Promise<QuotaReport> } | null = null;
  const refine = o.refine ?? refineRole;

  const botView = (b: Bot) => ({ ...b, research_enabled: Boolean(engine.research.settings(Memory.projectId(b.cwd)).enabled), can_call: b.can_call ? JSON.parse(b.can_call) : null, usage: o.store.botUsage(b.id), conversations: o.store.listConversations(b.id), project_memory: Memory.projectId(b.cwd) });
  const groupView = (g: Group) => ({ ...g, research_enabled: Boolean(engine.research.settings(Memory.projectId(g.cwd)).enabled), members: o.store.groupMembers(g.id).map((m) => m.id), conversations: o.store.listGroupConversations(g.id), project_memory: Memory.projectId(g.cwd) });

  const validateGroup = async (input: any, existing?: Group) => {
    const out: any = {};
    if (input.name !== undefined) {
      out.name = String(input.name).trim().slice(0, 40);
      if (!out.name) throw new HttpError(400, "请填写群聊名称");
    }
    if (input.budget_tokens !== undefined) out.budget_tokens = validBudget(input.budget_tokens);
    if (input.cwd) {
      if (typeof input.cwd !== "string" || !isAbsolute(input.cwd)) throw new HttpError(400, "工作目录必须是绝对路径");
      const s = await stat(input.cwd).catch(() => null);
      if (!s?.isDirectory()) throw new HttpError(400, "工作目录不存在");
      out.cwd = input.cwd;
    }
    if (input.members !== undefined) {
      if (!Array.isArray(input.members) || input.members.length < 2) throw new HttpError(400, "群聊至少要有两个成员");
      if (input.members.some((id: unknown) => typeof id !== "string" || !o.store.getBot(id))) throw new HttpError(400, "成员不存在");
      out.members = [...new Set(input.members as string[])];
    }
    if (!existing && (!out.name || !out.members)) throw new HttpError(400, "请填写群聊名称并选择成员");
    return out;
  };

  const route = async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? "/", "http://localhost");
    const parts = pathname.split("/").filter(Boolean);
    const m = req.method;

    if (m === "GET" && STATIC[pathname]) {
      const s = STATIC[pathname];
      const body = await readFile(join(o.webDir, s.file));
      res.writeHead(200, { "content-type": s.type, "content-security-policy": CSP, "x-content-type-options": "nosniff", "referrer-policy": "no-referrer", "cache-control": "no-cache" });
      return void res.end(body);
    }
    // Agents reach this through bus-mcp.mjs. The token, not the request body, says which Bot is calling.
    if (m === "POST" && pathname === "/internal/bus") {
      const auth = req.headers.authorization ?? "";
      const body = await readJson(req);
      // Failures go back to the calling agent as tool errors, so it can react to them.
      const result = await engine.handleBus(auth.replace(/^Bearer /, ""), String(body.tool), body.args ?? {}).catch((e) => ({ text: (e as Error).message, isError: true }));
      return json(res, 200, result);
    }
    if (m === "GET" && pathname === "/api/events") {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-store", connection: "keep-alive" });
      res.write(": connected\n\n");
      clients.add(res);
      req.on("close", () => clients.delete(res));
      return;
    }
    if (parts[0] !== "api") throw new HttpError(404, "Not found");

    if (m === "GET" && pathname === "/api/state") return json(res, 200, { steerable: STEERABLE, settings: o.store.settings(), bots: o.store.listBots().map(botView), groups: o.store.listGroups().map(groupView), agents: await status(), chief_default_role: CHIEF_ROLE });
    if (pathname === "/api/settings") {
      if (m === "GET") return json(res, 200, { settings: o.store.settings(), home: o.store.home });
      if (m === "PUT") {
        const settings = o.store.saveSettings(validateSettings(await readJson(req)));
        broadcast({ type: "settings", settings });
        return json(res, 200, { settings });
      }
    }
    if (m === "GET" && pathname === "/api/quotas") {
      // Reading quota costs no tokens but does call the vendors, so it stays rate-limited.
      const force = new URL(req.url ?? "/", "http://localhost").searchParams.has("refresh");
      const age = quotaCache ? Date.now() - quotaCache.at : Infinity;
      if (age > 60000 || (force && age > 10000)) quotaCache = { at: Date.now(), value: fetchQuota() };
      return json(res, 200, await quotaCache!.value);
    }
    if (m === "POST" && pathname === "/api/role/refine") {
      const body = await readJson(req);
      const draft = String(body.draft ?? "").slice(0, 8000);
      const name = String(body.name ?? "").slice(0, 40);
      if (!draft.trim() && !name.trim()) throw new HttpError(400, "先写一点职责，或至少填上名称");
      return json(res, 200, { role: await refine({ name, draft, chief: Boolean(body.chief) }) });
    }
    if (m === "POST" && pathname === "/api/groups") {
      const g = o.store.createGroup(await validateGroup(await readJson(req)));
      broadcast({ type: "group", group: groupView(g) });
      return json(res, 201, groupView(g));
    }
    if (parts[1] === "groups" && parts[2]) {
      const cur = o.store.getGroup(parts[2]);
      if (!cur) throw new HttpError(404, "群聊不存在");
      if (m === "POST" && parts[3] === "messages") {
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "消息不能为空");
        if (body.text.length > MAX_MESSAGE) throw new HttpError(413, "消息太长");
        return json(res, 202, await engine.sendGroupMessage(cur.id, typeof body.conversationId === "string" ? body.conversationId : null, body.text));
      }
      if (m === "PATCH" && !parts[3]) {
        const g = o.store.updateGroup(cur.id, await validateGroup(await readJson(req), cur))!;
        broadcast({ type: "group", group: groupView(g) });
        return json(res, 200, groupView(g));
      }
      if (m === "DELETE" && !parts[3]) {
        engine.archiveGroup(cur.id);
        return json(res, 200, { ok: true });
      }
    }
    if (m === "POST" && pathname === "/api/bots") {
      const bot = o.store.createBot(await checkBot(await readJson(req)));
      broadcast({ type: "bot", bot: botView(bot) });
      return json(res, 201, botView(bot));
    }
    if (parts[1] === "bots" && parts[2] && !parts[3]) {
      const cur = o.store.getBot(parts[2]);
      if (!cur) throw new HttpError(404, "Bot 不存在");
      if (m === "PATCH") {
        const patch = await checkBot(await readJson(req), cur);
        if (patch.cwd === "") delete patch.cwd;
        const bot = o.store.updateBot(cur.id, patch)!;
        broadcast({ type: "bot", bot: botView(bot) });
        return json(res, 200, botView(bot));
      }
      if (m === "DELETE") {
        engine.archiveBot(cur.id);
        return json(res, 200, { ok: true });
      }
    }
    if (m === "POST" && parts[1] === "bots" && parts[3] === "messages") {
      const body = await readJson(req);
      const text = body.text;
      if (typeof text !== "string" || !text.trim()) throw new HttpError(400, "消息不能为空");
      if (text.length > MAX_MESSAGE) throw new HttpError(413, "消息太长");
      const conv = await engine.sendMessage(parts[2], typeof body.conversationId === "string" ? body.conversationId : null, text);
      return json(res, 202, conv);
    }
    if (m === "GET" && pathname === "/api/tasks") {
      const conv = new URL(req.url ?? "/", "http://localhost").searchParams.get("conv");
      return json(res, 200, { tasks: engine.listTasks(conv || null) });
    }
    if (m === "POST" && parts[1] === "tasks" && parts[2] && parts[3] === "retry") {
      await readJson(req);
      return json(res, 202, engine.retryTask(parts[2]));
    }
    if (parts[1] === "conversations" && parts[2]) {
      if (m === "GET" && parts[3] === "items") {
        const conv = o.store.getConversation(parts[2]);
        if (!conv) throw new HttpError(404, "对话不存在");
        return json(res, 200, { conversation: conv, items: o.store.listItems(conv.id), activity: engine.activity(conv.id) });
      }
      if (m === "GET" && parts[3] === "worktrees") return json(res, 200, { worktrees: o.store.listWorktrees(parts[2]).filter((w) => w.status === "active") });
      if (m === "GET" && parts[3] === "trace") return json(res, 200, engine.trace(parts[2]));
      if (m === "POST" && parts[3] === "followup") {
        const body = await readJson(req);
        if (typeof body.text !== "string" || !body.text.trim()) throw new HttpError(400, "消息不能为空");
        if (body.text.length > MAX_MESSAGE) throw new HttpError(413, "消息太长");
        return json(res, 202, await engine.followUp(parts[2], body.text, body.mode === "steer" ? "steer" : "queue"));
      }
      if (m === "POST" && parts[3] === "interrupt") {
        await readJson(req);
        await engine.interrupt(parts[2]);
        return json(res, 202, { ok: true });
      }
      if (m === "DELETE" && !parts[3]) {
        engine.archiveConversation(parts[2]);
        return json(res, 200, { ok: true });
      }
    }
    if (parts[1] === "items" && parts[2]) {
      if (m === "POST" && parts[3] === "withdraw") {
        await readJson(req);
        return json(res, 200, engine.withdrawQueued(parts[2]));
      }
      if (m === "POST" && parts[3] === "accept") {
        await readJson(req);
        return json(res, 200, engine.acceptResult(parts[2]));
      }
      if (m === "GET" && parts[3] === "diff") return json(res, 200, await engine.resultDiff(parts[2]));
    }
    if (m === "POST" && parts[1] === "approvals" && parts[2]) {
      const { decision, spec } = await readJson(req);
      if (!["allow", "allow_session", "deny"].includes(decision)) throw new HttpError(400, "决定无效");
      return json(res, 200, await engine.answerApproval(parts[2], decision as ApprovalDecision, spec));
    }
    if (parts[1] === "memory" && parts[2] && parts[3]) {
      if (parts[2] !== "bot" && parts[2] !== "project") throw new HttpError(404, "Not found");
      const scope = parts[2] as MemoryScope;
      const id = parts[3];
      if (m === "GET" && !parts[4]) return json(res, 200, { content: engine.memory.read(scope, id), history: await engine.memory.history(scope, id) });
      if (m === "PUT" && !parts[4]) {
        const { content } = await readJson(req);
        if (typeof content !== "string") throw new HttpError(400, "内容无效");
        await engine.memory.write(scope, id, content, "用户修改");
        engine.noteMemoryEdited();
        return json(res, 200, { ok: true });
      }
      if (m === "POST" && parts[4] === "rollback") {
        const { hash } = await readJson(req);
        await engine.memory.rollback(scope, id, String(hash));
        engine.noteMemoryEdited();
        return json(res, 200, { ok: true });
      }
    }
    if (parts[1] === "projects" && parts[2]) {
      const pid = parts[2];
      if (!/^[0-9a-f]{16}$/.test(pid)) throw new HttpError(400, "项目 ID 无效");
      const r = engine.research;
      if (m === "GET" && parts[3] === "research") {
        const experiments = r.listExperiments(pid);
        return json(res, 200, { settings: r.settings(pid), targets: r.listTargets(), ideas: r.listIdeas(pid), experiments, summary: summarize(experiments), finalEvals: r.finalEvalCount(pid) });
      }
      if (m === "PUT" && parts[3] === "settings") return json(res, 200, r.saveSettings(pid, await readJson(req)));
      if (m === "POST" && parts[3] === "ideas") return json(res, 201, r.addIdea(pid, await readJson(req), "用户"));
    }
    if (parts[1] === "targets") {
      if (m === "GET" && !parts[2]) return json(res, 200, { targets: engine.research.listTargets() });
      if (m === "POST" && !parts[2]) return json(res, 201, engine.research.saveTarget(await readJson(req)));
      if (m === "DELETE" && parts[2]) {
        engine.research.deleteTarget(parts[2]);
        return json(res, 200, { ok: true });
      }
    }
    if (m === "PATCH" && parts[1] === "ideas" && parts[2]) return json(res, 200, engine.research.updateIdea(parts[2], await readJson(req), true));
    if (parts[1] === "experiments" && parts[2]) {
      const r = engine.research;
      if (m === "GET" && parts[3] === "log") return json(res, 200, { log: r.logTail(parts[2]) });
      if (m === "GET" && parts[3] === "manifest") return json(res, 200, { cases: r.manifest(parts[2]) });
      if (m === "GET" && parts[3] === "file") {
        const { file, type } = r.artifactFile(parts[2], new URL(req.url ?? "/", "http://localhost").searchParams.get("path") ?? "");
        res.writeHead(200, { "content-type": type, "x-content-type-options": "nosniff", "cache-control": "private, max-age=3600", "content-security-policy": "default-src 'none'" });
        return void res.end(await readFile(file));
      }
      if (m === "POST" && parts[3] === "cancel") {
        await readJson(req);
        return json(res, 200, await r.cancel(parts[2]));
      }
      // Only this route starts a test-set evaluation, and no agent tool reaches it.
      if (m === "POST" && parts[3] === "final-eval") {
        await readJson(req);
        await r.finalEval(parts[2]);
        return json(res, 202, { ok: true });
      }
    }
    if (parts[1] === "worktrees" && parts[2]) {
      const wt = o.store.getWorktree(parts[2]);
      if (!wt) throw new HttpError(404, "工作树不存在");
      if (m === "GET" && parts[3] === "diff") return json(res, 200, await engine.worktrees.diff(wt.id));
      if (m === "POST" && (parts[3] === "merge" || parts[3] === "discard")) {
        await readJson(req);
        // An agent may still be writing in it.
        if (engine.conversationRunning(wt.root_conv_id)) throw new HttpError(409, "这个对话还在进行中，请等它结束");
        if (engine.research.jobRunningIn(wt.path)) throw new HttpError(409, "这个工作树里还有实验在运行");
        await (parts[3] === "merge" ? engine.worktrees.merge(wt.id) : engine.worktrees.discard(wt.id));
        broadcast({ type: "worktrees", convId: wt.root_conv_id });
        return json(res, 200, { ok: true });
      }
    }
    throw new HttpError(404, "Not found");
  };

  const server: Server = createServer(async (req, res) => {
    if (!allowed(req)) {
      res.writeHead(403, { "content-type": "text/plain" });
      return void res.end("Forbidden");
    }
    try {
      await route(req, res);
    } catch (e) {
      if (res.headersSent) return void res.end();
      if (e instanceof HttpError) return json(res, e.status, { error: e.message });
      console.error(e);
      json(res, 500, { error: "内部错误" });
    }
  });

  const heartbeat = setInterval(() => {
    for (const c of clients) c.write(": ping\n\n");
  }, 20000);
  heartbeat.unref();

  return {
    server,
    engine,
    close() {
      clearInterval(heartbeat);
      engine.shutdown();
      for (const c of clients) c.end();
      server.close();
      server.closeAllConnections();
    },
  };
}
