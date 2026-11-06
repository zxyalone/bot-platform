import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { HttpError } from "./errors.ts";
import { git, Memory } from "./git.ts";
import type { Projects } from "./projects.ts";
import { CHIEF_ROLE, ENGINEER_ROLE, REVIEWER_ROLE, type Store } from "./store.ts";
import { validModel, type AgentKind, type Effort, type PermissionPreset } from "./types.ts";

const SCHOLAR_ROLE = "你是团队的调研员 Scholar，负责查资料和整理已有工作。结论都要有出处，写明链接或文件路径；查不到就直接说查不到，不要编造引用。不改文件。";

// A team that can start on anything. The person picks who to keep and on which model.
export const WORKSPACE_TEMPLATES = [
  { key: "chief", name: "Chief", role: CHIEF_ROLE, agent: "claude", model: "claude-sonnet-5-5", effort: "medium", permission: "read_only", required: true, on: true, summary: "拆解任务、调度其他 Bot" },
  { key: "engineer", name: "Engineer", role: ENGINEER_ROLE, agent: "codex", model: "gpt-6.1-terra", effort: "medium", permission: "ask", required: false, on: true, summary: "写代码、改文件" },
  { key: "reviewer", name: "Reviewer", role: REVIEWER_ROLE, agent: "claude", model: "claude-sonnet-5-5", effort: "medium", permission: "ask", required: false, on: true, summary: "审查成果、挑错" },
  { key: "scholar", name: "Scholar", role: SCHOLAR_ROLE, agent: "antigravity", model: "gemini-3.8-flash", effort: "medium", permission: "read_only", required: false, on: false, summary: "查资料、整理已有工作" },
] as const;

// Who fills each seat when its first choice is not installed here, cheapest sensible model first.
const PREFER: Record<string, [AgentKind, string][]> = {
  chief: [["claude", "claude-sonnet-5-5"], ["codex", "gpt-6.1-terra"], ["antigravity", "gemini-4-argon"], ["grok", "grok-4.7"], ["dsh", "deepseek-account/deepseek-v4-pro"]],
  engineer: [["codex", "gpt-6.1-terra"], ["claude", "claude-sonnet-5-5"], ["grok", "grok-4.7-build-fast"], ["antigravity", "gemini-4-argon"], ["dsh", "deepseek-account/deepseek-v4-pro"]],
  reviewer: [["claude", "claude-sonnet-5-5"], ["codex", "gpt-6-astra"], ["antigravity", "gemini-4-argon"], ["grok", "grok-4.7"], ["dsh", "deepseek-account/deepseek-v4-pro"]],
  scholar: [["antigravity", "gemini-3.8-flash"], ["grok", "grok-4.7-build-fast"], ["claude", "claude-haiku-5-5"], ["codex", "gpt-6-luna"], ["dsh", "deepseek-account/deepseek-flash"]],
};

export type AgentStatusMap = Record<string, { installed: boolean; loggedIn: boolean; models: string[] } | undefined>;

// Each seat on an agent this person can actually use: logged in first, then merely installed.
export function templatesFor(status: AgentStatusMap) {
  const ready = (a: string) => Boolean(status[a]?.installed && status[a]?.loggedIn);
  const installed = (a: string) => Boolean(status[a]?.installed);
  const usable = Object.keys(status).filter(ready);
  return WORKSPACE_TEMPLATES.map(({ role: _role, ...t }) => {
    const options = PREFER[t.key] ?? [[t.agent, t.model]];
    const pick = options.find(([a]) => ready(a)) ?? options.find(([a]) => installed(a));
    const models = pick ? status[pick[0]]?.models ?? [] : [];
    const model = pick && (models.includes(pick[1]) || !models.length) ? pick[1] : models[0];
    // A seat only one agent could fill does not need a second Bot on the same agent unless asked.
    const on = t.on || (t.key === "scholar" && usable.length >= 3);
    return { ...t, on, agent: pick?.[0] ?? null, model: pick ? model : null, ready: pick ? ready(pick[0]) : false };
  });
}

const folderName = (name: string) => name.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 60) || "workspace";
const expand = (p: string) => (p === "~" ? homedir() : p.startsWith("~/") ? join(homedir(), p.slice(2)) : p);

export function listWorkspaces(store: Store) {
  const rows = store.db.prepare("SELECT id, name, cwd, created_at FROM workspaces ORDER BY created_at").all() as Record<string, unknown>[];
  return [{ id: "default", name: "默认工作空间", cwd: null, created_at: 0 }, ...rows];
}

// Everything one click needs: the directory, Git so worktrees work, and a team of its own.
export async function createWorkspace(store: Store, projects: Projects, input: any) {
  const name = typeof input?.name === "string" ? input.name.trim().slice(0, 40) : "";
  if (!name) throw new HttpError(400, "请填写工作空间名称");
  const chosen = typeof input?.cwd === "string" && input.cwd.trim() ? expand(input.cwd.trim()) : null;
  if (chosen && !isAbsolute(chosen)) throw new HttpError(400, "目录必须是绝对路径");
  const wanted: { key: string; agent?: string; model?: string }[] = Array.isArray(input?.bots) ? input.bots : WORKSPACE_TEMPLATES.filter((t) => t.on).map((t) => ({ key: t.key }));
  const team = WORKSPACE_TEMPLATES.filter((t) => t.required || wanted.some((w) => w?.key === t.key)).map((t) => {
    const w = wanted.find((x) => x?.key === t.key);
    const agent = (w?.agent ?? t.agent) as AgentKind;
    const model = w?.model ?? t.model;
    if (!validModel(agent, model)) throw new HttpError(400, `${t.name} 的模型 ${model} 不属于 ${agent}`);
    return { ...t, agent, model };
  });

  let cwd = chosen;
  if (!cwd) {
    const base = join(homedir(), "BotWorkspaces", folderName(name));
    cwd = base;
    for (let n = 2; existsSync(cwd); n++) cwd = `${base}-${n}`;
  }
  if (existsSync(cwd) && !statSync(cwd).isDirectory()) throw new HttpError(400, "这个路径已经是一个文件");
  if (store.db.prepare("SELECT 1 FROM workspaces WHERE cwd=?").get(cwd)) throw new HttpError(409, "这个目录已经是一个工作空间了");
  mkdirSync(cwd, { recursive: true });

  const notes: string[] = [];
  const inRepo = await git(cwd, ["rev-parse", "--is-inside-work-tree"]).then(() => true, () => false);
  if (!inRepo) await git(cwd, ["init", "-q"]);
  const hasCommit = await git(cwd, ["rev-parse", "HEAD"]).then(() => true, () => false);
  if (!hasCommit) {
    // Never commits what was already there: those files are the person's to decide about.
    const empty = readdirSync(cwd).every((f) => f === ".git");
    if (empty) await git(cwd, ["-c", "user.name=Bot Platform", "-c", "user.email=bot-platform@localhost", "-c", "commit.gpgsign=false", "commit", "-q", "--allow-empty", "-m", "新建工作空间"]);
    else notes.push("目录里已有文件但还没有提交。提交一次之后，才能用工作树。");
  }

  const id = randomUUID();
  store.db.prepare("INSERT INTO workspaces (id,name,cwd,created_at) VALUES (?,?,?,?)").run(id, name, cwd, Date.now());
  const bots = team.map((t) => store.createBot({ name: t.name, role: t.role, agent: t.agent, model: t.model, effort: t.effort as Effort, permission: t.permission as PermissionPreset, route: "official", cwd: cwd!, is_chief: t.key === "chief" ? 1 : 0, workspace_id: id }));
  const goal = typeof input?.goal === "string" ? input.goal : "";
  projects.saveBrief(Memory.projectId(cwd), { name, goal });
  return { id, name, cwd, bots, notes };
}
