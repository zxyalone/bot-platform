import { execFile } from "node:child_process";
import { appendFileSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve } from "node:path";
import type { AgentKind, AgentRuntime, ApprovalDecision, RuntimeOptions } from "../types.ts";
import { agentEnv, clip, spawnLines, type LineProcess } from "./process.ts";

const RPC_TIMEOUT_MS = 60000;
const SAFE_KINDS = ["read", "search", "think", "fetch"];

export type AcpLaunch = { command: string; args: string[]; modelId?: string; usage?: (sessionId: string) => Promise<UsageNumbers | null> };
type UsageNumbers = { inputTokens: number; cachedTokens: number; outputTokens: number };

// Grok's ACP mode does not report usage, but its CLI records every turn.
async function grokUsage(sessionId: string): Promise<UsageNumbers | null> {
  const out = await new Promise<string>((res) => execFile("grok", ["usage", sessionId], { env: agentEnv(), timeout: 10000 }, (e, stdout) => res(e ? "" : stdout)));
  try {
    const t = JSON.parse(out).turns?.at(-1);
    return t ? { inputTokens: t.inputTokens ?? 0, cachedTokens: t.cachedReadTokens ?? 0, outputTokens: t.outputTokens ?? 0 } : null;
  } catch {
    return null;
  }
}

// Follows symlinks through the part of the path that exists. /var vs /private/var on macOS would
// otherwise read as outside the directory, and a link pointing out of it as inside.
function realPath(p: string) {
  const rest: string[] = [];
  for (let cur = p; ; cur = dirname(cur)) {
    try {
      return join(realpathSync(cur), ...rest);
    } catch {
      if (dirname(cur) === cur) return p;
      rest.unshift(basename(cur));
    }
  }
}

export function acpLaunch(o: RuntimeOptions): AcpLaunch {
  if ((o.agent as AgentKind) === "grok") return { command: "grok", args: ["agent", "-m", o.model, "--reasoning-effort", o.effort, "stdio"], usage: grokUsage };
  // Antigravity encodes the effort in the model id.
  return { command: "agy", args: ["acp"], modelId: `${o.model}-${o.effort}` };
}

export class AcpRuntime implements AgentRuntime {
  private proc: LineProcess | null = null;
  private readonly opts: RuntimeOptions;
  private readonly launch: AcpLaunch;
  private nextId = 1;
  private readonly calls = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout | null }>();
  private readonly pending = new Map<string, { id: number | string; options: any[]; rememberKey: string }>();
  private readonly remembered = new Set<string>();
  private sessionId: string | null = null;
  private inTurn = false;
  private interrupting = false;
  private stopping = false;
  private loading = false;
  private systemSent = false;
  private segment = 0;
  private segmentText = "";
  private segmentOpen = false;

  constructor(opts: RuntimeOptions, launch?: AcpLaunch) {
    this.opts = opts;
    this.launch = launch ?? acpLaunch(opts);
  }

  async start() {
    const o = this.opts;
    this.proc = spawnLines(this.launch.command, this.launch.args, o.cwd, (m) => this.onMessage(m), (d) => {
      const tail = this.proc?.stderrTail() || d.error || "";
      for (const c of this.calls.values()) {
        if (c.timer) clearTimeout(c.timer);
        c.rej(new Error(`agent 已退出${tail ? "：" + clip(tail, 300) : ""}`));
      }
      this.calls.clear();
      this.inTurn = false;
      o.onEvent({ type: "exit", error: this.stopping ? undefined : tail || undefined });
    });
    const init = await this.call("initialize", { protocolVersion: 1, clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false }, clientInfo: { name: "bot-platform", version: "0.1.0" } });
    const mcpServers = o.bus ? [{ name: "botbus", command: o.bus.command, args: o.bus.args, env: Object.entries(o.bus.env).map(([name, value]) => ({ name, value })) }] : [];
    if (o.sessionId && init?.agentCapabilities?.loadSession) {
      // Loading replays the old conversation as updates, which must not reappear as new messages.
      this.loading = true;
      try {
        await this.call("session/load", { sessionId: o.sessionId, cwd: o.cwd, mcpServers });
        this.sessionId = o.sessionId;
      } catch {
        // The saved session is gone (usually a turn that never reached the agent). Start over rather than get stuck.
      }
      this.loading = false;
    }
    if (!this.sessionId) {
      const r = await this.call("session/new", { cwd: o.cwd, mcpServers });
      this.sessionId = r?.sessionId;
      if (!this.sessionId) throw new Error("agent 没有返回会话 ID");
    }
    if (this.launch.modelId) await this.call("session/set_model", { sessionId: this.sessionId, modelId: this.launch.modelId });
  }

  async send(text: string) {
    this.inTurn = true;
    this.interrupting = false;
    this.opts.onEvent({ type: "session", sessionId: this.sessionId! });
    // ACP has no common way to set a system prompt, so it goes with the first message of each process.
    const first = !this.systemSent && this.opts.systemPrompt ? `[系统设定，不是用户发的]\n${this.opts.systemPrompt}\n[设定结束]\n\n` : "";
    this.systemSent = true;
    void this.runPrompt(first + text);
  }

  private async runPrompt(text: string) {
    const emit = this.opts.onEvent;
    let result: any;
    try {
      result = await this.call("session/prompt", { sessionId: this.sessionId, prompt: [{ type: "text", text }] }, true);
    } catch (e) {
      const stopped = this.interrupting;
      this.closeSegment();
      if (this.stopping) return;
      emit({ type: "turn_end", status: stopped ? "interrupted" : "failed", error: stopped ? undefined : (e as Error).message });
      this.inTurn = false;
      return;
    }
    this.closeSegment();
    const u = result?.usage;
    const usage = u ? { inputTokens: u.inputTokens ?? 0, cachedTokens: u.cachedReadTokens ?? 0, outputTokens: u.outputTokens ?? 0 } : await this.launch.usage?.(this.sessionId!).catch(() => null);
    if (usage) emit({ type: "usage", ...usage });
    const wasInterrupting = this.interrupting;
    this.inTurn = false;
    this.interrupting = false;
    // Grok also ends a turn as "cancelled" when a tool was denied; only a real stop counts as one.
    // Its last words are then still "I'm about to do it", so whoever reads this reply must be told otherwise.
    if (result?.stopReason === "cancelled" && !wasInterrupting) emit({ type: "text_done", key: `denied${++this.segment}`, text: "（工具调用被拒绝，这一轮到此结束，上面说要做的事没有完成。）" });
    emit({ type: "turn_end", status: wasInterrupting ? "interrupted" : result?.stopReason === "refusal" ? "failed" : "completed", error: result?.stopReason === "refusal" ? "模型拒绝了这次请求" : undefined });
  }

  async interrupt() {
    if (!this.inTurn) return;
    this.interrupting = true;
    for (const [key, p] of this.pending) {
      this.proc?.write({ jsonrpc: "2.0", id: p.id, result: { outcome: { outcome: "cancelled" } } });
      this.pending.delete(key);
    }
    this.proc?.write({ jsonrpc: "2.0", method: "session/cancel", params: { sessionId: this.sessionId } });
  }

  answerApproval(requestId: string, decision: ApprovalDecision) {
    const p = this.pending.get(requestId);
    if (!p) return;
    this.pending.delete(requestId);
    if (decision === "allow_session") this.remembered.add(p.rememberKey);
    this.respond(p.id, p.options, decision !== "deny");
  }

  stop() {
    this.stopping = true;
    this.proc?.child.kill();
  }

  // Always a one-time grant: an agent's own "allow always" could outlive this conversation.
  private respond(id: number | string, options: any[], allow: boolean) {
    const kinds = allow ? ["allow_once", "allow_always"] : ["reject_once", "reject_always"];
    const pick = kinds.map((k) => options.find((o) => o.kind === k)).find(Boolean);
    this.proc?.write({ jsonrpc: "2.0", id, result: { outcome: pick ? { outcome: "selected", optionId: pick.optionId } : { outcome: "cancelled" } } });
  }

  private call(method: string, params: unknown, noTimeout = false): Promise<any> {
    return new Promise((res, rej) => {
      const id = this.nextId++;
      const timer = noTimeout
        ? null
        : setTimeout(() => {
            this.calls.delete(id);
            rej(new Error(`agent 没有响应 ${method}`));
          }, RPC_TIMEOUT_MS);
      this.calls.set(id, { res, rej, timer });
      this.proc?.write({ jsonrpc: "2.0", id, method, params });
    });
  }

  private onMessage(m: any) {
    if (m.id !== undefined && !m.method) {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      if (c.timer) clearTimeout(c.timer);
      if (m.error) c.rej(new Error(m.error.message ?? JSON.stringify(m.error).slice(0, 300)));
      else c.res(m.result);
    } else if (m.method === "session/request_permission") {
      this.onPermission(m);
    } else if (m.method === "session/update") {
      if (!this.loading) this.onUpdate(m.params?.update ?? {});
    } else if (m.id !== undefined) {
      this.proc?.write({ jsonrpc: "2.0", id: m.id, error: { code: -32601, message: "unsupported" } });
    }
  }

  private inCwd(path: unknown) {
    if (typeof path !== "string") return false;
    const rel = relative(realPath(this.opts.cwd), realPath(resolve(this.opts.cwd, path)));
    return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
  }

  private onPermission(m: any) {
    const p = m.params ?? {};
    const options = p.options ?? [];
    const tc = p.toolCall ?? {};
    if (process.env.BOT_ACP_TRACE) appendFileSync(process.env.BOT_ACP_TRACE, JSON.stringify({ agent: this.opts.agent, permission: this.opts.permission, tc }) + "\n");
    const title = String(tc.title ?? "工具调用");
    const kind = String(tc.kind ?? "");
    const preset = this.opts.permission;
    // The bus enforces its own limits, and a Bot asking a colleague is not something to confirm each time.
    if (/botbus/i.test(`${title} ${tc.toolCallId ?? ""} ${tc.toolName ?? ""}`)) return this.respond(m.id, options, true);
    if (SAFE_KINDS.includes(kind)) return this.respond(m.id, options, true);
    // Unknown kinds count as writes: being wrong here should cost a refusal, not a file.
    if (preset === "read_only") return this.respond(m.id, options, false);
    // Vendors put the path in different places. No path means the request is not auto-approved.
    const paths = [...(tc.locations ?? []).map((l: any) => l?.path), tc.rawInput?.file_path, tc.rawInput?.path, tc.args?.Path].filter(Boolean);
    if (preset === "auto_edit" && kind === "edit" && paths.length && paths.every((x: unknown) => this.inCwd(x))) return this.respond(m.id, options, true);
    const rememberKey = title;
    if (this.remembered.has(rememberKey)) return this.respond(m.id, options, true);
    const key = String(m.id);
    this.pending.set(key, { id: m.id, options, rememberKey });
    this.opts.onEvent({ type: "approval", requestId: key, title: title.slice(0, 160), detail: clip(tc.rawInput ?? tc.content ?? title), canRemember: true });
  }

  private closeSegment() {
    if (!this.segmentOpen) return;
    this.segmentOpen = false;
    // Antigravity prefixes relayed tool output with these two lines.
    const text = this.segmentText.replace(/^Created At: .*\nCompleted At: .*\n/, "");
    this.opts.onEvent({ type: "text_done", key: `seg${this.segment}`, text });
    this.segmentText = "";
  }

  private onUpdate(u: any) {
    const emit = this.opts.onEvent;
    switch (u.sessionUpdate) {
      case "agent_message_chunk":
        if (u.content?.type !== "text" || !u.content.text) return;
        if (!this.segmentOpen) {
          this.segmentOpen = true;
          this.segment++;
        }
        this.segmentText += u.content.text;
        emit({ type: "text_delta", key: `seg${this.segment}`, text: u.content.text });
        return;
      case "tool_call":
        this.closeSegment();
        emit({ type: "tool", key: u.toolCallId, title: String(u.title ?? "工具调用").slice(0, 160), detail: clip(u.rawInput), status: u.status === "failed" ? "failed" : u.status === "completed" ? "done" : "running" });
        return;
      case "tool_call_update": {
        const status = u.status === "failed" ? "failed" : u.status === "completed" ? "done" : "running";
        const output = (u.content ?? []).map((c: any) => c?.content?.text ?? c?.text ?? "").filter(Boolean).join("\n");
        emit({ type: "tool", key: u.toolCallId, title: u.title ? String(u.title).slice(0, 160) : "", output: output ? clip(output) : undefined, status });
        return;
      }
    }
  }
}
