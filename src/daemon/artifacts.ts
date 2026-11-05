import { execFile, execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { appendFileSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, extname, join, relative, resolve, sep } from "node:path";
import { HttpError } from "./errors.ts";
import type { Store } from "./store.ts";

export const MAX_UPLOAD = 50 * 1024 * 1024;
const MAX_TEXT = 1024 * 1024;
const MAX_ATTACHMENTS = 10;
const UNSENT_KEEP_MS = 24 * 3600 * 1000;
export const ATTACH_MARK = "[用户附带的文件，路径相对工作目录，需要时用工具读取]";
const ATTACH_DIR = ".bot-attachments";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS artifacts (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, path TEXT NOT NULL UNIQUE, root TEXT NOT NULL, name TEXT NOT NULL, project_cwd TEXT, conv_id TEXT, item_id TEXT,
  origin TEXT NOT NULL DEFAULT '', change TEXT NOT NULL DEFAULT '', size INTEGER NOT NULL DEFAULT 0, mtime REAL NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, fate TEXT
);
CREATE INDEX IF NOT EXISTS artifacts_project ON artifacts(project_cwd, updated_at);
`;

type Row = Record<string, any>;
// Only what a browser cannot run as a page is shown in place. Everything else is a download.
const INLINE: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp", ".pdf": "application/pdf" };
const size = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : `${Math.ceil(n / 1024)} KB`);
// Names come from a browser and end up in paths and prompts.
const safeName = (name: string) => basename(name.replace(/\\/g, "/")).replace(/[\u0000-\u001f\u007f]/g, "").replace(/^\.+/, "").trim().slice(0, 120) || "file";

export class Artifacts {
  private readonly store: Store;
  private readonly revealer: ((path: string) => Promise<void>) | undefined;

  constructor(store: Store, reveal?: (path: string) => Promise<void>) {
    this.store = store;
    this.revealer = reveal;
    store.db.exec(SCHEMA);
    if (!(store.db.prepare("PRAGMA table_info(artifacts)").all() as Row[]).some((c) => c.name === "fate")) store.db.exec("ALTER TABLE artifacts ADD COLUMN fate TEXT");
    // Picked and never sent: nothing refers to these.
    for (const r of store.db.prepare("SELECT id, root FROM artifacts WHERE kind='attachment' AND conv_id IS NULL AND created_at<?").all(Date.now() - UNSENT_KEEP_MS) as Row[]) {
      rmSync(join(r.root as string, r.id as string), { recursive: true, force: true });
      store.db.prepare("DELETE FROM artifacts WHERE id=?").run(r.id as string);
    }
  }

  get canReveal() {
    return Boolean(this.revealer) || process.platform === "darwin";
  }

  upload(rawName: string, bytes: Buffer) {
    const id = randomUUID().slice(0, 12);
    const name = safeName(rawName);
    const root = join(this.store.home, "uploads");
    const path = join(root, id, name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, bytes);
    const st = lstatSync(path);
    const now = Date.now();
    this.store.db.prepare("INSERT INTO artifacts (id,kind,path,root,name,origin,size,mtime,created_at,updated_at) VALUES (?,'attachment',?,?,?,?,?,?,?,?)").run(id, path, root, name, "你上传的", st.size, st.mtimeMs, now, now);
    return { id, name, size: st.size, preview: this.previewKind(name, st.size) };
  }

  // An agent reads files with its own tools, so a copy goes where every agent is allowed to look.
  attach(cwd: string, convId: string, ids: string[]) {
    if (!ids.length) return { footer: "", list: [] as { id: string; name: string; size: number; preview: string }[] };
    if (ids.length > MAX_ATTACHMENTS) throw new HttpError(400, `一条消息最多 ${MAX_ATTACHMENTS} 个附件`);
    const rows = ids.map((id) => {
      const r = this.store.db.prepare("SELECT * FROM artifacts WHERE id=? AND kind='attachment'").get(id) as Row | undefined;
      if (!r || !existsSync(r.path)) throw new HttpError(400, "附件已经不在了，请重新添加");
      return r;
    });
    this.keepOutOfGit(cwd);
    const lines = rows.map((r) => {
      const rel = join(ATTACH_DIR, r.id, r.name);
      mkdirSync(dirname(join(cwd, rel)), { recursive: true });
      copyFileSync(r.path, join(cwd, rel));
      this.store.db.prepare("UPDATE artifacts SET conv_id=?, project_cwd=?, updated_at=? WHERE id=?").run(convId, cwd, Date.now(), r.id);
      return `- ${rel}（${size(r.size)}）`;
    });
    return { footer: `\n\n${ATTACH_MARK}\n${lines.join("\n")}`, list: rows.map((r) => ({ id: r.id as string, name: r.name as string, size: r.size as number, preview: this.previewKind(r.name, r.size) })) };
  }

  // Into a worktree, at the same relative path the message already gave.
  copyInto(convId: string, cwd: string) {
    const rows = this.store.db.prepare("SELECT * FROM artifacts WHERE kind='attachment' AND conv_id=?").all(convId) as Row[];
    if (!rows.length) return;
    this.keepOutOfGit(cwd);
    for (const r of rows) {
      const to = join(cwd, ATTACH_DIR, r.id, r.name);
      if (existsSync(to) || !existsSync(r.path)) continue;
      mkdirSync(dirname(to), { recursive: true });
      copyFileSync(r.path, to);
    }
  }

  // Same file, new place: it keeps its record, including who made it. A row already listing that path is what the merge replaced.
  worktreeMerged(fromRoot: string, toRoot: string) {
    const db = this.store.db;
    for (const r of db.prepare("SELECT id, path FROM artifacts WHERE root=? AND kind='file'").all(fromRoot) as Row[]) {
      const path = join(toRoot, relative(fromRoot, r.path));
      let st;
      try {
        st = lstatSync(path);
      } catch {
        db.prepare("UPDATE artifacts SET fate='discarded', updated_at=? WHERE id=?").run(Date.now(), r.id);
        continue;
      }
      db.prepare("DELETE FROM artifacts WHERE path=? AND id!=?").run(path, r.id);
      db.prepare("UPDATE artifacts SET path=?, root=?, size=?, mtime=?, updated_at=? WHERE id=?").run(path, toRoot, st.size, st.mtimeMs, Date.now(), r.id);
    }
  }

  worktreeDiscarded(fromRoot: string) {
    this.store.db.prepare("UPDATE artifacts SET fate='discarded', updated_at=? WHERE root=? AND kind='file'").run(Date.now(), fromRoot);
  }

  // Otherwise an attachment would be reported as something the Bot changed. This file is local to the clone and is never committed.
  private keepOutOfGit(cwd: string) {
    try {
      const file = resolve(cwd, execFileSync("git", ["rev-parse", "--git-path", "info/exclude"], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], timeout: 10000 }).trim());
      const current = existsSync(file) ? readFileSync(file, "utf8") : "";
      if (current.split("\n").includes(`${ATTACH_DIR}/`)) return;
      mkdirSync(dirname(file), { recursive: true });
      appendFileSync(file, `${current && !current.endsWith("\n") ? "\n" : ""}${ATTACH_DIR}/\n`);
    } catch {
      // Not a repository.
    }
  }

  // The same file touched again points at the latest round: the list is of files, not of edits.
  record(rows: { path: string; root: string; change: string; origin: string; convId: string; itemId: string | null; cwd: string }[]) {
    const now = Date.now();
    for (const r of rows) {
      let st;
      try {
        st = lstatSync(r.path);
      } catch {
        continue;
      }
      if (!st.isFile()) continue;
      this.store.db
        .prepare(
          `INSERT INTO artifacts (id,kind,path,root,name,project_cwd,conv_id,item_id,origin,change,size,mtime,created_at,updated_at) VALUES (?,'file',?,?,?,?,?,?,?,?,?,?,?,?)
           ON CONFLICT(path) DO UPDATE SET fate=NULL, conv_id=excluded.conv_id, item_id=excluded.item_id, origin=excluded.origin, change=excluded.change, size=excluded.size, mtime=excluded.mtime, updated_at=excluded.updated_at`,
        )
        .run(randomUUID().slice(0, 12), r.path, r.root, basename(r.path), r.cwd, r.convId, r.itemId, r.origin, r.change, st.size, st.mtimeMs, now, now);
    }
  }

  private previewKind(name: string, bytes: number) {
    const ext = extname(name).toLowerCase();
    if (INLINE[ext]) return INLINE[ext].startsWith("image/") ? "image" : "pdf";
    return bytes <= MAX_TEXT ? "text" : "none";
  }

  list(q: { cwd: string; convId?: string; kind?: string }) {
    const where = ["a.project_cwd=?"];
    const args: string[] = [q.cwd];
    if (q.convId) (where.push("a.conv_id=?"), args.push(q.convId));
    if (q.kind) (where.push("a.kind=?"), args.push(q.kind));
    const rows = this.store.db
      .prepare(`SELECT a.*, c.title conv_title, c.bot_id, c.group_id FROM artifacts a LEFT JOIN conversations c ON c.id=a.conv_id WHERE ${where.join(" AND ")} ORDER BY a.updated_at DESC LIMIT 300`)
      .all(...args) as Row[];
    return rows.map((r) => {
      let state = r.fate === "discarded" ? "discarded" : "gone";
      let bytes = r.size as number;
      if (state === "gone") {
        try {
          const st = lstatSync(r.path);
          bytes = st.size;
          state = st.size === r.size && st.mtimeMs === r.mtime ? "same" : "changed";
        } catch {}
      }
      const gone = state === "gone" || state === "discarded";
      return { id: r.id, kind: r.kind, name: r.name, rel: relative(r.root, r.path), origin: r.origin, change: r.change, size: bytes, state, preview: gone ? "none" : this.previewKind(r.name, bytes), at: r.updated_at, conv_id: r.conv_id, conv_title: r.conv_title, item_id: r.item_id, bot_id: r.bot_id, group_id: r.group_id };
    });
  }

  // The path was recorded earlier and anything may have happened to it since, so it has to still be a plain file where it was.
  private locate(id: string) {
    const r = this.store.db.prepare("SELECT * FROM artifacts WHERE id=?").get(id) as Row | undefined;
    if (!r) throw new HttpError(404, "没有这个文件");
    if (r.fate === "discarded") throw new HttpError(410, "这个文件已随工作树丢弃");
    let st;
    try {
      st = lstatSync(r.path);
    } catch {
      throw new HttpError(404, "文件已经不在了");
    }
    if (!st.isFile()) throw new HttpError(403, "不能访问这个路径");
    const real = realpathSync(r.path);
    if (!real.startsWith(realpathSync(r.root) + sep)) throw new HttpError(403, "不能访问这个路径");
    return { row: r, real, bytes: st.size };
  }

  file(id: string, download: boolean) {
    const { row, real } = this.locate(id);
    const inline = !download ? INLINE[extname(row.name).toLowerCase()] : undefined;
    return { path: real, name: row.name as string, type: inline ?? "application/octet-stream", inline: Boolean(inline) };
  }

  text(id: string) {
    const { row, real, bytes } = this.locate(id);
    if (bytes > MAX_TEXT) throw new HttpError(413, "文件太大，请下载后查看");
    const buf = readFileSync(real);
    if (buf.includes(0)) throw new HttpError(415, "这不是文本文件，请下载后查看");
    return { name: row.name, text: buf.toString("utf8"), markdown: /\.(md|markdown)$/i.test(row.name) };
  }

  async reveal(id: string) {
    const { real } = this.locate(id);
    if (this.revealer) return this.revealer(real);
    if (process.platform !== "darwin") throw new HttpError(501, "目前只支持 macOS");
    // No shell, and -R only selects the file: it does not open or run it.
    await new Promise<void>((res, rej) => execFile("/usr/bin/open", ["-R", real], { timeout: 10000 }, (e) => (e ? rej(new HttpError(500, "打不开访达")) : res())));
  }
}
