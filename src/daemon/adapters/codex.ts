import type { AgentRuntime, ApprovalDecision, RuntimeOptions } from "../types.ts";
import { clip, spawnLines, type LineProcess } from "./process.ts";

const OFFICIAL_BASE_URL = "https://chatgpt.com/backend-api/codex";
const RPC_TIMEOUT_MS = 60000;
// In ask mode the sandbox reads as read-only, and without this Codex sometimes gives up
// before trying, so the user never gets the chance to approve.
const ASK_MODE_NOTE = "用户要求写文件或运行命令时，请直接调用工具尝试。即使环境显示为只读，平台也会先询问用户是否批准，不要在尝试前就说无法完成。";

type Pending = { method: string; id: number | string; params: any };

export class CodexRuntime implements AgentRuntime {
  private proc: LineProcess | null = null;
  private readonly opts: RuntimeOptions;
  private nextId = 1;
  private readonly calls = new Map<number, { res: (v: any) => void; rej: (e: Error) => void; timer: NodeJS.Timeout }>();
  private readonly pending = new Map<string, Pending>();
  private readonly fileChanges = new Map<string, string>();
  private threadId: string | null = null;
  private turnId: string | null = null;
  private inTurn = false;
  private interrupting = false;
  private stopping = false;
  private sessionAnnounced = false;
  private usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }

  async start() {
    const o = this.opts;
    const args = ["app-server"];
    // The user's config points Codex at a local gateway; each Bot states its route explicitly.
    if (o.route === "official") args.push("-c", `openai_base_url="${OFFICIAL_BASE_URL}"`);
    this.proc = spawnLines("codex", args, o.cwd, (m) => this.onMessage(m), (d) => {
      const tail = this.proc?.stderrTail() || d.error || "";
      for (const c of this.calls.values()) {
        clearTimeout(c.timer);
        c.rej(new Error(`Codex 已退出${tail ? "：" + clip(tail, 300) : ""}`));
      }
      this.calls.clear();
      if (this.inTurn && !this.stopping) {
        o.onEvent({ type: "turn_end", status: this.interrupting ? "interrupted" : "failed", error: this.interrupting ? undefined : `Codex 意外退出（${d.code ?? d.signal}）${tail ? "：" + clip(tail, 400) : ""}` });
      }
      this.inTurn = false;
      o.onEvent({ type: "exit", error: this.stopping ? undefined : tail || undefined });
    });
    await this.call("initialize", { clientInfo: { name: "bot_platform", title: "Bot Platform", version: "0.1.0" } });
    this.proc.write({ method: "initialized" });
    const thread = {
      model: o.model,
      cwd: o.cwd,
      approvalPolicy: o.permission === "auto_edit" ? "on-request" : o.permission === "read_only" ? "never" : "untrusted",
      sandbox: o.permission === "auto_edit" ? "workspace-write" : "read-only",
      developerInstructions: [o.systemPrompt, o.permission === "ask" ? ASK_MODE_NOTE : ""].filter(Boolean).join("\n\n") || null,
      ...(o.bus ? { config: { mcp_servers: { botbus: { ...o.bus, default_tools_approval_mode: "approve", tool_timeout_sec: 3600 } } } } : {}),
    };
    const r = o.sessionId ? await this.call("thread/resume", { threadId: o.sessionId, ...thread }) : await this.call("thread/start", thread);
    this.threadId = r?.thread?.id ?? o.sessionId;
    this.sessionAnnounced = Boolean(o.sessionId);
  }

  async send(text: string) {
    this.inTurn = true;
    this.interrupting = false;
    this.usage = { inputTokens: 0, cachedTokens: 0, outputTokens: 0 };
    try {
      const r = await this.call("turn/start", { threadId: this.threadId, input: [{ type: "text", text }], effort: this.opts.effort, model: this.opts.model });
      this.turnId = r?.turn?.id ?? this.turnId;
      // A thread cannot be resumed until it has a turn, so the id is only recorded now.
      if (!this.sessionAnnounced && this.threadId) {
        this.sessionAnnounced = true;
        this.opts.onEvent({ type: "session", sessionId: this.threadId });
      }
    } catch (e) {
      this.inTurn = false;
      this.opts.onEvent({ type: "turn_end", status: "failed", error: (e as Error).message });
    }
  }

  async steer(text: string) {
    if (!this.inTurn || !this.turnId) throw new Error("没有进行中的回合");
    await this.call("turn/steer", { threadId: this.threadId, expectedTurnId: this.turnId, input: [{ type: "text", text }] });
  }

  async interrupt() {
    if (!this.inTurn || !this.turnId) return;
    this.interrupting = true;
    await this.call("turn/interrupt", { threadId: this.threadId, turnId: this.turnId }).catch(() => {});
  }

  answerApproval(requestId: string, decision: ApprovalDecision) {
    const req = this.pending.get(requestId);
    if (!req) return;
    this.pending.delete(requestId);
    this.proc?.write({ id: req.id, result: this.approvalResult(req, decision) });
  }

  stop() {
    this.stopping = true;
    this.proc?.child.kill();
  }

  private approvalResult(req: Pending, decision: ApprovalDecision) {
    switch (req.method) {
      case "mcpServer/elicitation/request":
        return { action: decision === "deny" ? "decline" : "accept", content: null };
      case "item/permissions/requestApproval":
        return decision === "deny" ? { permissions: {}, scope: "turn" } : { permissions: req.params?.permissions ?? {}, scope: decision === "allow_session" ? "session" : "turn" };
      case "applyPatchApproval":
      case "execCommandApproval":
        return { decision: decision === "deny" ? "denied" : decision === "allow_session" ? "approved_for_session" : "approved" };
      default:
        return { decision: decision === "deny" ? "decline" : decision === "allow_session" ? "acceptForSession" : "accept" };
    }
  }

  private call(method: string, params: unknown): Promise<any> {
    return new Promise((res, rej) => {
      const id = this.nextId++;
      const timer = setTimeout(() => {
        this.calls.delete(id);
        rej(new Error(`Codex 没有响应 ${method}`));
      }, RPC_TIMEOUT_MS);
      this.calls.set(id, { res, rej, timer });
      this.proc?.write({ id, method, params });
    });
  }

  private onMessage(m: any) {
    if (m.id !== undefined && !m.method) {
      const c = this.calls.get(m.id);
      if (!c) return;
      this.calls.delete(m.id);
      clearTimeout(c.timer);
      if (m.error) c.rej(new Error(m.error.message ?? JSON.stringify(m.error)));
      else c.res(m.result);
      return;
    }
    if (m.id !== undefined && m.method) return this.onServerRequest(m);
    this.onNotification(m.method, m.params ?? {});
  }

  private onServerRequest(m: any) {
    const emit = this.opts.onEvent;
    const p = m.params ?? {};
    const key = String(m.id);
    const ask = (title: string, detail: string, canRemember = true) => {
      this.pending.set(key, { method: m.method, id: m.id, params: p });
      emit({ type: "approval", requestId: key, title, detail, canRemember });
    };
    switch (m.method) {
      case "item/commandExecution/requestApproval":
      case "execCommandApproval": {
        const command = Array.isArray(p.command) ? p.command.join(" ") : p.command;
        const lines = [String(command ?? ""), p.cwd ? `\n目录：${p.cwd}` : "", p.reason ? `\n原因：${p.reason}` : ""];
        return ask(`运行命令：${String(command ?? "").split("\n")[0].slice(0, 80)}`, clip(lines.join("")));
      }
      case "item/fileChange/requestApproval":
      case "applyPatchApproval":
        return ask("修改文件", clip({ reason: p.reason ?? undefined, grantRoot: p.grantRoot ?? undefined, changes: this.fileChanges.get(p.itemId) ?? p.fileChanges ?? undefined }));
      case "item/permissions/requestApproval":
        return ask("申请额外权限", clip({ reason: p.reason ?? undefined, permissions: p.permissions }));
      case "mcpServer/elicitation/request":
        return ask(`工具 ${p.serverName ?? ""} 请求确认`, clip(p), false);
      case "item/tool/requestUserInput":
        // No structured question form yet: the agent falls back to asking in chat.
        this.proc?.write({ id: m.id, result: { answers: {} } });
        return;
      default:
        this.proc?.write({ id: m.id, error: { code: -32601, message: `unsupported: ${m.method}` } });
    }
  }

  private onNotification(method: string, p: any) {
    const emit = this.opts.onEvent;
    switch (method) {
      case "turn/started":
        this.turnId = p.turn?.id ?? this.turnId;
        return;
      case "item/agentMessage/delta":
        return emit({ type: "text_delta", key: p.itemId, text: p.delta ?? "" });
      case "item/started":
      case "item/completed":
        return this.onItem(p.item ?? {}, method === "item/completed");
      case "thread/tokenUsage/updated": {
        // `last` covers one model request; a turn can make several.
        const l = p.tokenUsage?.last;
        if (l) {
          this.usage.inputTokens += l.inputTokens ?? 0;
          this.usage.cachedTokens += l.cachedInputTokens ?? 0;
          this.usage.outputTokens += l.outputTokens ?? 0;
          this.opts.onEvent({ type: "usage_tick", tokens: (l.inputTokens ?? 0) - (l.cachedInputTokens ?? 0) + (l.outputTokens ?? 0) });
        }
        return;
      }
      case "error":
        if (!p.willRetry) this.lastError = p.error?.message ?? clip(p, 400);
        return;
      case "turn/completed": {
        const status = p.turn?.status;
        emit({ type: "usage", ...this.usage });
        const wasInterrupting = this.interrupting;
        this.inTurn = false;
        this.interrupting = false;
        if (status === "interrupted" || wasInterrupting) emit({ type: "turn_end", status: "interrupted" });
        else if (status === "failed") emit({ type: "turn_end", status: "failed", error: p.turn?.error?.message ?? this.lastError ?? "Codex 这一轮失败了" });
        else emit({ type: "turn_end", status: "completed" });
        this.lastError = null;
        return;
      }
    }
  }

  private lastError: string | null = null;

  private onItem(it: any, done: boolean) {
    const emit = this.opts.onEvent;
    switch (it.type) {
      case "agentMessage":
        if (done) emit({ type: "text_done", key: it.id, text: it.text ?? "" });
        return;
      case "commandExecution": {
        const failed = it.status === "failed" || it.status === "declined" || (it.exitCode ?? 0) !== 0;
        emit({
          type: "tool",
          key: it.id,
          title: `运行命令：${String(it.command ?? "").split("\n")[0].slice(0, 80)}`,
          detail: clip({ command: it.command, cwd: it.cwd }),
          output: done ? clip(it.aggregatedOutput ?? "") : undefined,
          status: done ? (failed ? "failed" : "done") : "running",
          command: String(it.command ?? "") || undefined,
        });
        return;
      }
      case "fileChange": {
        const changes = clip(it.changes);
        this.fileChanges.set(it.id, changes);
        const paths = (it.changes ?? []).map((c: any) => c.path).filter(Boolean);
        emit({ type: "tool", key: it.id, title: `修改 ${paths.join("、").slice(0, 80) || "文件"}`, detail: changes, status: done ? (it.status === "completed" ? "done" : "failed") : "running", files: paths.map(String) });
        return;
      }
      case "mcpToolCall":
        emit({ type: "tool", key: it.id, title: `工具 ${it.server ?? ""} / ${it.tool ?? ""}`, detail: clip(it.arguments), output: done ? clip(it.result ?? it.error) : undefined, status: done ? (it.error ? "failed" : "done") : "running" });
        return;
      case "webSearch":
        emit({ type: "tool", key: it.id, title: `搜索网页：${it.query ?? ""}`, status: done ? "done" : "running" });
        return;
    }
  }
}
