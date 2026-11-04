import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AgentRuntime, ApprovalDecision, RuntimeOptions } from "../types.ts";
import { clip, spawnLines, type LineProcess } from "./process.ts";

const fileName = (p: unknown) => (typeof p === "string" && p ? basename(p) : "文件");

const toolTitle = (name: string, input: any): string => {
  if (name === "Bash") return `运行命令：${String(input?.command ?? "").split("\n")[0].slice(0, 80)}`;
  if (name === "Write") return `写入 ${fileName(input?.file_path)}`;
  if (name === "Edit" || name === "MultiEdit") return `修改 ${fileName(input?.file_path)}`;
  if (name === "Read") return `读取 ${fileName(input?.file_path)}`;
  if (name === "Grep" || name === "Glob") return `搜索 ${input?.pattern ?? ""}`;
  if (name === "WebSearch") return `搜索网页：${input?.query ?? ""}`;
  if (name === "WebFetch") return `读取网页：${input?.url ?? ""}`;
  return name;
};

// What a person needs in order to approve: the full path and the real content, not escaped JSON.
const toolDetail = (name: string, input: any): string => {
  if (name === "Bash") return clip([input?.command, input?.description ? `\n说明：${input.description}` : ""].join(""));
  if (name === "Write") return clip(`路径：${input?.file_path}\n\n${input?.content ?? ""}`);
  if (name === "Edit") return clip(`路径：${input?.file_path}\n\n删除：\n${input?.old_string ?? ""}\n\n改为：\n${input?.new_string ?? ""}`);
  return clip(input);
};

const rememberKey = (name: string, input: any) => (name === "Bash" ? `Bash:${input?.command}` : name);

export class ClaudeRuntime implements AgentRuntime {
  private proc: LineProcess | null = null;
  private readonly opts: RuntimeOptions;
  private readonly pending = new Map<string, { name: string; input: any }>();
  private readonly remembered = new Set<string>();
  private readonly streamed = new Set<string>();
  private readonly textBlocks = new Map<string, string>();
  private messageId = "";
  private inTurn = false;
  private interrupting = false;
  private stopping = false;
  private readonly ticked = new Set<string>();

  constructor(opts: RuntimeOptions) {
    this.opts = opts;
  }

  async start() {
    const o = this.opts;
    const args = [
      "-p", "--input-format", "stream-json", "--output-format", "stream-json", "--verbose", "--include-partial-messages",
      "--permission-prompt-tool", "stdio", "--strict-mcp-config",
      "--model", o.model, "--effort", o.effort,
      "--permission-mode", o.permission === "auto_edit" ? "acceptEdits" : "default",
    ];
    if (o.systemPrompt) args.push("--append-system-prompt", o.systemPrompt);
    if (o.sessionId) args.push("--resume", o.sessionId);
    if (o.bus) {
      args.push("--mcp-config", JSON.stringify({ mcpServers: { botbus: o.bus } }));
      // Bus tools run without a prompt: the bus enforces its own limits, and it is the Bot's job to call them.
      args.push("--allowedTools", o.bus.env.BUS_TOOLS.split(",").map((t) => `mcp__botbus__${t}`).join(","));
    }
    if (o.permission === "read_only") args.push("--disallowedTools", "Write,Edit,MultiEdit,NotebookEdit,Bash");
    this.proc = spawnLines("claude", args, o.cwd, (m) => this.onMessage(m), (d) => {
      const tail = this.proc?.stderrTail() || d.error || "";
      if (this.inTurn && !this.stopping) {
        o.onEvent({ type: "turn_end", status: this.interrupting ? "interrupted" : "failed", error: this.interrupting ? undefined : `Claude Code 意外退出（${d.code ?? d.signal}）${tail ? "：" + clip(tail, 400) : ""}` });
      }
      this.inTurn = false;
      o.onEvent({ type: "exit", error: this.stopping ? undefined : tail || undefined });
    });
  }

  async send(text: string) {
    this.inTurn = true;
    this.interrupting = false;
    this.proc?.write({ type: "user", message: { role: "user", content: text } });
  }

  async interrupt() {
    if (!this.inTurn) return;
    this.interrupting = true;
    this.proc?.write({ type: "control_request", request_id: randomUUID(), request: { subtype: "interrupt" } });
  }

  answerApproval(requestId: string, decision: ApprovalDecision) {
    const req = this.pending.get(requestId);
    if (!req) return;
    this.pending.delete(requestId);
    if (decision === "allow_session") this.remembered.add(rememberKey(req.name, req.input));
    this.reply(requestId, decision === "deny" ? { behavior: "deny", message: "用户在 Bot 平台上拒绝了这次操作。" } : { behavior: "allow", updatedInput: req.input });
  }

  stop() {
    this.stopping = true;
    this.proc?.child.kill();
  }

  private reply(requestId: string, response: unknown) {
    this.proc?.write({ type: "control_response", response: { subtype: "success", request_id: requestId, response } });
  }

  private onMessage(m: any) {
    const emit = this.opts.onEvent;
    if (m.session_id && m.type === "system" && m.subtype === "init") emit({ type: "session", sessionId: m.session_id });

    if (m.type === "control_request" && m.request?.subtype === "can_use_tool") {
      const { tool_name: name, input } = m.request;
      // Questions go through the chat itself; this interface has no structured question form yet.
      if (name === "AskUserQuestion") {
        this.reply(m.request_id, { behavior: "deny", message: "请直接在回复里提问，用户会在对话中回答。" });
        return;
      }
      if (this.remembered.has(rememberKey(name, input))) {
        this.reply(m.request_id, { behavior: "allow", updatedInput: input });
        return;
      }
      this.pending.set(m.request_id, { name, input });
      emit({ type: "approval", requestId: m.request_id, title: toolTitle(name, input), detail: toolDetail(name, input), canRemember: true });
      return;
    }
    if (m.type === "control_cancel_request") {
      if (this.pending.delete(m.request_id)) emit({ type: "approval_cancelled", requestId: m.request_id });
      return;
    }
    // Subagent traffic stays inside its parent tool card.
    if (m.parent_tool_use_id) return;

    if (m.type === "stream_event") {
      const ev = m.event;
      if (ev?.type === "message_start") this.messageId = ev.message?.id ?? "";
      const key = `${this.messageId}:${ev?.index}`;
      if (ev?.type === "content_block_delta" && ev.delta?.type === "text_delta") {
        this.streamed.add(this.messageId);
        this.textBlocks.set(key, (this.textBlocks.get(key) ?? "") + ev.delta.text);
        emit({ type: "text_delta", key, text: ev.delta.text });
      } else if (ev?.type === "content_block_stop" && this.textBlocks.has(key)) {
        emit({ type: "text_done", key, text: this.textBlocks.get(key)! });
        this.textBlocks.delete(key);
      }
      return;
    }
    if (m.type === "assistant") {
      const id = m.message?.id ?? "";
      if (id && !this.ticked.has(id) && m.message?.usage) {
        this.ticked.add(id);
        const u = m.message.usage;
        emit({ type: "usage_tick", tokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.output_tokens ?? 0) });
      }
      for (const [i, block] of (m.message?.content ?? []).entries()) {
        if (block.type === "tool_use") {
          emit({ type: "tool", key: block.id, title: toolTitle(block.name, block.input), detail: toolDetail(block.name, block.input), status: "running" });
        } else if (block.type === "text" && !this.streamed.has(id)) {
          emit({ type: "text_done", key: `${id}:${i}`, text: block.text });
        }
      }
      return;
    }
    if (m.type === "user") {
      const content = m.message?.content;
      if (!Array.isArray(content)) return;
      for (const block of content) {
        if (block.type !== "tool_result") continue;
        const output = Array.isArray(block.content) ? block.content.map((c: any) => c.text ?? `[${c.type}]`).join("\n") : block.content;
        emit({ type: "tool", key: block.tool_use_id, title: "", output: clip(output), status: block.is_error ? "failed" : "done" });
      }
      return;
    }
    if (m.type === "result") {
      const u = m.usage ?? {};
      emit({
        type: "usage",
        inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + (u.cache_read_input_tokens ?? 0),
        cachedTokens: u.cache_read_input_tokens ?? 0,
        outputTokens: u.output_tokens ?? 0,
        costTotalUsd: m.total_cost_usd,
      });
      const wasInterrupting = this.interrupting;
      this.inTurn = false;
      this.interrupting = false;
      if (wasInterrupting) emit({ type: "turn_end", status: "interrupted" });
      else if (m.is_error) emit({ type: "turn_end", status: "failed", error: clip(m.result || (m.errors ?? []).join("\n") || m.subtype, 800) });
      else emit({ type: "turn_end", status: "completed" });
    }
  }
}
