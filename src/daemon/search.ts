import { Memory } from "./git.ts";
import type { Store } from "./store.ts";

type Row = Record<string, any>;
export const SEARCH_LIMIT = 50;
const MAX_TERMS = 8;
const SNIPPET_BEFORE = 40;
const SNIPPET_AFTER = 120;

export interface SearchQuery {
  q: string;
  kind?: string;
  cwd?: string;
  bot?: string;
  since?: number;
  until?: number;
  status?: string;
}

// Statuses people think in, mapped to what each kind of record actually stores.
const STATUS: Record<string, string[]> = {
  running: ["running", "waiting", "streaming"],
  done: ["done", "completed"],
  failed: ["failed", "timeout", "lost", "refused"],
  stopped: ["interrupted", "cancelled", "over_budget"],
};

const like = (term: string) => `%${term.replace(/[\\%_]/g, "\\$&")}%`;

// Only what a person reads is searched, not the JSON around it, or "text" would match every message.
const ITEM_TEXT = `CASE i.type
  WHEN 'user' THEN json_extract(i.data, '$.text')
  WHEN 'assistant' THEN json_extract(i.data, '$.text')
  WHEN 'notice' THEN json_extract(i.data, '$.text')
  WHEN 'error' THEN json_extract(i.data, '$.message')
  WHEN 'call' THEN COALESCE(json_extract(i.data, '$.from'), '') || ' ' || COALESCE(json_extract(i.data, '$.to'), '') || ' ' || COALESCE(json_extract(i.data, '$.question'), '') || ' ' || COALESCE(json_extract(i.data, '$.answer'), '')
  WHEN 'comparison' THEN COALESCE(json_extract(i.data, '$.question'), '') || ' ' || COALESCE((SELECT group_concat(json_extract(value, '$.bot') || ' ' || COALESCE(json_extract(value, '$.text'), ''), ' ') FROM json_each(i.data, '$.answers')), '')
  WHEN 'result' THEN COALESCE(json_extract(i.data, '$.summary'), '') || ' ' || COALESCE((SELECT group_concat(json_extract(value, '$.path'), ' ') FROM json_each(i.data, '$.files')), '')
END`;
const ITEM_TYPES: Record<string, string[]> = { message: ["user", "assistant", "notice", "error", "comparison"], task: ["call"], file: ["result"] };
const KIND_OF: Record<string, string> = { call: "task", result: "file" };

function snippet(text: string, terms: string[]) {
  const lower = text.toLowerCase();
  const at = Math.min(...terms.map((t) => lower.indexOf(t.toLowerCase())).filter((i) => i >= 0));
  const from = Math.max(0, at - SNIPPET_BEFORE);
  return `${from ? "…" : ""}${text.slice(from, at + SNIPPET_AFTER).replace(/\s+/g, " ").trim()}${text.length > at + SNIPPET_AFTER ? "…" : ""}`;
}

export function search(store: Store, query: SearchQuery) {
  const terms = query.q.trim().split(/\s+/).filter(Boolean).slice(0, MAX_TERMS);
  if (!terms.length) return { results: [], more: false };
  const statuses = query.status ? (STATUS[query.status] ?? []) : null;
  const botName = query.bot ? (store.getBot(query.bot)?.name ?? "") : null;
  const wants = (kind: string) => !query.kind || query.kind === kind;
  const out: Row[] = [];
  const dates = (col: string, where: string[], args: unknown[]) => {
    if (query.since) (where.push(`${col}>=?`), args.push(query.since));
    if (query.until) (where.push(`${col}<?`), args.push(query.until));
  };
  const matches = (col: string, where: string[], args: unknown[]) => {
    for (const t of terms) (where.push(`${col} LIKE ? ESCAPE '\\'`), args.push(like(t)));
  };
  const among = (col: string, list: string[], where: string[], args: unknown[]) => {
    where.push(`${col} IN (${list.map(() => "?").join(",")})`);
    args.push(...list);
  };

  // A status says nothing about a message, so filtering by one leaves out plain chat.
  const types = Object.entries(ITEM_TYPES).filter(([k]) => wants(k)).flatMap(([, t]) => t).filter((t) => !statuses || !["user", "assistant", "notice", "comparison"].includes(t));
  if (types.length) {
    const where: string[] = [];
    const args: unknown[] = [];
    among("type", types, where, args);
    matches("haystack", where, args);
    dates("created_at", where, args);
    if (query.cwd) (where.push("cwd=?"), args.push(query.cwd));
    if (query.bot) (where.push("(bot_id=? OR speaker=? OR target=?)"), args.push(query.bot, query.bot, query.bot));
    // An error card records no outcome of its own: it is the failure.
    if (statuses) {
      if (query.status === "failed") where.push(`(type='error' OR status IN (${statuses.map(() => "?").join(",")}))`);
      else {
        where.push(`(type!='error' AND status IN (${statuses.map(() => "?").join(",")}))`);
      }
      args.push(...statuses);
    }
    const rows = store.db
      .prepare(
        `SELECT * FROM (
           SELECT i.id, i.seq, i.type, i.status, i.created_at, i.conv_id, v.title conv_title, v.bot_id, v.group_id, v.cwd,
                  json_extract(i.data, '$.bot.id') speaker, json_extract(i.data, '$.bot.name') speaker_name, json_extract(i.data, '$.toId') target,
                  json_extract(i.data, '$.from') call_from, json_extract(i.data, '$.to') call_to, ${ITEM_TEXT} haystack
           FROM items i JOIN conversations v ON v.id=i.conv_id
           LEFT JOIN bots b ON b.id=v.bot_id LEFT JOIN groups g ON g.id=v.group_id
           WHERE v.archived=0 AND ((v.kind='direct' AND b.archived=0) OR (v.kind='group' AND g.archived=0))
         ) WHERE ${where.join(" AND ")} ORDER BY created_at DESC, seq DESC LIMIT ?`,
      )
      .all(...(args as any[]), SEARCH_LIMIT + 1) as Row[];
    for (const r of rows) {
      const who = r.type === "user" ? "你" : r.type === "call" ? `${r.call_from} → ${r.call_to}` : r.speaker_name;
      out.push({ kind: KIND_OF[r.type] ?? "message", type: r.type, id: r.id, conv_id: r.conv_id, conv_title: r.conv_title, bot_id: r.bot_id, group_id: r.group_id, at: r.created_at, status: r.status, who: who ?? null, snippet: snippet(r.haystack, terms) });
    }
  }

  if (wants("experiment")) {
    const project = query.cwd ? Memory.projectId(query.cwd) : null;
    const where: string[] = [];
    const args: unknown[] = [];
    // Test-set results are left out on purpose: they stay in the one place they are shown.
    matches("(name || ' ' || command || ' ' || config)", where, args);
    dates("created_at", where, args);
    if (project) (where.push("project_id=?"), args.push(project));
    if (botName !== null) (where.push("bot_name=?"), args.push(botName));
    if (statuses) among("status", statuses, where, args);
    for (const r of store.db.prepare(`SELECT id, name, command, config, status, created_at, project_id, bot_name FROM experiments WHERE ${where.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...(args as any[]), SEARCH_LIMIT + 1) as Row[]) {
      out.push({ kind: "experiment", type: "experiment", id: r.id, project_id: r.project_id, at: r.created_at, status: r.status, who: r.bot_name, conv_title: r.name, snippet: snippet(`${r.name} ${r.command} ${r.config}`, terms) });
    }
    if (!statuses) {
      const idea: string[] = [];
      const ideaArgs: unknown[] = [];
      matches("(title || ' ' || hypothesis || ' ' || conclusion || ' ' || failure_reason)", idea, ideaArgs);
      dates("created_at", idea, ideaArgs);
      if (project) (idea.push("project_id=?"), ideaArgs.push(project));
      if (botName !== null) (idea.push("created_by=?"), ideaArgs.push(botName));
      for (const r of store.db.prepare(`SELECT id, title, hypothesis, conclusion, failure_reason, status, created_at, project_id, created_by FROM ideas WHERE ${idea.join(" AND ")} ORDER BY created_at DESC LIMIT ?`).all(...(ideaArgs as any[]), SEARCH_LIMIT + 1) as Row[]) {
        out.push({ kind: "experiment", type: "idea", id: r.id, project_id: r.project_id, at: r.created_at, status: r.status, who: r.created_by, conv_title: r.title, snippet: snippet(`${r.title} ${r.hypothesis} ${r.conclusion} ${r.failure_reason}`, terms) });
      }
    }
  }
  out.sort((a, b) => b.at - a.at);
  return { results: out.slice(0, SEARCH_LIMIT), more: out.length > SEARCH_LIMIT };
}
