import { execFile } from "node:child_process";
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { ATTACH_MARK } from "./artifacts.ts";
import { HttpError } from "./errors.ts";
import { Memory } from "./git.ts";
import type { Projects } from "./projects.ts";
import type { Research } from "./research.ts";
import type { Store } from "./store.ts";
import type { Conversation, Item } from "./types.ts";

const MAX_COPIED = 500 * 1024 * 1024;
type Row = Record<string, any>;
export type Pack = { path: string; name: string; dir: string };

// A title may hold anything, and it becomes a file name inside and outside the archive.
const fileName = (s: string) => s.replace(/[\u0000-\u001f\u007f/\\:*?"<>|]/g, " ").replace(/\s+/g, " ").replace(/^\.+/, "").trim().slice(0, 60) || "未命名";
const stamp = (at: number) => new Date(at).toLocaleString("zh-CN", { hour12: false });
const dateTag = () => new Date().toISOString().slice(0, 10);

function folderSize(dir: string): number {
  let total = 0;
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = lstatSync(p);
    total += st.isDirectory() ? folderSize(p) : st.isFile() ? st.size : 0;
  }
  return total;
}

function itemMarkdown(i: Item, speaker: string): string | null {
  const d = i.data as Row;
  const when = stamp(i.created_at);
  switch (i.type) {
    case "user": {
      const text = d.attachments ? String(d.text).split(ATTACH_MARK)[0].trim() : d.text;
      const files = d.attachments ? `\n\n附件：${d.attachments.map((a: Row) => a.name).join("、")}` : "";
      return `## 你${d.steered ? "（运行中补充）" : ""} · ${when}\n\n${text}${files}`;
    }
    case "assistant":
      return d.text ? `## ${d.bot?.name ?? speaker} · ${when}\n\n${d.text}${i.status === "interrupted" ? "\n\n（这段回复被中断了）" : ""}` : null;
    case "tool":
      return i.status === "hidden" ? null : `- 工具：${d.title}（${i.status}）`;
    case "approval":
      if (d.kind === "plan") return `> 计划（${i.status}）：${d.title}\n${(d.tasks as Row[]).map((t, n) => `> ${n + 1}. ${t.bot}：${String(t.task).split("\n")[0]}${t.acceptance ? `（验收：${t.acceptance}）` : ""}`).join("\n")}${d.feedback ? `\n> 你的意见：${d.feedback}` : ""}`;
      return `> 审批（${i.status}）：${d.from ? `${d.from}：` : ""}${d.title}`;
    case "call":
      return `### ${d.from} → ${d.to}（${i.status}）\n\n**${d.mode === "task" ? "任务" : "问题"}**\n\n${d.question}${d.answer ? `\n\n**回答**\n\n${d.answer}` : ""}`;
    case "job":
      return `> 实验：${d.name}（${i.status}）${d.metrics ? ` ${JSON.stringify(d.metrics)}` : ""}`;
    case "notice":
      return `> 平台通知：${d.text}`;
    case "error":
      return `> 错误：${d.message}`;
    case "result": {
      const files = (d.files as Row[]).map((f) => `- ${f.change}：${f.path}`).join("\n");
      const checks = (d.checks as Row[]).map((c) => `- 检查（${c.status}）：\`${c.command}\``).join("\n");
      return [`### 这一轮的结果（${i.status}）`, d.summary ? `Bot 自述：${d.summary}` : "", files, checks, d.accepted ? "你已接受。" : d.review === "dismissed" ? "你标记为无需验收。" : ""].filter(Boolean).join("\n\n");
    }
    case "comparison": {
      const answers = (d.answers as Row[]).map((a) => `#### ${a.bot}（${a.model}，${a.status}）\n\n${a.text || a.reason || "（没有回答）"}`).join("\n\n");
      const s = d.synthesis as Row | null;
      const summary = !s ? "" : s.raw ? `#### 归纳（${d.summarizer}，模型生成，未经核实）\n\n${s.raw}` : `#### 归纳（${d.summarizer}，模型生成，未经核实）\n\n${JSON.stringify({ 一致: s.consensus, 分歧: s.disagreements, 缺失: s.gaps }, null, 2)}`;
      return [`### 独立比较（${i.status}）：${d.question}`, answers, summary].filter(Boolean).join("\n\n");
    }
    default:
      return null;
  }
}

// Everything here is the person's own data going to the person. The working directory is not included: that is what Git is for.
export class Exporter {
  private readonly store: Store;
  private readonly memory: Memory;
  private readonly research: Research;
  private readonly projects: Projects;

  constructor(o: { store: Store; memory: Memory; research: Research; projects: Projects }) {
    this.store = o.store;
    this.memory = o.memory;
    this.research = o.research;
    this.projects = o.projects;
  }

  conversationMarkdown(id: string) {
    const conv = this.store.getConversation(id);
    if (!conv || (conv.kind !== "direct" && conv.kind !== "group")) throw new HttpError(404, "对话不存在");
    return { name: `${fileName(conv.title)}.md`, text: this.markdown(conv) };
  }

  private markdown(conv: Conversation) {
    // Read directly: a backup includes conversations whose Bot or group has been archived.
    const bot = conv.bot_id ? (this.store.db.prepare("SELECT name FROM bots WHERE id=?").get(conv.bot_id) as Row | undefined) : undefined;
    const group = conv.group_id ? (this.store.db.prepare("SELECT name FROM groups WHERE id=?").get(conv.group_id) as Row | undefined) : undefined;
    const body = this.store.listItems(conv.id).map((i) => itemMarkdown(i, bot?.name ?? "Bot")).filter(Boolean);
    return [`# ${conv.title}`, [group ? `群聊：${group.name}` : `Bot：${bot?.name ?? "（已不在）"}`, `工作目录：${conv.cwd}`, `导出时间：${stamp(Date.now())}`].join("\n\n"), ...body].join("\n\n") + "\n";
  }

  private async tar(dir: string, folder: string, name: string): Promise<Pack> {
    const path = join(dir, `${folder}.tar.gz`);
    // Links are stored as links, so a link in a run's results cannot pull in a file from elsewhere.
    await new Promise<void>((res, rej) => execFile("tar", ["-czf", path, "-C", dir, "--", folder], { timeout: 600000 }, (e) => (e ? rej(new HttpError(500, `打包失败：${e.message}`)) : res())));
    return { path, name, dir };
  }

  private writeExperiment(id: string, into: string) {
    const e = this.research.getExperiment(id);
    if (!e) throw new HttpError(404, "没有这个实验");
    const run = this.research.runDir(id);
    mkdirSync(into, { recursive: true });
    const skipped: string[] = [];
    for (const f of ["config.json", "code.diff", "code.json", "log.txt", "metrics.json"]) if (existsSync(join(run, f))) cpSync(join(run, f), join(into, f));
    const artifacts = join(run, "artifacts");
    if (existsSync(artifacts)) {
      if (folderSize(artifacts) <= MAX_COPIED) cpSync(artifacts, join(into, "artifacts"), { recursive: true, verbatimSymlinks: true });
      else skipped.push("artifacts（超过 500 MB，请到数据目录复制）");
    }
    // Every look at the test set, including the ones the page no longer shows.
    const finals = join(run, "final");
    if (existsSync(finals)) cpSync(finals, join(into, "final"), { recursive: true, verbatimSymlinks: true });
    const howTo = e.commit_hash ? (e.dirty ? `git checkout ${e.commit_hash} && git apply code.diff` : `git checkout ${e.commit_hash}`) : "这次运行不在 Git 仓库里，没有记录代码版本";
    writeFileSync(join(into, "experiment.json"), JSON.stringify({ ...e, restore_code: howTo, snapshot_complete: e.dirty ? Boolean(e.code_complete) : true, skipped }, null, 2));
    return e;
  }

  async experimentPack(id: string): Promise<Pack> {
    const dir = mkdtempSync(join(tmpdir(), "bot-export-"));
    try {
      const folder = `实验-${id}`;
      const e = this.writeExperiment(id, join(dir, folder));
      writeFileSync(join(dir, folder, "说明.txt"), "experiment.json 是这次运行的完整记录，restore_code 写了怎么还原代码。\nsnapshot_complete 为 false 时，有文件太大没进 code.diff，只记了大小和哈希，见 code.json。\nfinal/ 里是测试集评估，test_metrics 也在 experiment.json 里。分享这个包前请想清楚要不要带上它们。\n");
      return await this.tar(dir, folder, `${fileName(e.name)}-${id}.tar.gz`);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  // A copy to read and keep. It cannot be imported back; the database backup is what restores.
  async projectBackup(cwd: string): Promise<Pack> {
    const id = Memory.projectId(cwd);
    const dir = mkdtempSync(join(tmpdir(), "bot-export-"));
    try {
      const folder = `项目备份-${dateTag()}`;
      const root = join(dir, folder);
      mkdirSync(root, { recursive: true });
      const db = this.store.db;
      const bots = db.prepare("SELECT name, role, agent, model, effort, permission, route, budget_tokens, can_call, is_chief, paused, archived FROM bots WHERE cwd=?").all(cwd) as Row[];
      const groups = db.prepare("SELECT name, budget_tokens, archived FROM groups WHERE cwd=?").all(cwd) as Row[];
      const info = this.projects.brief(id);
      writeFileSync(join(root, "project.json"), JSON.stringify({ cwd, brief: info, settings: this.research.settings(id), bots, groups, exported_at: new Date().toISOString() }, null, 2));

      const convs = db.prepare("SELECT * FROM conversations WHERE cwd=? AND kind IN ('direct','group') ORDER BY created_at").all(cwd) as unknown as Conversation[];
      mkdirSync(join(root, "conversations"));
      for (const c of convs) {
        const base = `${fileName(c.title)}-${c.id.slice(0, 8)}${c.archived ? "-已归档" : ""}`;
        writeFileSync(join(root, "conversations", `${base}.md`), this.markdown(c));
        writeFileSync(join(root, "conversations", `${base}.json`), JSON.stringify(this.store.listItems(c.id), null, 2));
      }
      const calls = db.prepare("SELECT k.* FROM calls k JOIN conversations c ON c.id=k.root_conv_id WHERE c.cwd=? ORDER BY k.created_at").all(cwd) as Row[];
      writeFileSync(join(root, "tasks.json"), JSON.stringify(calls, null, 2));

      mkdirSync(join(root, "memory"));
      writeFileSync(join(root, "memory", "项目记忆.md"), this.memory.read("project", id));
      for (const b of db.prepare("SELECT id, name FROM bots WHERE cwd=?").all(cwd) as Row[]) writeFileSync(join(root, "memory", `${fileName(b.name)}.md`), this.memory.read("bot", b.id));

      const skipped: string[] = [];
      const resultFiles = (db.prepare("SELECT i.id FROM items i JOIN conversations c ON c.id=i.conv_id WHERE c.cwd=? AND i.type='result'").all(cwd) as Row[]).map((r) => join(this.store.home, "results", `${r.id}.json`)).filter(existsSync);
      if (resultFiles.length) {
        mkdirSync(join(root, "results"));
        for (const f of resultFiles) cpSync(f, join(root, "results", basename(f)));
      }
      let room = MAX_COPIED;
      const uploads = db.prepare("SELECT id, name, path, size FROM artifacts WHERE project_cwd=? AND kind='attachment'").all(cwd) as Row[];
      for (const a of uploads) {
        if (!existsSync(a.path)) continue;
        if (a.size > room) {
          skipped.push(`附件 ${a.name}`);
          continue;
        }
        room -= a.size;
        mkdirSync(join(root, "attachments", a.id), { recursive: true });
        cpSync(a.path, join(root, "attachments", a.id, a.name));
      }
      for (const e of this.research.listExperiments(id)) {
        const size = existsSync(join(this.research.runDir(e.id), "artifacts")) ? folderSize(join(this.research.runDir(e.id), "artifacts")) : 0;
        if (size > room) skipped.push(`实验 ${e.name} 的结果文件`);
        else room -= size;
        this.writeExperiment(e.id, join(root, "experiments", e.id));
      }
      writeFileSync(join(root, "说明.txt"), `这是工作目录 ${cwd} 的记录备份，用来查阅和留存。\n\n没有包含工作目录本身：代码请用 Git 备份，Bot 改过的文件也在那里。\n不能导入回平台。要整体恢复，请用设置里的“下载数据库”。\nexperiments/ 里有测试集评估结果，分享前请想清楚。\n${skipped.length ? `\n太大没有复制：\n${skipped.map((s) => `- ${s}`).join("\n")}\n` : ""}`);
      return await this.tar(dir, folder, `${fileName(info.name || cwd.split("/").filter(Boolean).slice(-1)[0] || "项目")}-备份-${dateTag()}.tar.gz`);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw err;
    }
  }

  // A consistent copy, even while the daemon is writing.
  databaseBackup(): Pack {
    const dir = mkdtempSync(join(tmpdir(), "bot-export-"));
    const path = join(dir, "platform.db");
    try {
      this.store.db.prepare("VACUUM INTO ?").run(path);
    } catch (err) {
      rmSync(dir, { recursive: true, force: true });
      throw new HttpError(500, `备份失败：${(err as Error).message}`);
    }
    return { path, name: `platform-${dateTag()}.db`, dir };
  }
}
