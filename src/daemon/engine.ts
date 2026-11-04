import { randomBytes, randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { BUS_TOOLS, CHIEF_TOOLS, MODELS, RESEARCH_TOOLS, type AgentEvent, type AgentKind, type AgentRuntime, type ApprovalDecision, type Bot, type Conversation, type Group, type Item, type RuntimeFactory, type TurnStatus } from "./types.ts";
import { HttpError } from "./errors.ts";
import { Memory, Worktrees, type MemoryScope, type Worktree, changedSince, git, workState, type WorkState } from "./git.ts";
import { Research } from "./research.ts";
import type { Store } from "./store.ts";

const FLUSH_MS = 400;
const INTERRUPT_GRACE_MS = 8000;
const MAX_ANSWER = 30000;
const MAX_TRANSCRIPT = 30000;
const BUS_SHIM = join(dirname(fileURLToPath(import.meta.url)), "bus-mcp.mjs");

export { HttpError };

const MAX_BOTS = 12;
export const STEERABLE: AgentKind[] = ["claude", "codex"];
const MAX_QUEUED = 10;
const ACTIVITY_MS = 300;
const BASELINE_WAIT_MS = 2000;
const MAX_RESULT_FILES = 100;
const MAX_RESULT_DIFF = 400_000;
// What a person would accept as "it was checked". A match says only that the command ran and how it exited.
const CHECK_COMMAND = /(^|[\s;&|/])(pytest|tox|ctest|vitest|jest|mypy|ruff|eslint|tsc|unittest|(npm|pnpm|yarn)( run)? (test|lint|check)\S*|node --test|cargo (test|check|clippy)|go (test|vet)|(mvn|gradle) test|make (test|check))(\s|$)/;
const PROPOSAL_FIELDS = ["name", "role", "agent", "model", "effort", "permission", "budget_tokens"];
const PERMISSION_TEXT: Record<string, string> = { ask: "每次询问", auto_edit: "自动改文件（工作目录）", read_only: "只读" };
const pick = (o: any) => Object.fromEntries(PROPOSAL_FIELDS.filter((k) => o?.[k] !== undefined).map((k) => [k, o[k]]));

// Everything started by one user message: the budget and limits span the whole call tree.
interface RootTurn {
  id: string;
  convId: string;
  limit: number;
  spent: number;
  callCount: number;
  activeCalls: number;
  active: Set<Live>;
  stopping: boolean;
  overBudget: boolean;
  // Why it was stopped. The first cause wins: stopping the main turn also closes the round.
  stopNote: string | null;
  tasks: Map<string, TaskRun>;
  baseline: Promise<WorkState | null>;
  startedAt: number;
  lastActivity: number;
  activityTimer: NodeJS.Timeout | null;
  files: Set<string>;
  checks: { command: string; status: string }[];
  lastText: string;
}

interface TurnCtx {
  root: RootTurn;
  displayConvId: string;
  depth: number;
  chain: string[];
  callId: string | null;
  // This call and the calls above it, so a task's timeout can reach everything it started.
  callPath: string[];
  speaker: { id: string; name: string } | null;
}

interface CallRun {
  callId: string;
  itemId: string;
  callerName: string;
  ctx: TurnCtx;
  target: Bot;
  child: Conversation;
  question: string;
  worktree: Worktree | null;
  retryNote?: string;
  task?: TaskRun;
}

// The in-memory half of a task. The row in `calls` is the record; this only exists while the daemon can still act on it.
interface TaskRun extends CallRun {
  state: "waiting" | "running" | "finished";
  dependsOn: string[];
  timeoutMs: number;
  timedOut: boolean;
  clock: NodeJS.Timeout | null;
  forceTimer: NodeJS.Timeout | null;
  force: (r: TurnResult) => void;
  forced: Promise<TurnResult>;
  settle: (r: CallResult) => void;
  done: Promise<CallResult>;
}

const RETRYABLE = ["failed", "interrupted", "timeout"];
const STILL_GOING = ["waiting", "running"];
const OUTCOME: Record<string, string> = { done: "完成了", failed: "失败了", timeout: "超时了", interrupted: "被中断了" };
const DEP_ANSWER = 4000;
const NOTICE_ANSWER = 2000;
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);
const firstLine = (s: unknown) => clip(String(s ?? "").trim().split("\n")[0], 60);
const duration = (ms: number) => (ms >= 60000 ? `${Math.round(ms / 60000)} 分钟` : `${Math.round(ms / 100) / 10} 秒`);

interface TurnResult {
  status: TurnStatus;
  text: string;
  error?: string;
  tokens: number;
}
type CallResult = { text: string; isError: boolean };

interface Live {
  runtime: AgentRuntime;
  convId: string;
  bot: Bot;
  configKey: string;
  busToken: string;
  lastUsed: number;
  turnId: string | null;
  turnStarted: number;
  ctx: TurnCtx | null;
  resolve: ((r: TurnResult) => void) | null;
  ticks: number;
  turnTokens: number;
  texts: string[];
  assistantItems: Map<string, { itemId: string; text: string; timer: NodeJS.Timeout | null }>;
  toolItems: Map<string, string>;
  approvals: Map<string, string>;
  usage: { inputTokens: number; cachedTokens: number; outputTokens: number; costUsd: number | null } | null;
  interruptTimer: NodeJS.Timeout | null;
  files: Set<string>;
  // Set after a steer: a message that arrived just too late is answered after the turn it was meant for.
  lateConv: string | null;
}

export type Broadcast = (event: { type: string; [k: string]: unknown }) => void;

export const canCallList = (b: Bot): string[] | null => (b.can_call ? (JSON.parse(b.can_call) as string[]) : null);

// Longest names first, so "Reviewer2" is not read as a mention of "Reviewer".
export function parseMentions(text: string, members: Bot[]): Bot[] {
  const byLength = [...members].sort((a, b) => b.name.length - a.name.length);
  const hits: { at: number; bot: Bot }[] = [];
  const taken: [number, number][] = [];
  for (const b of byLength) {
    const needle = `@${b.name}`.toLowerCase();
    const lower = text.toLowerCase();
    for (let i = lower.indexOf(needle); i >= 0; i = lower.indexOf(needle, i + 1)) {
      if (taken.some(([s, e]) => i >= s && i < e)) continue;
      taken.push([i, i + needle.length]);
      hits.push({ at: i, bot: b });
    }
  }
  const seen = new Set<string>();
  return hits
    .sort((a, b) => a.at - b.at)
    .map((h) => h.bot)
    .filter((b) => !seen.has(b.id) && Boolean(seen.add(b.id)));
}

export const effectiveTokens = (u: { inputTokens: number; cachedTokens: number; outputTokens: number }) => Math.max(0, u.inputTokens - u.cachedTokens) + u.outputTokens;

export class Engine {
  private readonly store: Store;
  private readonly factory: RuntimeFactory;
  private readonly broadcast: Broadcast;
  private readonly publish: Broadcast;
  private readonly fixedIdleMs: number | undefined;
  private readonly busUrl: () => string;
  private readonly validateBot: (input: any, existing?: Bot) => Promise<any>;
  readonly memory: Memory;
  readonly worktrees: Worktrees;
  readonly research: Research;
  private readonly pendingWakes = new Map<string, string[]>();
  private memoryEpoch = 0;
  private closed = false;
  private readonly proposals = new Map<string, { live: Live; resolve: (r: { decision: ApprovalDecision | "expired"; spec?: any }) => void }>();
  private readonly live = new Map<string, Live>();
  private readonly busTokens = new Map<string, Live>();
  private readonly approvalOwners = new Map<string, Live>();
  private readonly roots = new Map<string, RootTurn>();
  private readonly reaper: NodeJS.Timeout;

  constructor(o: { store: Store; factory: RuntimeFactory; broadcast: Broadcast; idleMs?: number; busUrl: () => string; validateBot: (input: any, existing?: Bot) => Promise<any>; pollMs?: number; sshPollMs?: number }) {
    this.store = o.store;
    this.factory = o.factory;
    this.publish = o.broadcast;
    this.broadcast = (e) => {
      o.broadcast(e);
      const convId = e.type === "item" ? (e.item as Item).conv_id : e.type === "delta" || e.type === "trace" ? (e.convId as string) : null;
      const root = convId ? this.roots.get(convId) : undefined;
      if (root) this.touch(root);
    };
    this.busUrl = o.busUrl;
    this.validateBot = o.validateBot;
    this.memory = new Memory(o.store.home);
    this.worktrees = new Worktrees(o.store);
    this.research = new Research({ store: o.store, broadcast: o.broadcast, onFinished: (e) => this.onExperimentFinished(e), pollMs: o.pollMs, sshPollMs: o.sshPollMs });
    this.fixedIdleMs = o.idleMs;
    this.reaper = setInterval(() => this.reapIdle(), Math.min(o.idleMs ?? 30000, 30000));
    this.reaper.unref();
    for (const convId of this.store.recover()) {
      this.addItem(convId, null, "error", "done", { message: "守护进程重启时这一轮还没结束，已被中断。可以直接继续发消息。" });
    }
  }

  shutdown() {
    this.closed = true;
    clearInterval(this.reaper);
    // Running jobs are detached on purpose: they keep going and are picked up after the restart.
    this.research.stop();
    for (const root of this.roots.values()) {
      if (root.activityTimer) clearTimeout(root.activityTimer);
      root.activityTimer = null;
      for (const t of root.tasks.values()) {
        if (t.clock) clearInterval(t.clock);
        if (t.forceTimer) clearTimeout(t.forceTimer);
      }
    }
    for (const l of this.live.values()) {
      for (const a of l.assistantItems.values()) {
        if (a.timer) clearTimeout(a.timer);
        if (this.store.getItem(a.itemId)?.status === "streaming") this.store.updateItem(a.itemId, { data: { ...this.store.getItem(a.itemId)!.data, text: a.text } });
      }
      if (l.interruptTimer) clearTimeout(l.interruptTimer);
      l.runtime.stop();
    }
    this.live.clear();
  }

  private addItem(convId: string, turnId: string | null, type: Item["type"], status: string, data: Record<string, unknown>) {
    const item = this.store.addItem({ convId, turnId, type, status, data });
    this.broadcast({ type: "item", item });
    return item;
  }

  private updateItem(id: string, patch: { status?: string; data?: Record<string, unknown> }) {
    const item = this.store.updateItem(id, patch);
    this.broadcast({ type: "item", item });
    return item;
  }

  private setConversation(convId: string, patch: Parameters<Store["updateConversation"]>[1]) {
    this.store.updateConversation(convId, patch);
    const conversation = this.store.getConversation(convId);
    if (conversation && (conversation.kind === "direct" || conversation.kind === "group")) this.broadcast({ type: "conversation", conversation });
  }

  private openRoot(convId: string, limit: number): RootTurn {
    const now = Date.now();
    const root: RootTurn = { id: randomUUID(), convId, limit, spent: 0, callCount: 0, activeCalls: 0, active: new Set(), stopping: false, overBudget: false, stopNote: null, tasks: new Map(), baseline: workState(this.store.getConversation(convId)!.cwd), startedAt: now, lastActivity: now, activityTimer: null, files: new Set(), checks: [], lastText: "" };
    this.roots.set(convId, root);
    this.store.createRootTurn(root.id, convId, limit);
    this.broadcastBudget(root, true);
    this.touch(root);
    return root;
  }

  // ---------- what a round is doing right now ----------
  private touch(root: RootTurn) {
    root.lastActivity = Date.now();
    if (root.activityTimer) return;
    root.activityTimer = setTimeout(() => {
      root.activityTimer = null;
      if (this.roots.get(root.convId) === root) this.publish({ type: "activity", convId: root.convId, activity: this.activity(root.convId) });
    }, ACTIVITY_MS);
    root.activityTimer.unref();
  }

  private describeLive(l: Live) {
    const who = l.ctx?.speaker ? `${l.bot.name} ` : "";
    const tools = [...l.toolItems.values()].filter(Boolean).map((id) => this.store.getItem(id)).filter((i) => i?.status === "running");
    if (tools.some((i) => i!.data.editing)) return `${who}正在修改 ${l.files.size} 个文件`;
    if (tools.length) return `${who}正在执行：${clip(String(tools[0]!.data.title), 60)}`;
    if ([...l.assistantItems.values()].some((a) => this.store.getItem(a.itemId)?.status === "streaming")) return `${who}正在回复`;
    return `${who}正在思考`;
  }

  activity(convId: string) {
    const root = this.roots.get(convId);
    if (!root) return null;
    const at = root.lastActivity;
    if (root.stopping) return { kind: "stopping", text: "正在停止", at };
    for (const l of root.active) {
      for (const id of l.approvals.keys()) {
        const d = this.store.getItem(id)?.data;
        if (d) return { kind: "approval", text: `等待你批准：${d.from ? `${d.from}：` : ""}${clip(String(d.title), 60)}`, at };
      }
    }
    const going = this.store.listCalls(root.id).filter((c) => STILL_GOING.includes(c.status as string));
    const leaves = going.filter((c) => !going.some((o) => o.parent_call_id === c.id));
    const names = [...new Set(leaves.map((c) => c.to_bot as string))].join("、");
    const main = [...root.active].find((l) => !l.ctx?.callId);
    const doing = main ? this.describeLive(main) : "";
    if (leaves.length && (!main || doing.endsWith("正在思考"))) {
      const only = leaves.length === 1 ? [...root.active].find((l) => l.ctx?.callId === leaves[0].id) : undefined;
      return { kind: "waiting", text: `等待 ${names}${only ? `：${this.describeLive(only)}` : ""}`, at };
    }
    return { kind: "working", text: `${doing || "正在处理"}${leaves.length ? `（后台：${names}）` : ""}`, at };
  }

  private closeRoot(root: RootTurn) {
    // A task nobody collected must not keep running and spending after the turn ended.
    const halted = root.stopping;
    if (root.active.size || [...root.tasks.values()].some((t) => t.state !== "finished")) this.stopRoot(root, "这一轮结束时还没有人取回结果，已停止");
    this.roots.delete(root.convId);
    if (root.activityTimer) clearTimeout(root.activityTimer);
    root.activityTimer = null;
    this.publish({ type: "activity", convId: root.convId, activity: null });
    const status = root.overBudget ? "over_budget" : root.stopping ? "interrupted" : "completed";
    this.store.updateRootTurn(root.id, root.spent, status);
    this.broadcastBudget(root, false);
    this.setConversation(root.convId, { status: "idle" });
    // The next round's baseline must be taken after this one's card is written.
    void this.postResult(root, status).then(() => {
      if (this.closed) return;
      if (halted) this.dropQueue(root.convId, root.overBudget ? "这一轮的预算用完了，没有发出" : "这一轮被停止了，没有发出");
      else if (this.pumpQueue(root.convId)) return;
      const queued = this.pendingWakes.get(root.convId);
      if (queued?.length) this.wake(root.convId, queued.shift()!);
    }).catch(() => {}); // Only happens when the daemon is shutting down around it.
  }

  // ---------- the result of a round ----------
  // A card only when there is something to check: an answer to a question already says all it has to.
  private async postResult(root: RootTurn, status: string) {
    const before = await root.baseline;
    const changes = before ? await changedSince(before) : null;
    const gitFiles = changes?.files ?? [];
    const files = gitFiles.length ? gitFiles : [...root.files].map((path) => ({ path, change: "修改" }));
    const made = this.store.listWorktrees(root.convId).filter((w) => w.status === "active" && Number((w as any).created_at) >= root.startedAt);
    if (!files.length && !made.length && !root.checks.length) return;
    const worktrees = await Promise.all(made.map(async (w) => ({ id: w.id, branch: w.branch, bot: w.bot_name, changes: clip(await this.worktrees.changes(w), 1000) })));
    this.addItem(root.convId, null, "result", status, {
      summary: clip(root.lastText.trim(), 300),
      source: gitFiles.length ? "git" : files.length ? "agent" : "none",
      files: files.slice(0, MAX_RESULT_FILES),
      total: files.length,
      commits: changes?.commits ?? 0,
      worktrees,
      checks: root.checks,
      // A folder with no commits yet has nothing to compare against.
      repo: gitFiles.length && before?.head ? { top: before.top, base: before.head } : null,
      accepted: false,
    });
  }

  acceptResult(itemId: string) {
    const item = this.store.getItem(itemId);
    if (!item || item.type !== "result") throw new HttpError(404, "没有这个结果");
    return this.updateItem(itemId, { data: { ...item.data, accepted: true } });
  }

  async resultDiff(itemId: string) {
    const item = this.store.getItem(itemId);
    const repo = item?.type === "result" ? (item.data.repo as { top: string; base: string } | null) : null;
    if (!repo) throw new HttpError(404, "这个结果没有可比较的 Git 记录");
    const files = (item!.data.files as { path: string; change: string }[]).map((f) => f.path);
    const env = { GIT_LITERAL_PATHSPECS: "1" };
    const diff = await git(repo.top, ["diff", "--no-color", "--no-ext-diff", repo.base, "--", ...files], env).catch((e) => {
      throw new HttpError(409, `读不到改动：${e.message}`);
    });
    const untracked = (await git(repo.top, ["ls-files", "-o", "--exclude-standard", "--", ...files], env).catch(() => "")).split("\n").filter(Boolean);
    return { base: repo.base.slice(0, 8), diff: diff.slice(0, MAX_RESULT_DIFF), clipped: diff.length > MAX_RESULT_DIFF, untracked, clippedFiles: item!.data.total !== files.length };
  }

  // ---------- messages sent while a round is running ----------
  async followUp(convId: string, text: string, mode: string) {
    const conv = this.store.getConversation(convId);
    if (!conv || (conv.kind !== "direct" && conv.kind !== "group") || conv.archived) throw new HttpError(404, "对话不存在");
    if (conv.status !== "running") {
      await this.dispatch(conv, text);
      return { delivered: "sent" };
    }
    if (this.roots.get(convId)?.stopping) throw new HttpError(409, "这一轮正在停止，停下来之后再发");
    if (conv.kind === "group") {
      const members = this.store.groupMembers(conv.group_id!);
      if (!parseMentions(text, members).length && !members.some((m) => m.is_chief)) throw new HttpError(400, `请 @ 至少一个成员：${members.map((m) => m.name).join("、")}`);
    } else if (conv.agent !== this.store.getBot(conv.bot_id!)?.agent) throw new HttpError(409, "这个 Bot 已换了底层 agent，旧对话无法继续，请新建对话");
    const l = this.live.get(convId);
    if (mode === "steer" && conv.kind === "direct" && l?.turnId && l.runtime.steer) {
      const turnId = l.turnId;
      const steered = await l.runtime.steer(text).then(() => true, () => false);
      if (steered) {
        l.lateConv = convId;
        this.addItem(convId, turnId, "user", "done", { text, steered: true });
        return { delivered: "steered" };
      }
    }
    if (this.store.listItems(convId).filter((i) => i.type === "queued" && i.status === "queued").length >= MAX_QUEUED) throw new HttpError(409, `最多排队 ${MAX_QUEUED} 条，请等前面的发出`);
    const item = this.addItem(convId, null, "queued", "queued", { text });
    // The turn may have ended while the steer was being refused.
    if (this.store.getConversation(convId)?.status !== "running" && !this.roots.has(convId)) this.pumpQueue(convId);
    return { delivered: "queued", itemId: item.id };
  }

  private async dispatch(conv: Conversation, text: string) {
    return conv.kind === "group" ? this.sendGroupMessage(conv.group_id!, conv.id, text) : this.sendMessage(conv.bot_id!, conv.id, text);
  }

  // Each queued message is an ordinary message, with its own round and budget. True if one was sent.
  private pumpQueue(convId: string): boolean {
    const conv = this.store.getConversation(convId);
    if (!conv || conv.status === "running") return false;
    const next = this.store.listItems(convId).find((i) => i.type === "queued" && i.status === "queued");
    if (!next) return false;
    this.updateItem(next.id, { status: "sent" });
    void this.dispatch(conv, String(next.data.text)).catch((e) => {
      this.updateItem(next.id, { status: "unsent", data: { ...next.data, reason: (e as Error).message } });
      this.pumpQueue(convId);
    });
    return true;
  }

  private dropQueue(convId: string, reason: string) {
    for (const i of this.store.listItems(convId)) if (i.type === "queued" && i.status === "queued") this.updateItem(i.id, { status: "unsent", data: { ...i.data, reason } });
  }

  withdrawQueued(itemId: string) {
    const item = this.store.getItem(itemId);
    if (!item || item.type !== "queued") throw new HttpError(404, "没有这条排队的消息");
    if (item.status !== "queued" && item.status !== "unsent") throw new HttpError(409, "这条消息已经发出了");
    this.updateItem(itemId, { status: "withdrawn" });
    return { text: item.data.text };
  }

  private broadcastBudget(root: RootTurn, active: boolean) {
    this.broadcast({ type: "budget", convId: root.convId, rootTurnId: root.id, spent: root.spent, limit: root.limit, active });
  }

  private spend(root: RootTurn, tokens: number) {
    if (!tokens) return;
    root.spent = Math.max(0, root.spent + tokens);
    this.broadcastBudget(root, true);
    if (root.limit > 0 && root.spent >= root.limit && !root.overBudget) {
      root.overBudget = true;
      this.addItem(root.convId, null, "error", "done", { message: `这一轮已用 ${root.spent} tokens，达到预算 ${root.limit}，已自动暂停。要继续可以再发一条消息，或调高预算。` });
      this.stopRoot(root, "这一轮的预算用完了，已停止");
    }
  }

  private stopRoot(root: RootTurn, note: string) {
    root.stopping = true;
    root.stopNote ??= note;
    for (const l of [...root.active]) void this.interruptLive(l);
    this.pumpTasks(root);
  }

  private async interruptLive(l: Live) {
    await l.runtime.interrupt();
    if (l.turnId && !l.interruptTimer) {
      l.interruptTimer = setTimeout(() => {
        // The agent ignored the interrupt. Its session survives a kill and resumes on the next message.
        if (this.live.get(l.convId) === l) this.onEvent(l, { type: "turn_end", status: "interrupted" });
        this.dropRuntime(l.convId);
      }, INTERRUPT_GRACE_MS);
    }
  }

  // ---------- user messages ----------
  async sendMessage(botId: string, conversationId: string | null, text: string): Promise<Conversation> {
    const bot = this.store.getBot(botId);
    if (!bot) throw new HttpError(404, "Bot 不存在");
    const title = text.trim().split("\n")[0].slice(0, 40) || "新对话";
    const conv = conversationId ? this.store.getConversation(conversationId) : this.store.createConversation(bot, title);
    if (!conv || conv.bot_id !== botId || conv.kind !== "direct") throw new HttpError(404, "对话不存在");
    if (conv.status === "running") throw new HttpError(409, "这个对话还在回复中");
    if (conv.agent !== bot.agent) throw new HttpError(409, "这个 Bot 已换了底层 agent，旧对话无法继续，请新建对话");
    if (!conversationId) this.broadcast({ type: "conversation", conversation: conv });

    const prompt = this.withNotices(conv.id, text);
    this.addItem(conv.id, null, "user", "done", { text });
    this.setConversation(conv.id, { status: "running" });
    const root = this.openRoot(conv.id, bot.budget_tokens);
    void this.runTurn(bot, conv.id, prompt, { root, displayConvId: conv.id, depth: 0, chain: [bot.id], callId: null, callPath: [], speaker: null }).finally(() => this.closeRoot(root));
    return this.store.getConversation(conv.id)!;
  }

  async sendGroupMessage(groupId: string, conversationId: string | null, text: string): Promise<Conversation> {
    const group = this.store.getGroup(groupId);
    if (!group) throw new HttpError(404, "群聊不存在");
    const members = this.store.groupMembers(groupId);
    let mentioned = parseMentions(text, members);
    // With a Chief in the group, a message to nobody in particular is a message to the Chief.
    if (!mentioned.length) mentioned = members.filter((m) => m.is_chief);
    if (!mentioned.length) throw new HttpError(400, `请 @ 至少一个成员：${members.map((m) => m.name).join("、")}`);
    const title = text.trim().split("\n")[0].slice(0, 40) || "新对话";
    const conv = conversationId ? this.store.getConversation(conversationId) : this.store.createGroupConversation(group, title);
    if (!conv || conv.group_id !== groupId) throw new HttpError(404, "对话不存在");
    if (conv.status === "running") throw new HttpError(409, "这个对话还在回复中");
    if (!conversationId) this.broadcast({ type: "conversation", conversation: conv });

    this.addItem(conv.id, null, "user", "done", { text });
    this.setConversation(conv.id, { status: "running" });
    const root = this.openRoot(conv.id, group.budget_tokens);
    void this.runGroupRound(group, conv, mentioned, members, root).finally(() => this.closeRoot(root));
    return this.store.getConversation(conv.id)!;
  }

  // One at a time, so each Bot reads what the previous one just said.
  private async runGroupRound(group: Group, conv: Conversation, mentioned: Bot[], members: Bot[], root: RootTurn, instruction = "") {
    for (const bot of mentioned) {
      if (root.stopping) return;
      let session = this.store.findChild("member", conv.id, bot.id);
      if (!session || session.agent !== bot.agent) session = this.store.createChild("member", conv.id, bot, conv.cwd, `${group.name} / ${bot.name}`);
      const prompt = this.groupPrompt(conv.id, session, bot) + instruction;
      const note = `你在群聊“${group.name}”里，身份是 ${bot.name}。成员：${members.map((m) => m.name).join("、")}。用户 @ 到你时才需要回复，直接回应，不用复述别人说过的话。`;
      const before = this.lastSeq(conv.id);
      await this.runTurn(bot, session.id, prompt, { root, displayConvId: conv.id, depth: 0, chain: [bot.id], callId: null, callPath: [], speaker: { id: bot.id, name: bot.name } }, note);
      this.store.updateConversation(session.id, { last_seq: Math.max(before, this.lastSeq(conv.id)) });
    }
  }

  // A direct chat's agent only sees what it is sent, so whatever the platform posted since the last message goes along.
  private withNotices(convId: string, text: string) {
    const items = this.store.listItems(convId);
    const lastUser = items.findLastIndex((i) => i.type === "user" && !i.data.steered);
    const notes = items.slice(lastUser + 1).filter((i) => i.type === "notice").map((i) => `[平台通知，不是用户发的] ${i.data.text}`);
    return notes.length ? `${notes.join("\n\n")}\n\n${text}` : text;
  }

  private lastSeq(convId: string) {
    return this.store.listItems(convId).at(-1)?.seq ?? 0;
  }

  private groupPrompt(convId: string, session: Conversation, bot: Bot) {
    const lines: string[] = [];
    for (const i of this.store.listItems(convId)) {
      if ((i.seq ?? 0) <= session.last_seq) continue;
      const by = i.data.bot as { id: string; name: string } | undefined;
      if (by?.id === bot.id) continue;
      if (i.type === "user") lines.push(`[用户]：${i.data.text}`);
      else if (i.type === "assistant" && i.data.text) lines.push(`[${by?.name ?? "Bot"}]：${i.data.text}`);
      else if (i.type === "notice") lines.push(`[平台通知，不是用户发的]：${i.data.text}`);
    }
    const transcript = lines.join("\n\n");
    const clipped = transcript.length > MAX_TRANSCRIPT ? `（更早的内容已省略）\n${transcript.slice(-MAX_TRANSCRIPT)}` : transcript;
    return `群聊里的新消息：\n\n${clipped}\n\n现在轮到你（${bot.name}）回复。`;
  }

  // ---------- running one agent turn ----------
  private runTurn(bot: Bot, sessionConvId: string, prompt: string, ctx: TurnCtx, extraSystem = ""): Promise<TurnResult> {
    return new Promise<TurnResult>((resolve) => {
      if (ctx.root.stopping) return resolve({ status: "interrupted", text: "", tokens: 0 });
      const turnId = randomUUID();
      void (async () => {
        try {
          // Waited for so the agent cannot change anything before the "before" picture is taken, but a slow repository must not hold up a reply.
          await Promise.race([ctx.root.baseline, new Promise((r) => setTimeout(r, BASELINE_WAIT_MS).unref())]);
          if (this.closed) return;
          const live = await this.ensureRuntime(bot, sessionConvId, extraSystem, ctx);
          if (this.live.get(sessionConvId) !== live) throw new Error("进程启动后立刻退出了");
          Object.assign(live, { turnId, turnStarted: Date.now(), lastUsed: Date.now(), usage: null, ctx, resolve, ticks: 0, turnTokens: 0, texts: [], files: new Set(), lateConv: null });
          ctx.root.active.add(live);
          // The stop may have come while the agent was still starting.
          if (ctx.root.stopping) void this.interruptLive(live);
          await live.runtime.send(prompt);
        } catch (e) {
          const message = `无法启动 ${bot.agent}：${(e as Error).message}`;
          this.dropRuntime(sessionConvId);
          this.finishTurn(ctx, turnId, "failed", message);
          resolve({ status: "failed", text: "", error: message, tokens: 0 });
        }
      })();
    });
  }

  private configKey(bot: Bot, extra: string, research: boolean) {
    return JSON.stringify([bot.model, bot.effort, bot.permission, bot.role, bot.name, bot.can_call, extra, this.memoryEpoch, research]);
  }

  private researchEnabled(rootConvId: string) {
    return Boolean(this.research.settings(Memory.projectId(this.store.getConversation(rootConvId)!.cwd)).enabled);
  }

  private async ensureRuntime(bot: Bot, convId: string, extraSystem: string, ctx: TurnCtx): Promise<Live> {
    // Optional module: projects that do not use it pay nothing for its tool definitions.
    const research = this.researchEnabled(ctx.root.convId);
    const key = this.configKey(bot, extraSystem, research);
    const existing = this.live.get(convId);
    if (existing && existing.configKey === key) return existing;
    if (existing) this.dropRuntime(convId);

    const conv = this.store.getConversation(convId)!;
    const busToken = randomBytes(24).toString("hex");
    const memory = this.memory.promptSection(bot.id, conv.cwd);
    const tools = [...BUS_TOOLS.filter((t) => canCallList(bot)?.length !== 0 || !["list_bots", "ask_bot", "assign_task", "get_task"].includes(t)), ...(research ? RESEARCH_TOOLS : []), ...(bot.is_chief ? CHIEF_TOOLS : [])];
    const live: Live = {
      runtime: null as unknown as AgentRuntime,
      convId,
      bot,
      configKey: key,
      busToken,
      lastUsed: Date.now(),
      turnId: null,
      turnStarted: Date.now(),
      ctx: null,
      resolve: null,
      ticks: 0,
      turnTokens: 0,
      texts: [],
      assistantItems: new Map(),
      toolItems: new Map(),
      approvals: new Map(),
      usage: null,
      interruptTimer: null,
      files: new Set(),
      lateConv: null,
    };
    live.runtime = this.factory({
      agent: conv.agent,
      model: bot.model,
      effort: bot.effort,
      permission: bot.permission,
      route: conv.route,
      cwd: conv.cwd,
      systemPrompt: [bot.role, extraSystem, memory].filter(Boolean).join("\n\n"),
      sessionId: conv.session_id,
      bus: { command: process.execPath, args: [BUS_SHIM], env: { BUS_URL: this.busUrl(), BUS_TOKEN: busToken, BUS_TOOLS: tools.join(",") } },
      onEvent: (ev) => {
        if (this.live.get(convId) === live) this.onEvent(live, ev);
      },
    });
    this.live.set(convId, live);
    this.busTokens.set(busToken, live);
    await live.runtime.start();
    return live;
  }

  private dropRuntime(convId: string) {
    const l = this.live.get(convId);
    if (!l) return;
    this.live.delete(convId);
    this.busTokens.delete(l.busToken);
    l.ctx?.root.active.delete(l);
    for (const a of l.assistantItems.values()) if (a.timer) clearTimeout(a.timer);
    if (l.interruptTimer) clearTimeout(l.interruptTimer);
    l.runtime.stop();
  }

  private speakerData(ctx: TurnCtx | null) {
    return ctx?.speaker ? { bot: ctx.speaker } : {};
  }

  private onEvent(l: Live, ev: AgentEvent) {
    l.lastUsed = Date.now();
    const ctx = l.ctx;
    if (ctx) this.touch(ctx.root);
    switch (ev.type) {
      case "session":
        this.setConversation(l.convId, { session_id: ev.sessionId });
        return;
      case "text_delta": {
        if (!ctx) return;
        let a = l.assistantItems.get(ev.key);
        if (!a) {
          const item = this.addItem(ctx.displayConvId, l.turnId, "assistant", "streaming", { text: "", ...this.speakerData(ctx) });
          a = { itemId: item.id, text: "", timer: null };
          l.assistantItems.set(ev.key, a);
        }
        a.text += ev.text;
        this.broadcast({ type: "delta", convId: ctx.displayConvId, itemId: a.itemId, text: ev.text });
        // Written periodically so a crash loses at most a moment of streamed text.
        if (!a.timer) {
          const entry = a;
          a.timer = setTimeout(() => {
            entry.timer = null;
            const cur = this.store.getItem(entry.itemId);
            if (cur?.status === "streaming") this.store.updateItem(entry.itemId, { data: { ...cur.data, text: entry.text } });
          }, FLUSH_MS);
        }
        return;
      }
      case "text_done": {
        if (!ctx) {
          if (l.lateConv && ev.text) this.addItem(l.lateConv, null, "assistant", "done", { text: ev.text });
          return;
        }
        const a = l.assistantItems.get(ev.key);
        if (a) {
          if (a.timer) clearTimeout(a.timer);
          a.timer = null;
          a.text = ev.text || a.text;
          this.updateItem(a.itemId, { status: "done", data: { text: a.text, ...this.speakerData(ctx) } });
          if (a.text) l.texts.push(a.text);
        } else if (ev.text) {
          const item = this.addItem(ctx.displayConvId, l.turnId, "assistant", "done", { text: ev.text, ...this.speakerData(ctx) });
          l.assistantItems.set(ev.key, { itemId: item.id, text: ev.text, timer: null });
          l.texts.push(ev.text);
        }
        return;
      }
      case "tool": {
        if (!ctx) return;
        const id = l.toolItems.get(ev.key);
        if (id === "") return;
        for (const f of ev.files ?? []) {
          l.files.add(f);
          ctx.root.files.add(f);
        }
        if (id) {
          const cur = this.store.getItem(id)!;
          // Some agents only name the tool in a later update. Calls to Bots have their own card.
          if (/botbus/.test(ev.title)) {
            this.updateItem(id, { status: "hidden" });
            l.toolItems.set(ev.key, "");
            return;
          }
          if (cur.status === "running" && ev.status !== "running") this.noteCheck(ctx.root, cur.data.command, ev.status);
          this.updateItem(id, {
            status: ev.status,
            data: { ...cur.data, title: ev.title || cur.data.title, detail: ev.detail ?? cur.data.detail, output: ev.output ?? cur.data.output, command: ev.command ?? cur.data.command, editing: Boolean(ev.files?.length) || cur.data.editing },
          });
        } else {
          // Calls to other Bots get their own card, so the raw tool call would only repeat it.
          if (/botbus/.test(ev.title)) {
            l.toolItems.set(ev.key, "");
            return;
          }
          const item = this.addItem(ctx.displayConvId, l.turnId, "tool", ev.status, { title: ev.title || "工具调用", detail: ev.detail, output: ev.output, command: ev.command, editing: Boolean(ev.files?.length), ...this.speakerData(ctx) });
          l.toolItems.set(ev.key, item.id);
          if (ev.status !== "running") this.noteCheck(ctx.root, ev.command, ev.status);
        }
        return;
      }
      case "approval": {
        if (!ctx) return;
        // Approvals always reach the conversation the user is watching, however deep the call.
        const from = ctx.callId || ctx.speaker ? { from: l.bot.name } : {};
        const item = this.addItem(ctx.root.convId, l.turnId, "approval", "pending", { title: ev.title, detail: ev.detail, canRemember: ev.canRemember, ...from });
        l.approvals.set(item.id, ev.requestId);
        this.approvalOwners.set(item.id, l);
        return;
      }
      case "approval_cancelled": {
        for (const [itemId, reqId] of l.approvals) {
          if (reqId === ev.requestId) {
            l.approvals.delete(itemId);
            this.approvalOwners.delete(itemId);
            this.updateItem(itemId, { status: "expired" });
          }
        }
        return;
      }
      case "usage_tick": {
        if (!ctx) return;
        l.ticks += ev.tokens;
        this.spend(ctx.root, ev.tokens);
        return;
      }
      case "usage": {
        const conv = this.store.getConversation(l.convId)!;
        let costUsd: number | null = null;
        if (ev.costTotalUsd !== undefined) {
          // Claude reports a running session total, not the cost of this turn.
          costUsd = Math.max(0, ev.costTotalUsd >= conv.cost_total ? ev.costTotalUsd - conv.cost_total : ev.costTotalUsd);
          this.store.updateConversation(l.convId, { cost_total: ev.costTotalUsd });
        }
        l.usage = { inputTokens: ev.inputTokens, cachedTokens: ev.cachedTokens, outputTokens: ev.outputTokens, costUsd };
        l.turnTokens = effectiveTokens(l.usage);
        // Ticks were an estimate during the turn; settle to the exact figure.
        if (ctx) this.spend(ctx.root, l.turnTokens - l.ticks);
        l.ticks = l.turnTokens;
        return;
      }
      case "turn_end": {
        const turnId = l.turnId;
        if (!turnId || !ctx) return;
        l.turnId = null;
        if (l.interruptTimer) clearTimeout(l.interruptTimer);
        l.interruptTimer = null;
        for (const a of l.assistantItems.values()) {
          if (a.timer) clearTimeout(a.timer);
          a.timer = null;
          const cur = this.store.getItem(a.itemId);
          if (cur?.status === "streaming") this.updateItem(a.itemId, { status: ev.status === "completed" ? "done" : "interrupted", data: { ...cur.data, text: a.text } });
        }
        l.assistantItems.clear();
        for (const id of l.toolItems.values()) {
          if (this.store.getItem(id)?.status === "running") this.updateItem(id, { status: "interrupted" });
        }
        l.toolItems.clear();
        for (const itemId of l.approvals.keys()) {
          this.approvalOwners.delete(itemId);
          this.proposals.get(itemId)?.resolve({ decision: "expired" });
          this.proposals.delete(itemId);
          this.updateItem(itemId, { status: "expired" });
        }
        l.approvals.clear();
        if (l.usage) {
          this.store.logUsage({ turnId, convId: l.convId, botId: l.bot.id, ...l.usage });
          this.broadcast({ type: "usage", botId: l.bot.id, usage: this.store.botUsage(l.bot.id) });
        }
        this.finishTurn(ctx, turnId, ev.status, ev.error, l.usage, l.turnStarted);
        ctx.root.active.delete(l);
        if (!ctx.callId && l.texts.length) ctx.root.lastText = l.texts.at(-1)!;
        const resolve = l.resolve;
        l.resolve = null;
        l.ctx = null;
        resolve?.({ status: ev.status, text: l.texts.at(-1) ?? "", error: ev.error, tokens: l.turnTokens });
        return;
      }
      case "exit": {
        // Adapters report an exit during a turn as turn_end first; this is the safety net.
        if (l.turnId) this.onEvent(l, { type: "turn_end", status: "failed", error: `agent 进程意外退出${ev.error ? "：" + ev.error.slice(0, 400) : ""}` });
        this.live.delete(l.convId);
        this.busTokens.delete(l.busToken);
        return;
      }
    }
  }

  private noteCheck(root: RootTurn, command: unknown, status: string) {
    if (typeof command === "string" && CHECK_COMMAND.test(command) && root.checks.length < 20) root.checks.push({ command: clip(command.trim().split("\n")[0], 160), status });
  }

  private finishTurn(ctx: TurnCtx, turnId: string, status: TurnStatus, error?: string, usage?: Live["usage"], started?: number) {
    if (status === "failed") this.addItem(ctx.displayConvId, turnId, "error", "done", { message: error ?? "这一轮失败了", ...this.speakerData(ctx) });
    this.addItem(ctx.displayConvId, turnId, "turn_summary", status, { ...(usage ?? {}), ms: started ? Date.now() - started : undefined, ...this.speakerData(ctx) });
  }

  // ---------- Bot bus ----------
  async handleBus(token: string, tool: string, args: any): Promise<CallResult> {
    const l = this.busTokens.get(token);
    if (!l) return { text: "总线凭证无效", isError: true };
    if (!l.ctx) return { text: "现在没有进行中的回合，不能调用总线", isError: true };
    const ctx = l.ctx;
    if (RESEARCH_TOOLS.includes(tool) && !this.researchEnabled(ctx.root.convId)) return { text: "这个项目没有开启实验工作台", isError: true };
    switch (tool) {
      case "list_bots": {
        const allowed = canCallList(l.bot);
        const bots = this.store.listBots().filter((b) => b.id !== l.bot.id && (!allowed || allowed.includes(b.id)));
        return { text: bots.map((b) => `- ${b.name}：${b.role.slice(0, 160) || "（未写职责）"}`).join("\n") || "没有可调用的 Bot", isError: false };
      }
      case "ask_bot":
      case "assign_task": {
        const async = tool === "assign_task";
        const body = async ? args?.task : args?.question;
        const dependsOn = async && Array.isArray(args?.depends_on) ? ([...new Set(args.depends_on.map(String))] as string[]) : [];
        const timeoutMs = async ? this.taskTimeout(Number(args?.timeout_seconds) * 1000) : 0;
        const prepared = await this.prepareCall(l, ctx, args?.bot, body, async ? "task" : "ask", { isolated: args?.isolated === true, workspace: typeof args?.workspace === "string" ? args.workspace : undefined, dependsOn, timeoutMs });
        if ("refused" in prepared) return { text: `REFUSED：${prepared.refused}`, isError: true };
        const call: CallRun = { callId: prepared.callId, itemId: prepared.itemId, callerName: l.bot.name, ctx, target: prepared.target, child: prepared.child, question: String(body), worktree: prepared.worktree };
        if (!async) return this.runCall(call);
        this.launchTask(call, dependsOn, timeoutMs);
        return { text: JSON.stringify({ task_id: prepared.callId, status: this.store.getCall(prepared.callId)!.status }), isError: false };
      }
      case "get_task": {
        const asked = this.store.getCall(String(args?.task_id));
        if (!asked || asked.root_conv_id !== ctx.root.convId || asked.mode !== "task") return { text: "没有这个任务", isError: true };
        // A person may have retried it, in this round or a later one.
        const row = this.store.latestAttempt(asked.id as string)!;
        const wait = Math.min(Math.max(Number(args?.wait_seconds) || 0, 0), 300);
        const run = ctx.root.tasks.get(row.id as string);
        if (run && wait) await Promise.race([run.done, new Promise((r) => setTimeout(r, wait * 1000))]);
        const cur = this.store.getCall(row.id as string)!;
        return { text: JSON.stringify({ task_id: cur.id, bot: cur.to_bot, status: cur.status, answer: cur.answer, reason: cur.reason ?? undefined }), isError: cur.status === "failed" || cur.status === "timeout" };
      }
      case "remember": {
        const scope: MemoryScope = args?.scope === "project" ? "project" : "bot";
        if (typeof args?.text !== "string" || !args.text.trim()) return { text: "内容不能为空", isError: true };
        const id = scope === "bot" ? l.bot.id : Memory.projectId(this.store.getConversation(l.convId)!.cwd);
        await this.memory.append(scope, id, args.text.slice(0, 2000), l.bot.name);
        this.broadcast({ type: "memory", scope, id });
        return { text: "已记下", isError: false };
      }
      case "recall": {
        const scope: MemoryScope = args?.scope === "project" ? "project" : "bot";
        const id = scope === "bot" ? l.bot.id : Memory.projectId(this.store.getConversation(l.convId)!.cwd);
        return { text: this.memory.read(scope, id) || "还没有记忆", isError: false };
      }
      case "run_experiment": {
        const rootConv = this.store.getConversation(ctx.root.convId)!;
        const projectId = Memory.projectId(rootConv.cwd);
        const req = this.research.prepare(projectId, this.store.getConversation(l.convId)!.cwd, args);
        const answer = await this.askUser(l, ctx, { kind: "job_request", title: `启动实验：${req.name}`, detail: this.research.describe(req), canRemember: false, from: l.bot.name });
        if (answer.decision === "expired") return { text: "这次申请已失效", isError: true };
        if (answer.decision === "deny") return { text: "用户拒绝了这次实验", isError: true };
        const exp = await this.research.start(req, { rootConvId: rootConv.id, botName: l.bot.name });
        const item = this.addItem(rootConv.id, l.turnId, "job", "running", { experimentId: exp.id, name: exp.name, role: exp.role, seed: exp.seed, target: exp.target, from: l.bot.name, projectId });
        this.research.setItem(exp.id, item.id);
        return { text: JSON.stringify({ experiment_id: exp.id, status: "running", commit: exp.commit_hash, note: "已在后台运行。结束本轮即可，跑完平台会唤醒这个对话" }), isError: false };
      }
      case "add_idea":
      case "update_idea":
      case "list_ideas":
      case "list_experiments":
      case "get_experiment": {
        const projectId = Memory.projectId(this.store.getConversation(ctx.root.convId)!.cwd);
        return { text: JSON.stringify(this.research.tool(tool, projectId, args, l.bot.name)), isError: false };
      }
      case "create_bot":
      case "update_bot":
      case "pause_bot":
        if (!l.bot.is_chief) return { text: "只有 Chief 可以管理 Bot", isError: true };
        return this.manageBot(l, ctx, tool, args);
      default:
        return { text: `没有工具 ${tool}`, isError: true };
    }
  }

  // Chief can only propose: nothing changes until the user approves the card.
  private async manageBot(l: Live, ctx: TurnCtx, tool: string, args: any): Promise<CallResult> {
    const existing = tool === "create_bot" ? undefined : this.store.listBots().find((b) => b.name.toLowerCase() === String(args?.bot ?? "").trim().toLowerCase());
    if (tool !== "create_bot" && !existing) return { text: `没有叫 ${String(args?.bot)} 的 Bot`, isError: true };
    if (existing?.is_chief) return { text: "Chief 不能修改或暂停自己", isError: true };
    if (tool === "pause_bot") {
      this.store.updateBot(existing!.id, { paused: 1 });
      this.addItem(ctx.root.convId, l.turnId, "error", "done", { message: `Chief 暂停了 ${existing!.name}。可以在它的设置里恢复。` });
      this.broadcast({ type: "bots_changed" });
      return { text: `已暂停 ${existing!.name}`, isError: false };
    }
    if (tool === "create_bot" && this.store.listBots().length >= MAX_BOTS) return { text: `Bot 数量已达上限 ${MAX_BOTS}`, isError: true };
    const spec = pick(args);
    if (!existing && !spec.model) return { text: "新建 Bot 必须指定 model", isError: true };
    if (spec.model && !MODELS[(spec.agent ?? existing?.agent) as AgentKind]?.includes(spec.model)) return { text: `模型 ${spec.model} 不属于这个 agent`, isError: true };
    if (spec.name && this.store.listBots().some((b) => b.id !== existing?.id && b.name.toLowerCase() === String(spec.name).trim().toLowerCase())) return { text: `已经有叫 ${spec.name} 的 Bot`, isError: true };
    try {
      await this.validateBot(spec, existing);
    } catch (e) {
      return { text: (e as Error).message, isError: true };
    }
    const title = existing ? `修改 Bot：${existing.name}` : `新建 Bot：${spec.name}`;
    const shown = { ...existing && pick(existing), ...spec };
    const detail = [`名称：${shown.name}`, `底层：${shown.agent} · ${shown.model}`, `强度：${shown.effort ?? this.store.settings().default_effort}`, `权限：${PERMISSION_TEXT[shown.permission ?? this.store.settings().default_permission]}`, `每轮预算：${shown.budget_tokens ?? this.store.settings().default_budget_bot} tokens`, "", `职责：${shown.role ?? ""}`].join("\n");
    const answer = await this.askUser(l, ctx, { kind: "bot_proposal", title, detail, canRemember: false, from: l.bot.name, spec: shown, existingId: existing?.id });
    if (answer.decision === "expired") return { text: "提议已失效", isError: true };
    if (answer.decision === "deny") return { text: "用户拒绝了这个提议", isError: true };
    const finalSpec = answer.spec ?? spec;
    const bot = existing ? this.store.updateBot(existing.id, await this.validateBot(finalSpec, existing))! : this.store.createBot(await this.validateBot(finalSpec));
    this.broadcast({ type: "bots_changed" });
    return { text: `已${existing ? "修改" : "创建"} Bot：${bot.name}。`, isError: false };
  }

  // Puts a card in front of the user and waits. The tool call stays open until they answer or the turn ends.
  private askUser(l: Live, ctx: TurnCtx, data: Record<string, unknown>) {
    const item = this.addItem(ctx.root.convId, l.turnId, "approval", "pending", data);
    l.approvals.set(item.id, "proposal");
    return new Promise<{ decision: ApprovalDecision | "expired"; spec?: any }>((resolve) => this.proposals.set(item.id, { live: l, resolve }));
  }

  // ---------- finished experiments ----------
  private onExperimentFinished(e: any) {
    const summary = e.metrics && Object.keys(e.metrics).length ? JSON.stringify(e.metrics) : "（脚本没有写出指标）";
    const statusText: Record<string, string> = { done: "已完成", failed: "失败", lost: "进程丢失" };
    const tail = e.status === "done" ? "" : `\n日志结尾：\n${this.research.logTail(e.id, 1500)}`;
    const notice = `实验 ${e.name}（${e.id}）${statusText[e.status] ?? e.status}。指标：${summary}${tail}`;
    if (e.item_id && this.store.getItem(e.item_id)) {
      const cur = this.store.getItem(e.item_id)!;
      this.updateItem(e.item_id, { status: e.status, data: { ...cur.data, metrics: e.metrics, notice } });
    }
    if (!e.root_conv_id) return;
    if (this.research.settings(e.project_id).auto_wake) return this.wake(e.root_conv_id, notice);
    // Nobody is woken, but whoever a group talks to next should still know.
    if (this.store.getConversation(e.root_conv_id)?.kind === "group") this.addItem(e.root_conv_id, null, "notice", "done", { text: notice });
  }

  // Spends tokens, so it runs under a normal budget, and only after a person approved the experiment.
  private wake(convId: string, notice: string) {
    const conv = this.store.getConversation(convId);
    if (!conv) return;
    if (this.roots.has(convId)) {
      this.pendingWakes.set(convId, [...(this.pendingWakes.get(convId) ?? []), notice]);
      return;
    }
    const nextStep = "请根据结果决定下一步。需要用户决定的事就直接汇报，不要自行启动大量新实验。";
    if (conv.kind === "group" && conv.group_id) {
      const group = this.store.getGroup(conv.group_id);
      if (!group) return;
      const members = this.store.groupMembers(group.id);
      const target = members.find((m) => m.is_chief) ?? members[0];
      if (!target) return;
      // Added now rather than when the run ended: no round is open, so this is newer than anything any member has read.
      this.addItem(convId, null, "notice", "done", { text: notice });
      this.setConversation(convId, { status: "running" });
      const root = this.openRoot(convId, group.budget_tokens);
      void this.runGroupRound(group, conv, [target], members, root, `\n\n${nextStep}`).finally(() => this.closeRoot(root));
      return;
    }
    const prompt = `[平台通知，不是用户发的] ${notice}\n\n${nextStep}`;
    const bot = conv.bot_id ? this.store.getBot(conv.bot_id) : undefined;
    if (!bot || conv.agent !== bot.agent) return;
    this.setConversation(convId, { status: "running" });
    const root = this.openRoot(convId, bot.budget_tokens);
    void this.runTurn(bot, convId, prompt, { root, displayConvId: convId, depth: 0, chain: [bot.id], callId: null, callPath: [], speaker: null }).finally(() => this.closeRoot(root));
  }

  // What every call must pass, whether a Bot asks for it or a person retries one.
  private callRefusal(caller: Bot, target: Bot, at: { chain: string[]; depth: number }, root: Pick<RootTurn, "stopping" | "overBudget" | "callCount" | "activeCalls">, deferred: boolean): string | null {
    if (target.id === caller.id) return "不能调用自己";
    if (target.paused) return `${target.name} 已被暂停`;
    const allowed = canCallList(caller);
    if (allowed && !allowed.includes(target.id)) return `${caller.name} 没有调用 ${target.name} 的权限`;
    if (at.chain.includes(target.id)) return `${target.name} 已经在这条调用链上，不能循环调用`;
    const limits = this.store.settings();
    if (at.depth + 1 > limits.max_depth) return `调用深度已达上限 ${limits.max_depth}`;
    if (root.stopping) return root.overBudget ? "本轮预算已用完" : "这一轮已被停止";
    if (root.callCount >= limits.max_calls) return `这一轮的调用次数已达上限 ${limits.max_calls}`;
    // A task waiting for its dependencies is not running yet; it takes a slot when it starts.
    if (!deferred && root.activeCalls >= limits.max_active) return `同时进行的调用已达上限 ${limits.max_active}，请先等待结果`;
    return null;
  }

  private dependencyRefusal(ids: string[], rootConvId: string): string | null {
    for (const id of ids) {
      const first = this.store.getCall(id);
      if (!first || first.root_conv_id !== rootConvId || first.mode !== "task") return `没有任务 ${id}，depends_on 只能写这个对话里的 task_id`;
      const dep = this.store.latestAttempt(id)!;
      if (dep.status !== "done" && !STILL_GOING.includes(dep.status as string)) return `依赖的任务（${dep.to_bot}：${firstLine(dep.question)}）没有完成，状态是 ${dep.status}`;
    }
    return null;
  }

  // Shortening is the only thing a Bot can do: the setting is also the ceiling. 0 means no limit.
  private taskTimeout(askedMs: number) {
    const ceiling = this.store.settings().task_timeout_minutes * 60000;
    if (!(askedMs > 0)) return ceiling;
    return ceiling ? Math.min(askedMs, ceiling) : askedMs;
  }

  private async prepareCall(l: Live, ctx: TurnCtx, name: unknown, body: unknown, mode: string, place: { isolated: boolean; workspace?: string; dependsOn: string[]; timeoutMs: number }): Promise<{ refused: string } | { callId: string; itemId: string; target: Bot; child: Conversation; worktree: Worktree | null }> {
    const root = ctx.root;
    const refuse = (reason: string, to = String(name ?? "?")) => {
      const id = randomUUID();
      this.store.addCall({ id, rootTurnId: root.id, rootConvId: root.convId, callerConvId: l.convId, childConvId: null, parentCallId: ctx.callId, from: l.bot.name, to, mode, depth: ctx.depth + 1, question: String(body ?? "").slice(0, 2000), status: "refused", answer: reason, reason });
      this.addItem(ctx.displayConvId, l.turnId, "call", "refused", { from: l.bot.name, to, question: String(body ?? "").slice(0, 2000), answer: reason, mode });
      this.broadcast({ type: "trace", convId: root.convId });
      return { refused: reason };
    };
    if (typeof body !== "string" || !body.trim()) return refuse("问题不能为空");
    const target = this.store.listBots().find((b) => b.name.toLowerCase() === String(name ?? "").trim().toLowerCase());
    if (!target) return refuse(`没有叫 ${String(name)} 的 Bot，请先用 list_bots 查看`);
    const deferred = place.dependsOn.length > 0;
    const refusal = this.callRefusal(l.bot, target, ctx, root, deferred) ?? this.dependencyRefusal(place.dependsOn, root.convId);
    if (refusal) return refuse(refusal, target.name);

    if (place.isolated && place.workspace) return refuse("isolated 和 workspace 只能选一个", target.name);
    let cwd = this.store.getConversation(l.convId)!.cwd;
    const callerCwd = cwd;
    if (place.workspace) {
      // Only worktrees made for this conversation: a Bot must not be able to point another Bot at any path.
      const known = this.store.listWorktrees(root.convId).find((w) => w.status === "active" && w.path === place.workspace);
      if (!known) return refuse(`${place.workspace} 不是这个对话里的工作树`, target.name);
      cwd = known.path;
    }
    let child = place.isolated ? undefined : this.store.findChild("call", l.convId, target.id, cwd);
    if (child && child.agent !== target.agent) child = undefined;
    // A deferred task starts once that Bot is free, so being busy now is not a reason to refuse it.
    if (child && !deferred && this.live.get(child.id)?.turnId) return refuse(`${target.name} 正在处理你上一个请求，请先等待结果`, target.name);

    // Counted before the first await, so parallel calls cannot slip past the limits.
    root.callCount++;
    if (!deferred) root.activeCalls++;
    let worktree: Worktree | null = null;
    if (place.isolated) {
      try {
        const made = await this.worktrees.create(callerCwd, target.name, root.convId);
        worktree = made.wt;
        cwd = made.cwd;
        this.broadcast({ type: "worktrees", convId: root.convId });
      } catch (e) {
        root.callCount--;
        if (!deferred) root.activeCalls--;
        return refuse((e as Error).message, target.name);
      }
    }
    child ??= this.store.createChild("call", l.convId, target, cwd, `${l.bot.name} → ${target.name}`);
    const callId = randomUUID();
    const status = deferred ? "waiting" : "running";
    this.store.addCall({ id: callId, rootTurnId: root.id, rootConvId: root.convId, callerConvId: l.convId, childConvId: child.id, parentCallId: ctx.callId, from: l.bot.name, to: target.name, mode, depth: ctx.depth + 1, question: body, status, chain: ctx.chain, dependsOn: place.dependsOn, timeoutMs: place.timeoutMs });
    const item = this.addItem(ctx.displayConvId, l.turnId, "call", status, { from: l.bot.name, to: target.name, toId: target.id, question: body, childConvId: child.id, mode, callId, branch: worktree?.branch });
    this.broadcast({ type: "trace", convId: root.convId });
    return { callId, itemId: item.id, target, child, worktree };
  }

  private async runCall(c: CallRun): Promise<CallResult> {
    const { callId, itemId, ctx, target, child, worktree, task } = c;
    const chainNames = [...ctx.chain.map((id) => this.store.getBot(id)?.name ?? "?"), target.name].join(" → ");
    const deps = (task?.dependsOn ?? []).map((id) => this.store.latestAttempt(id)!).map((d) => `\n\n它依赖的任务（${d.to_bot}：${firstLine(d.question)}）已完成，结论：\n${clip(String(d.answer ?? ""), DEP_ANSWER)}`);
    const prompt = `这是来自同事 Bot ${c.callerName} 的请求（调用链：${chainNames}）。请完成它，并在最后一条回复里直接给出结论，对方只能看到这条回复。${worktree ? `\n\n你在独立的 Git 工作树里工作（分支 ${worktree.branch}），改动不会影响别人。不用提交，用户验收后平台会统一提交。` : ""}${c.retryNote ? `\n\n${c.retryNote}` : ""}${deps.join("")}\n\n${c.question}`;
    const turn = this.runTurn(target, child.id, prompt, { root: ctx.root, displayConvId: child.id, depth: ctx.depth + 1, chain: [...ctx.chain, target.id], callId, callPath: [...ctx.callPath, callId], speaker: null });
    const r = await (task ? Promise.race([turn, task.forced]) : turn);
    ctx.root.activeCalls--;
    const answer = r.text.length > MAX_ANSWER ? `${r.text.slice(0, MAX_ANSWER)}\n…（回答过长，已截断）` : r.text;
    const completed = r.status === "completed";
    const status = completed ? "done" : task?.timedOut ? "timeout" : r.status;
    const reason = completed ? null : this.stopReason(c, r);
    const place = worktree ? `\n\n[工作树路径：${worktree.path}，分支：${worktree.branch}]\n[平台检查的${await this.worktrees.changes(worktree)}]` : "";
    const shown = (completed ? answer || "（对方没有文字回复）" : reason) + place;
    this.store.finishCall(callId, status, shown, r.tokens, reason);
    const cur = this.store.getItem(itemId);
    if (cur) this.updateItem(itemId, { status, data: { ...cur.data, answer: shown, tokens: r.tokens } });
    this.broadcast({ type: "trace", convId: ctx.root.convId });
    this.pumpTasks(ctx.root);
    return { text: shown, isError: !completed };
  }

  // The most specific thing we know, because this is what a person reads to decide whether to retry.
  private stopReason(c: CallRun, r: TurnResult) {
    const { root } = c.ctx;
    if (c.task?.timedOut) return `超过 ${duration(c.task.timeoutMs)}没有完成，已停止`;
    if (r.status === "failed") return r.error || "调用失败";
    if (c.ctx.callPath.some((id) => root.tasks.get(id)?.timedOut)) return "它所属的任务超时了，一起停止";
    return root.stopNote ?? "调用被中断";
  }

  // ---------- tasks ----------
  private launchTask(call: CallRun, dependsOn: string[], timeoutMs: number) {
    let settle!: TaskRun["settle"];
    let force!: TaskRun["force"];
    const done = new Promise<CallResult>((r) => (settle = r));
    const forced = new Promise<TurnResult>((r) => (force = r));
    const task: TaskRun = { ...call, state: "waiting", dependsOn, timeoutMs, timedOut: false, clock: null, forceTimer: null, force, forced, settle, done };
    task.task = task;
    call.ctx.root.tasks.set(call.callId, task);
    if (dependsOn.length) this.pumpTasks(call.ctx.root);
    else this.startTask(task);
    return task;
  }

  private startTask(task: TaskRun) {
    task.state = "running";
    this.startClock(task);
    void this.runCall(task).then((r) => {
      if (task.clock) clearInterval(task.clock);
      if (task.forceTimer) clearTimeout(task.forceTimer);
      task.state = "finished";
      task.settle(r);
      // Only now is its Bot free for whoever is queued behind it.
      this.pumpTasks(task.ctx.root);
    });
  }

  // Starts what can start and ends what can no longer run. Called whenever a slot frees up or a task ends.
  private pumpTasks(root: RootTurn) {
    const maxActive = this.store.settings().max_active;
    let ended = false;
    for (const t of root.tasks.values()) {
      if (t.state !== "waiting") continue;
      if (root.stopping) {
        this.endWaiting(t, "interrupted", this.stopReason(t, { status: "interrupted", text: "", tokens: 0 }));
        ended = true;
        continue;
      }
      const deps = t.dependsOn.map((id) => this.store.latestAttempt(id)!);
      const failed = deps.find((d) => d.status !== "done" && !STILL_GOING.includes(d.status as string));
      if (failed) {
        this.endWaiting(t, "failed", `依赖的任务（${failed.to_bot}：${firstLine(failed.question)}）没有完成：${firstLine(failed.reason ?? failed.status)}`);
        ended = true;
        continue;
      }
      if (deps.some((d) => d.status !== "done") || root.activeCalls >= maxActive || this.childBusy(t.child.id, root)) continue;
      root.activeCalls++;
      this.store.startCall(t.callId);
      const cur = this.store.getItem(t.itemId);
      if (cur) this.updateItem(t.itemId, { status: "running" });
      this.broadcast({ type: "trace", convId: root.convId });
      this.startTask(t);
    }
    // Ending one can decide the fate of those waiting on it.
    if (ended) this.pumpTasks(root);
  }

  private childBusy(childId: string, root: RootTurn) {
    return Boolean(this.live.get(childId)?.turnId) || [...root.tasks.values()].some((t) => t.state === "running" && t.child.id === childId);
  }

  private endWaiting(t: TaskRun, status: string, reason: string) {
    t.state = "finished";
    this.store.finishCall(t.callId, status, reason, 0, reason);
    const cur = this.store.getItem(t.itemId);
    if (cur) this.updateItem(t.itemId, { status, data: { ...cur.data, answer: reason } });
    this.broadcast({ type: "trace", convId: t.ctx.root.convId });
    t.settle({ text: reason, isError: true });
  }

  private inSubtree(task: TaskRun) {
    return [...task.ctx.root.active].filter((l) => l.ctx?.callPath.includes(task.callId));
  }

  // Only time spent working counts: a person who has not answered an approval yet is not the task being slow.
  private startClock(task: TaskRun) {
    if (!task.timeoutMs) return;
    let last = Date.now();
    let used = 0;
    task.clock = setInterval(() => {
      const now = Date.now();
      if (!this.inSubtree(task).some((l) => l.approvals.size)) used += now - last;
      last = now;
      if (used < task.timeoutMs) return;
      clearInterval(task.clock!);
      task.clock = null;
      this.timeOutTask(task);
    }, Math.max(20, Math.min(1000, task.timeoutMs / 4)));
    task.clock.unref();
  }

  // Stops this task and what it started, and nothing else in the round.
  private timeOutTask(task: TaskRun) {
    const { root } = task.ctx;
    task.timedOut = true;
    for (const l of this.inSubtree(task)) void this.interruptLive(l);
    for (const t of root.tasks.values()) {
      if (t.state === "waiting" && t.ctx.callPath.includes(task.callId)) this.endWaiting(t, "interrupted", "它所属的任务超时了，一起停止");
    }
    // An agent stuck before its turn began has nothing to interrupt, and the task must still end.
    task.forceTimer = setTimeout(() => {
      this.dropRuntime(task.child.id);
      task.force({ status: "interrupted", text: "", tokens: 0 });
    }, INTERRUPT_GRACE_MS + 1000);
    task.forceTimer.unref();
  }

  // Only a person can retry, and it goes through the same checks a Bot's call does. Nothing here
  // awaits before the new row exists, so a double click cannot start it twice.
  retryTask(id: string) {
    const row = this.store.getCall(id);
    if (!row || row.mode !== "task") throw new HttpError(404, "任务不存在");
    if (!RETRYABLE.includes(row.status as string)) throw new HttpError(409, "只有失败、超时或中断的任务可以重试");
    if (this.store.latestAttempt(id)!.id !== id) throw new HttpError(409, "这个任务已经重试过了");
    const conv = this.store.getConversation(row.root_conv_id as string);
    if (!conv) throw new HttpError(404, "这个任务的对话已归档");
    if (!row.chain) throw new HttpError(409, "这个任务是旧版本建的，没有调用链记录，无法确认限制，不能重试");
    const chain = JSON.parse(row.chain as string) as string[];
    const caller = this.store.getBot(chain.at(-1)!);
    const callerConv = this.store.getConversation(row.caller_conv_id as string);
    if (!caller || !callerConv) throw new HttpError(409, `发起这个任务的 ${row.from_bot} 已归档`);
    const oldChild = row.child_conv_id ? this.store.getConversation(row.child_conv_id as string) : undefined;
    const target = oldChild?.bot_id ? this.store.getBot(oldChild.bot_id) : undefined;
    if (!oldChild || !target) throw new HttpError(409, `${row.to_bot} 已归档`);
    const budget = conv.kind === "group" ? this.store.getGroup(conv.group_id!)?.budget_tokens : conv.bot_id ? this.store.getBot(conv.bot_id)?.budget_tokens : undefined;
    if (budget === undefined) throw new HttpError(409, "这个对话所属的 Bot 或群聊已归档");

    const open = this.roots.get(conv.id);
    const dependsOn = row.depends_on ? (JSON.parse(row.depends_on as string) as string[]) : [];
    const depRefusal = this.dependencyRefusal(dependsOn, conv.id);
    if (depRefusal) throw new HttpError(409, `${depRefusal}，请先重试它`);
    const deferred = dependsOn.some((d) => this.store.latestAttempt(d)!.status !== "done");
    const at = { chain, depth: (row.depth as number) - 1 };
    const refusal = this.callRefusal(caller, target, at, open ?? { stopping: false, overBudget: false, callCount: 0, activeCalls: 0 }, deferred);
    if (refusal) throw new HttpError(409, refusal);
    if (open && !deferred && this.childBusy(oldChild.id, open)) throw new HttpError(409, `${target.name} 正在忙，请等它结束再重试`);
    const worktree = this.store.listWorktrees(conv.id).find((w) => oldChild.cwd === w.path || oldChild.cwd.startsWith(`${w.path}/`)) ?? null;
    if (worktree && worktree.status !== "active") throw new HttpError(409, "这个任务的工作树已经合并或丢弃，不能在上面重试");

    // With no round open this is like the person sending another message: a new round under the normal per-round budget.
    if (!open) this.setConversation(conv.id, { status: "running" });
    const root = open ?? this.openRoot(conv.id, budget);
    root.callCount++;
    if (!deferred) root.activeCalls++;
    const child = oldChild.agent === target.agent ? oldChild : this.store.createChild("call", callerConv.id, target, oldChild.cwd, `${caller.name} → ${target.name}`);
    const callId = randomUUID();
    const status = deferred ? "waiting" : "running";
    const timeoutMs = this.taskTimeout(Number(row.timeout_ms));
    const parent = open ? (row.parent_call_id as string | null) : null;
    this.store.addCall({ id: callId, rootTurnId: root.id, rootConvId: conv.id, callerConvId: callerConv.id, childConvId: child.id, parentCallId: parent, from: caller.name, to: target.name, mode: "task", depth: row.depth as number, question: row.question as string, status, chain, dependsOn, retryOf: id, timeoutMs });
    const item = this.addItem(conv.id, null, "call", status, { from: caller.name, to: target.name, toId: target.id, question: row.question, childConvId: child.id, mode: "task", callId, branch: worktree?.branch, retry: true });
    this.broadcast({ type: "trace", convId: conv.id });
    const ctx: TurnCtx = { root, displayConvId: conv.id, depth: at.depth, chain, callId: parent, callPath: parent ? this.callPath(parent) : [], speaker: null };
    const retryNote = `这是一次重试，上一次的结果：${firstLine(row.reason ?? row.status)}。之前做的可能已经留下了，先确认再继续。`;
    const task = this.launchTask({ callId, itemId: item.id, callerName: caller.name, ctx, target, child, question: row.question as string, worktree, retryNote }, dependsOn, timeoutMs);
    // Whoever asked for this has ended its turn, so the result goes where the next turn will read it.
    if (!open) {
      void task.done.then((r) => {
        const after = this.store.getCall(callId)!;
        this.addItem(conv.id, null, "notice", "done", { text: `重试的任务（${after.from_bot} → ${after.to_bot}，task_id ${callId}）${OUTCOME[after.status as string] ?? after.status}：${clip(r.text, NOTICE_ANSWER)}` });
        this.closeRoot(root);
      });
    }
    return this.taskView(this.store.getCall(callId)!);
  }

  private callPath(callId: string) {
    const path: string[] = [];
    for (let cur = this.store.getCall(callId); cur; cur = cur.parent_call_id ? this.store.getCall(cur.parent_call_id as string) : undefined) path.unshift(cur.id as string);
    return path;
  }

  listTasks(convId: string | null) {
    const rows = this.store.listTasks(convId, 300);
    const replaced = new Set(rows.map((r) => r.retry_of));
    return rows.filter((r) => !replaced.has(r.id)).map((r) => this.taskView(r));
  }

  private taskView(r: Record<string, unknown>) {
    const ids = r.depends_on ? (JSON.parse(r.depends_on as string) as string[]) : [];
    const deps = ids.map((id) => this.store.latestAttempt(id)).filter((d) => d !== undefined);
    const failing = RETRYABLE.includes(r.status as string) || r.status === "refused";
    return {
      id: r.id,
      conv_id: r.root_conv_id,
      conv_title: r.conv_title,
      conv_kind: r.conv_kind,
      bot_id: r.conv_bot_id,
      group_id: r.conv_group_id,
      from: r.from_bot,
      owner: r.to_bot,
      question: r.question,
      status: r.status,
      depends_on: deps.map((d) => ({ id: d.id, owner: d.to_bot, title: firstLine(d.question), status: d.status })),
      waiting_reason: this.waitingReason(r, deps),
      failure_reason: failing ? (r.reason ?? r.answer ?? "没有记录原因") : null,
      answer: r.status === "done" ? r.answer : null,
      tokens: r.tokens,
      timeout_ms: r.timeout_ms,
      attempt: this.store.attemptNumber(r.id as string),
      can_retry: RETRYABLE.includes(r.status as string) && Boolean(r.chain) && this.store.latestAttempt(r.id as string)!.id === r.id,
      created_at: r.created_at,
      ended_at: r.ended_at,
    };
  }

  // Worked out when read: what a task is waiting on changes all the time and means nothing after a restart.
  private waitingReason(r: Record<string, unknown>, deps: Record<string, unknown>[]) {
    if (r.status === "waiting") {
      const open = deps.filter((d) => d.status !== "done");
      if (open.length) return `等 ${open.map((d) => `${d.to_bot} 完成“${firstLine(d.question)}”`).join("、")}`;
      const root = this.roots.get(r.root_conv_id as string);
      const max = this.store.settings().max_active;
      return root && root.activeCalls >= max ? `等并发名额（同时最多 ${max} 个）` : `等 ${r.to_bot} 忙完手上的事`;
    }
    if (r.status !== "running") return null;
    const task = this.roots.get(r.root_conv_id as string)?.tasks.get(r.id as string);
    if (task) {
      for (const l of this.inSubtree(task)) {
        for (const itemId of l.approvals.keys()) return `等你审批：${l.bot.name} 的“${this.store.getItem(itemId)?.data.title ?? "操作"}”`;
      }
    }
    const asked = this.store.listCalls(r.root_turn_id as string).filter((c) => c.parent_call_id === r.id && c.status === "running");
    return asked.length ? `等 ${asked.map((c) => c.to_bot).join("、")} 回复` : null;
  }

  trace(convId: string) {
    const turn = this.store.latestRootTurn(convId);
    if (!turn) return { budget: null, calls: [] };
    const live = this.roots.get(convId);
    return {
      budget: { spent: live?.id === turn.id ? live.spent : turn.spent, limit: turn.budget, active: live?.id === turn.id, status: turn.status },
      calls: this.store.listCalls(turn.id as string).map((c) => ({ id: c.id, parent: c.parent_call_id, from: c.from_bot, to: c.to_bot, mode: c.mode, depth: c.depth, status: c.status, tokens: c.tokens })),
    };
  }

  // ---------- user controls ----------
  async answerApproval(itemId: string, decision: ApprovalDecision, spec?: unknown) {
    const item = this.store.getItem(itemId);
    if (!item || item.type !== "approval") throw new HttpError(404, "审批不存在");
    if (item.status !== "pending") throw new HttpError(409, "这个审批已经处理过了");
    const proposal = this.proposals.get(itemId);
    if (proposal) {
      if (decision === "allow_session") throw new HttpError(400, "这个提议只能批准或拒绝");
      const edited = spec && item.data.kind === "bot_proposal" ? pick(spec) : undefined;
      // An edited proposal is checked now, so a mistake comes back to the person editing it.
      if (edited && decision === "allow") await this.validateBot(edited, item.data.existingId ? this.store.getBot(String(item.data.existingId)) : undefined);
      this.proposals.delete(itemId);
      proposal.live.approvals.delete(itemId);
      proposal.resolve({ decision, spec: edited });
      return this.updateItem(itemId, { status: decision === "deny" ? "denied" : "allowed", data: edited ? { ...item.data, spec: edited } : item.data });
    }
    const l = this.approvalOwners.get(itemId);
    const requestId = l?.approvals.get(itemId);
    if (!l || !requestId) {
      this.updateItem(itemId, { status: "expired" });
      throw new HttpError(409, "这个审批已经失效");
    }
    if (decision === "allow_session" && !item.data.canRemember) throw new HttpError(400, "这个操作不能设为本对话都允许");
    l.approvals.delete(itemId);
    this.approvalOwners.delete(itemId);
    l.runtime.answerApproval(requestId, decision);
    return this.updateItem(itemId, { status: decision === "deny" ? "denied" : decision === "allow_session" ? "allowed_session" : "allowed" });
  }

  async interrupt(convId: string) {
    const conv = this.store.getConversation(convId);
    if (!conv) throw new HttpError(404, "对话不存在");
    const root = this.roots.get(convId);
    if (root) this.stopRoot(root, "用户停止了这一轮");
  }

  archiveConversation(convId: string) {
    const conv = this.store.getConversation(convId);
    if (!conv) throw new HttpError(404, "对话不存在");
    if (conv.status === "running") throw new HttpError(409, "这个对话还在回复中");
    this.dropRuntime(convId);
    this.store.updateConversation(convId, { archived: 1 });
    this.broadcast({ type: "conversation_archived", convId, botId: conv.bot_id, groupId: conv.group_id });
  }

  // A person's edit must reach running agents; the Bots' own notes do not need a restart.
  noteMemoryEdited() {
    this.memoryEpoch++;
  }

  conversationRunning(rootConvId: string) {
    return this.roots.has(rootConvId);
  }

  archiveBot(botId: string) {
    if (this.store.getBot(botId)?.is_chief) throw new HttpError(400, "Chief 不能归档");
    const conversations = this.store.listConversations(botId);
    if (conversations.some((c) => c.status === "running")) throw new HttpError(409, "这个 Bot 还有对话在回复中");
    for (const c of conversations) this.dropRuntime(c.id);
    this.store.archiveBot(botId);
    this.broadcast({ type: "bot_archived", botId });
  }

  archiveGroup(groupId: string) {
    const conversations = this.store.listGroupConversations(groupId);
    if (conversations.some((c) => c.status === "running")) throw new HttpError(409, "这个群聊还在回复中");
    this.store.archiveGroup(groupId);
    this.broadcast({ type: "group_archived", groupId });
  }

  private reapIdle() {
    const now = Date.now();
    const idleMs = this.fixedIdleMs ?? this.store.settings().idle_minutes * 60000;
    for (const [convId, l] of this.live) {
      if (!l.turnId && now - l.lastUsed > idleMs) this.dropRuntime(convId);
    }
  }
}
