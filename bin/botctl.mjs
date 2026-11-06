#!/usr/bin/env node
// Drives a running Bot Platform from a terminal or a script. Talks to the same HTTP API as the web page.
import { writeFileSync } from "node:fs";

const BASE = process.env.BOT_PLATFORM_URL || `http://127.0.0.1:${process.env.PORT || 4317}`;
const USAGE = `用法：
  botctl list [--workspace 名称]                列出工作空间和 Bot
  botctl run <Bot> <消息> [选项]                 发一条消息，等这一轮和它派出的任务全部结束
      --workspace 名称   Bot 重名时指定工作空间
      --conversation ID  接着某个对话发，默认新建对话
      --timeout 分钟     最多等多久，默认 60
      --export 文件      结束后把对话导出成 Markdown
      --json             输出 JSON
  botctl export <对话ID> [--out 文件]           导出对话为 Markdown

退出码：0 完成，1 失败或被拒绝，2 超时，3 用法或找不到 Bot，4 连不上平台
平台地址：环境变量 BOT_PLATFORM_URL，默认 ${BASE}`;

class Exit extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function parse(argv) {
  const flags = {};
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--json" || a === "-h" || a === "--help") flags[a.replace(/^-+/, "")] = true;
    else if (a.startsWith("--")) {
      if (i + 1 >= argv.length) throw new Exit(3, `${a} 需要一个值`);
      flags[a.slice(2)] = argv[++i];
    } else rest.push(a);
  }
  return { flags, rest };
}

async function api(path, options = {}) {
  let res;
  try {
    res = await fetch(BASE + path, { method: options.method ?? "GET", headers: options.body ? { "content-type": "application/json" } : {}, body: options.body ? JSON.stringify(options.body) : undefined });
  } catch {
    throw new Exit(4, `连不上 Bot 平台（${BASE}）。先运行 npm start，或设置 BOT_PLATFORM_URL。`);
  }
  const text = await res.text();
  if (!res.ok) {
    let message = text;
    try {
      message = JSON.parse(text).error ?? text;
    } catch {}
    throw new Exit(res.status === 404 ? 3 : 1, message);
  }
  return options.raw ? text : JSON.parse(text);
}

async function findBot(name, workspace) {
  const state = await api("/api/state");
  const ws = workspace ? state.workspaces.find((w) => w.name === workspace || w.id === workspace) : null;
  if (workspace && !ws) throw new Exit(3, `没有工作空间“${workspace}”`);
  const hits = state.bots.filter((b) => (b.name === name || b.id === name) && (!ws || b.workspace_id === ws.id));
  if (!hits.length) throw new Exit(3, `没有名为“${name}”的 Bot${ws ? `（在 ${ws.name} 里）` : ""}`);
  if (hits.length > 1) {
    const names = hits.map((b) => state.workspaces.find((w) => w.id === b.workspace_id)?.name ?? b.workspace_id).join("、");
    throw new Exit(3, `有多个“${name}”，用 --workspace 指定：${names}`);
  }
  return hits[0];
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const OPEN = ["waiting", "running"];

async function run(flags, [name, ...words]) {
  const text = words.join(" ").trim();
  if (!name || !text) throw new Exit(3, USAGE);
  const bot = await findBot(name, flags.workspace);
  const before = flags.conversation ? (await api(`/api/conversations/${flags.conversation}/items`)).items.length : 0;
  const conv = await api(`/api/bots/${bot.id}/messages`, { method: "POST", body: { text, conversationId: flags.conversation } });
  const deadline = Date.now() + Number(flags.timeout ?? 60) * 60000;
  const told = new Set();
  let data;
  for (;;) {
    await sleep(1500);
    data = await api(`/api/conversations/${conv.id}/items`);
    const fresh = data.items.slice(before);
    for (const i of fresh) {
      if (i.type === "approval" && i.status === "pending" && !told.has(i.id)) {
        told.add(i.id);
        if (!flags.json) process.stderr.write(`等你批准：${i.data.title ?? "一项操作"}（请在网页里处理）\n`);
      }
    }
    const tasks = (await api(`/api/tasks?conv=${conv.id}`)).tasks;
    if (data.conversation.status !== "running" && !tasks.some((t) => OPEN.includes(t.status))) break;
    if (Date.now() > deadline) {
      if (flags.json) console.log(JSON.stringify({ conversationId: conv.id, status: "timeout" }));
      throw new Exit(2, `超过 ${flags.timeout ?? 60} 分钟还没结束，对话 ${conv.id} 仍在进行`);
    }
  }
  const fresh = data.items.slice(before);
  const replies = fresh.filter((i) => i.type === "assistant" && i.data.text).map((i) => ({ bot: i.data.bot?.name ?? bot.name, text: i.data.text }));
  const errors = fresh.filter((i) => i.type === "error").map((i) => i.data.message);
  const tokens = fresh.filter((i) => i.type === "turn_summary").reduce((n, i) => n + Math.max(0, (i.data.inputTokens ?? 0) - (i.data.cachedTokens ?? 0)) + (i.data.outputTokens ?? 0), 0);
  const status = errors.length ? "failed" : "completed";
  if (flags.export) writeFileSync(flags.export, await api(`/api/conversations/${conv.id}/export`, { raw: true }));
  if (flags.json) console.log(JSON.stringify({ conversationId: conv.id, status, replies, errors, tokens }, null, 2));
  else {
    const last = replies.at(-1);
    if (last) console.log(last.text);
    for (const e of errors) process.stderr.write(`错误：${e}\n`);
    process.stderr.write(`\n对话 ${conv.id} · ${replies.length} 条回复 · ${tokens} tokens（不含缓存）${flags.export ? ` · 已导出到 ${flags.export}` : ""}\n`);
  }
  return status === "completed" ? 0 : 1;
}

async function list(flags) {
  const state = await api("/api/state");
  const spaces = state.workspaces.filter((w) => !flags.workspace || w.name === flags.workspace || w.id === flags.workspace);
  if (flags.json) {
    console.log(JSON.stringify(spaces.map((w) => ({ ...w, bots: state.bots.filter((b) => b.workspace_id === w.id).map(({ id, name, agent, model, is_chief }) => ({ id, name, agent, model, is_chief })) })), null, 2));
    return 0;
  }
  for (const w of spaces) {
    const bots = state.bots.filter((b) => b.workspace_id === w.id);
    if (!bots.length) continue;
    console.log(`${w.name}${w.cwd ? `  (${w.cwd})` : ""}`);
    for (const b of bots) console.log(`  ${b.is_chief ? "★" : " "} ${b.name.padEnd(18)} ${b.agent} · ${b.model}`);
  }
  return 0;
}

async function exportConv(flags, [id]) {
  if (!id) throw new Exit(3, USAGE);
  const md = await api(`/api/conversations/${id}/export`, { raw: true });
  if (flags.out) writeFileSync(flags.out, md);
  else process.stdout.write(md);
  return 0;
}

try {
  const [cmd, ...argv] = process.argv.slice(2);
  const { flags, rest } = parse(argv);
  if (!cmd || flags.help || flags.h || cmd === "help") {
    console.log(USAGE);
    process.exit(cmd ? 0 : 3);
  }
  const handlers = { run, list, export: exportConv };
  if (!handlers[cmd]) throw new Exit(3, `不认识的命令 ${cmd}\n\n${USAGE}`);
  process.exitCode = await handlers[cmd](flags, rest);
} catch (e) {
  process.stderr.write(`${e.message}\n`);
  process.exitCode = e instanceof Exit ? e.code : 1;
}
