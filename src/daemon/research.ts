import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, realpathSync, statSync, writeFileSync } from "node:fs";
import { extname, isAbsolute, join, resolve, sep } from "node:path";
import { agentEnv } from "./adapters/process.ts";
import { HttpError } from "./errors.ts";
import { git } from "./git.ts";
import type { Store } from "./store.ts";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS ideas (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, title TEXT NOT NULL, hypothesis TEXT NOT NULL DEFAULT '', source TEXT NOT NULL DEFAULT '',
  prior_work TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'proposed', suggested_verdict TEXT, conclusion TEXT NOT NULL DEFAULT '',
  failure_reason TEXT NOT NULL DEFAULT '', created_by TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS experiments (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, idea_id TEXT, name TEXT NOT NULL, role TEXT NOT NULL, command TEXT NOT NULL, config TEXT NOT NULL,
  seed INTEGER, target TEXT NOT NULL, cwd TEXT NOT NULL, commit_hash TEXT, dirty INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, metrics TEXT,
  test_metrics TEXT, final_status TEXT, root_conv_id TEXT, bot_name TEXT NOT NULL, item_id TEXT, created_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS jobs (
  id TEXT PRIMARY KEY, experiment_id TEXT NOT NULL, kind TEXT NOT NULL, target TEXT NOT NULL, dir TEXT NOT NULL, remote_dir TEXT, pid INTEGER,
  status TEXT NOT NULL, exit_code INTEGER, started_at INTEGER NOT NULL, ended_at INTEGER
);
CREATE TABLE IF NOT EXISTS targets (name TEXT PRIMARY KEY, ssh_host TEXT NOT NULL, remote_root TEXT NOT NULL, setup TEXT NOT NULL DEFAULT '');
CREATE TABLE IF NOT EXISTS project_settings (project_id TEXT PRIMARY KEY, test_dir TEXT NOT NULL DEFAULT '', final_eval_command TEXT NOT NULL DEFAULT '', auto_wake INTEGER NOT NULL DEFAULT 1, enabled INTEGER NOT NULL DEFAULT 0);
`;

type Row = Record<string, any>;
const IDEA_STATUS = ["proposed", "testing", "rejected", "parked"];
const VERDICTS = ["supported", "not_supported"];
const IMAGE_TYPES: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".webp": "image/webp" };
const sh = (s: string) => `'${s.replace(/'/g, `'\\''`)}'`;
const textArg = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");

const run = (cmd: string, args: string[], timeout = 120000) =>
  new Promise<string>((res, rej) => {
    execFile(cmd, args, { env: agentEnv(), maxBuffer: 8 * 1024 * 1024, timeout }, (e, out, err) => (e ? rej(new Error(String(err || e.message).trim().slice(0, 400))) : res(out)));
  });

function bigrams(s: string) {
  const t = s.toLowerCase().replace(/\s+/g, "");
  const out = new Set<string>();
  for (let i = 0; i < t.length - 1; i++) out.add(t.slice(i, i + 2));
  return out;
}
const similarity = (a: string, b: string) => {
  const x = bigrams(a);
  const y = bigrams(b);
  if (!x.size || !y.size) return 0;
  let n = 0;
  for (const g of x) if (y.has(g)) n++;
  return (2 * n) / (x.size + y.size);
};

// Metrics come from a file the script wrote; a model's prose never becomes a number here.
function readMetrics(file: string): Record<string, number> | null {
  if (!existsSync(file)) return null;
  try {
    const raw = JSON.parse(readFileSync(file, "utf8"));
    const out: Record<string, number> = {};
    for (const [k, v] of Object.entries(raw).slice(0, 50)) if (typeof v === "number" && Number.isFinite(v)) out[k.slice(0, 60)] = v;
    return out;
  } catch {
    return null;
  }
}

export function summarize(exps: Row[]) {
  const groups = new Map<string, Row[]>();
  for (const e of exps) if (e.status === "done" && e.metrics) groups.set(e.name, [...(groups.get(e.name) ?? []), e]);
  return [...groups].map(([name, list]) => {
    const metrics: Record<string, { mean: number; std: number; n: number }> = {};
    const keys = new Set(list.flatMap((e) => Object.keys(e.metrics)));
    for (const k of keys) {
      const v = list.map((e) => e.metrics[k]).filter((x) => typeof x === "number");
      const mean = v.reduce((a, b) => a + b, 0) / v.length;
      const std = v.length > 1 ? Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1)) : 0;
      metrics[k] = { mean, std, n: v.length };
    }
    return { name, role: list[0].role, idea_id: list[0].idea_id, runs: list.length, metrics };
  });
}

export interface RunRequest {
  projectId: string;
  ideaId: string | null;
  name: string;
  role: string;
  command: string;
  config: unknown;
  seed: number | null;
  target: string;
  cwd: string;
}

export class Research {
  private readonly store: Store;
  private readonly db: Store["db"];
  private readonly broadcast: (e: { type: string; [k: string]: unknown }) => void;
  private readonly onFinished: (exp: Row) => void;
  private readonly timer: NodeJS.Timeout;
  private readonly sshPollMs: number;
  private readonly lastSshPoll = new Map<string, number>();
  private polling = false;

  constructor(o: { store: Store; broadcast: (e: { type: string; [k: string]: unknown }) => void; onFinished: (exp: Row) => void; pollMs?: number; sshPollMs?: number }) {
    this.store = o.store;
    this.db = o.store.db;
    this.broadcast = o.broadcast;
    this.onFinished = o.onFinished;
    this.sshPollMs = o.sshPollMs ?? 30000;
    this.db.exec(SCHEMA);
    this.timer = setInterval(() => void this.poll(), o.pollMs ?? 2000);
    this.timer.unref();
  }

  stop() {
    clearInterval(this.timer);
  }

  private notify(projectId: string) {
    this.broadcast({ type: "research", projectId });
  }

  // ---------- ideas ----------
  listIdeas(projectId: string) {
    return this.db.prepare("SELECT * FROM ideas WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Row[];
  }

  addIdea(projectId: string, a: any, by: string) {
    const title = textArg(a?.title, 200);
    if (!title) throw new HttpError(400, "想法需要标题");
    const id = randomUUID().slice(0, 8);
    const now = Date.now();
    const similar = this.listIdeas(projectId).filter((i) => similarity(i.title, title) >= 0.5);
    this.db
      .prepare("INSERT INTO ideas (id,project_id,title,hypothesis,source,prior_work,created_by,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run(id, projectId, title, textArg(a?.hypothesis, 4000), textArg(a?.source, 1000), textArg(a?.prior_work, 8000), by, now, now);
    this.notify(projectId);
    return { id, similar: similar.map((i) => ({ id: i.id, title: i.title, status: i.status, conclusion: i.conclusion, failure_reason: i.failure_reason })) };
  }

  // Bots may suggest a verdict. Whether an idea really holds up is the user's call.
  updateIdea(id: string, a: any, byUser: boolean) {
    const cur = this.db.prepare("SELECT * FROM ideas WHERE id=?").get(id) as Row | undefined;
    if (!cur) throw new HttpError(404, "没有这个想法");
    const next = { ...cur };
    for (const [k, n] of [["hypothesis", 4000], ["prior_work", 8000], ["conclusion", 8000], ["failure_reason", 4000]] as const) if (a?.[k] !== undefined) next[k] = textArg(a[k], n);
    if (a?.status !== undefined) {
      const allowed = byUser ? [...IDEA_STATUS, ...VERDICTS] : IDEA_STATUS;
      if (!allowed.includes(a.status)) throw new HttpError(400, byUser ? "状态无效" : "结论由用户确认，请用 suggested_verdict 提出建议");
      next.status = a.status;
      if (byUser && VERDICTS.includes(a.status)) next.suggested_verdict = null;
    }
    if (a?.suggested_verdict !== undefined) {
      if (a.suggested_verdict !== null && !VERDICTS.includes(a.suggested_verdict)) throw new HttpError(400, "suggested_verdict 无效");
      next.suggested_verdict = a.suggested_verdict;
    }
    this.db.prepare("UPDATE ideas SET hypothesis=?,prior_work=?,conclusion=?,failure_reason=?,status=?,suggested_verdict=?,updated_at=? WHERE id=?").run(next.hypothesis, next.prior_work, next.conclusion, next.failure_reason, next.status, next.suggested_verdict, Date.now(), id);
    this.notify(cur.project_id);
    return next;
  }

  // ---------- settings ----------
  settings(projectId: string) {
    return (this.db.prepare("SELECT * FROM project_settings WHERE project_id=?").get(projectId) as Row | undefined) ?? { project_id: projectId, test_dir: "", final_eval_command: "", auto_wake: 1, enabled: 0 };
  }

  saveSettings(projectId: string, a: any) {
    const cur = this.settings(projectId);
    const testDir = a?.test_dir === undefined ? cur.test_dir : textArg(a.test_dir, 1024);
    if (testDir && !isAbsolute(testDir)) throw new HttpError(400, "测试集路径必须是绝对路径");
    const cmd = a?.final_eval_command === undefined ? cur.final_eval_command : textArg(a.final_eval_command, 4000);
    const wake = a?.auto_wake === undefined ? cur.auto_wake : a.auto_wake ? 1 : 0;
    const enabled = a?.enabled === undefined ? cur.enabled : a.enabled ? 1 : 0;
    this.db.prepare("INSERT OR REPLACE INTO project_settings (project_id,test_dir,final_eval_command,auto_wake,enabled) VALUES (?,?,?,?,?)").run(projectId, testDir, cmd, wake, enabled);
    this.notify(projectId);
    return this.settings(projectId);
  }

  listTargets() {
    return this.db.prepare("SELECT * FROM targets ORDER BY name").all() as Row[];
  }

  saveTarget(a: any) {
    const name = textArg(a?.name, 40);
    const host = textArg(a?.ssh_host, 200);
    const root = textArg(a?.remote_root, 500);
    if (!/^[A-Za-z0-9][\w.-]*$/.test(name) || name === "local") throw new HttpError(400, "名称只能用字母、数字、点和横线，且不能叫 local");
    // Passed to ssh as an argument, so it must not be able to read as an option.
    if (!/^[A-Za-z0-9][\w.@-]*$/.test(host)) throw new HttpError(400, "SSH 主机名无效，请使用 ~/.ssh/config 里的名字");
    if (!/^\/[\w./-]+$/.test(root)) throw new HttpError(400, "远程目录必须是绝对路径，且不含空格和特殊字符");
    this.db.prepare("INSERT OR REPLACE INTO targets (name,ssh_host,remote_root,setup) VALUES (?,?,?,?)").run(name, host, root.replace(/\/+$/, ""), textArg(a?.setup, 2000));
    return this.listTargets();
  }

  deleteTarget(name: string) {
    this.db.prepare("DELETE FROM targets WHERE name=?").run(name);
  }

  // ---------- experiments ----------
  private hydrate(e: Row) {
    return { ...e, config: e.config ? JSON.parse(e.config) : null, metrics: e.metrics ? JSON.parse(e.metrics) : null, test_metrics: e.test_metrics ? JSON.parse(e.test_metrics) : null };
  }

  listExperiments(projectId: string, ideaId?: string) {
    const rows = this.db.prepare("SELECT * FROM experiments WHERE project_id=? ORDER BY created_at DESC").all(projectId) as Row[];
    return rows.filter((e) => !ideaId || e.idea_id === ideaId).map((e) => this.hydrate(e));
  }

  getExperiment(id: string) {
    const e = this.db.prepare("SELECT * FROM experiments WHERE id=?").get(id) as Row | undefined;
    return e ? this.hydrate(e) : undefined;
  }

  // What agents may see. Test results must never feed back into the iteration loop.
  forBots(e: Row) {
    const { test_metrics, final_status, ...rest } = e;
    void test_metrics;
    void final_status;
    return rest;
  }

  private guardTestSet(projectId: string, ...texts: string[]) {
    const dir = this.settings(projectId).test_dir;
    if (dir && texts.some((t) => t.includes(dir))) throw new HttpError(403, "命令或配置碰到了测试集。测试集只能由用户在研究页发起最终评估");
  }

  prepare(projectId: string, cwd: string, a: any): RunRequest {
    const name = textArg(a?.name, 120);
    const command = textArg(a?.command, 8000);
    if (!name || !command) throw new HttpError(400, "需要 name 和 command");
    const target = textArg(a?.target, 40) || "local";
    if (target !== "local" && !this.listTargets().some((t) => t.name === target)) throw new HttpError(400, `没有计算目标 ${target}。可用：local${this.listTargets().map((t) => `、${t.name}`).join("")}`);
    const seed = a?.seed === undefined || a.seed === null ? null : Number(a.seed);
    if (seed !== null && !Number.isInteger(seed)) throw new HttpError(400, "seed 必须是整数");
    const ideaId = textArg(a?.idea_id, 40) || null;
    if (ideaId && !(this.db.prepare("SELECT 1 FROM ideas WHERE id=? AND project_id=?").get(ideaId, projectId))) throw new HttpError(400, `没有想法 ${ideaId}`);
    const role = ["baseline", "variant", "ablation"].includes(a?.role) ? a.role : "variant";
    const config = a?.config ?? {};
    this.guardTestSet(projectId, command, JSON.stringify(config));
    return { projectId, ideaId, name, role, command, config, seed, target, cwd };
  }

  describe(r: RunRequest) {
    return [`命令：${r.command}`, `运行位置：${r.target}`, `工作目录：${r.cwd}`, `随机种子：${r.seed ?? "未设置"}`, `配置：${JSON.stringify(r.config)}`].join("\n");
  }

  async start(r: RunRequest, by: { rootConvId: string; botName: string }) {
    const id = randomUUID().slice(0, 8);
    const dir = join(this.store.home, "runs", id);
    mkdirSync(join(dir, "artifacts"), { recursive: true });
    writeFileSync(join(dir, "config.json"), JSON.stringify(r.config, null, 2));
    const code = await this.codeVersion(r.cwd, dir);
    this.db
      .prepare("INSERT INTO experiments (id,project_id,idea_id,name,role,command,config,seed,target,cwd,commit_hash,dirty,status,root_conv_id,bot_name,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,'running',?,?,?)")
      .run(id, r.projectId, r.ideaId, r.name, r.role, r.command, JSON.stringify(r.config), r.seed, r.target, r.cwd, code.commit, code.dirty ? 1 : 0, by.rootConvId, by.botName, Date.now());
    if (r.ideaId) this.db.prepare("UPDATE ideas SET status='testing', updated_at=? WHERE id=? AND status='proposed'").run(Date.now(), r.ideaId);
    try {
      await this.launch(id, "train", r.target, r.cwd, r.command, dir, { BOT_SEED: r.seed === null ? "" : String(r.seed) });
    } catch (e) {
      this.db.prepare("UPDATE experiments SET status='failed', ended_at=? WHERE id=?").run(Date.now(), id);
      this.notify(r.projectId);
      throw new HttpError(500, `启动失败：${(e as Error).message}`);
    }
    this.notify(r.projectId);
    return this.getExperiment(id)!;
  }

  // The commit alone cannot reproduce a run made on uncommitted work, so the diff is kept with it.
  private async codeVersion(cwd: string, dir: string) {
    try {
      const commit = (await git(cwd, ["rev-parse", "HEAD"])).trim();
      const dirty = Boolean((await git(cwd, ["status", "--porcelain"])).trim());
      if (dirty) writeFileSync(join(dir, "code.diff"), (await git(cwd, ["diff", "HEAD"])).slice(0, 5_000_000));
      return { commit, dirty };
    } catch {
      return { commit: null, dirty: false };
    }
  }

  setItem(id: string, itemId: string) {
    this.db.prepare("UPDATE experiments SET item_id=? WHERE id=?").run(itemId, id);
  }

  async finalEval(id: string) {
    const e = this.getExperiment(id);
    if (!e) throw new HttpError(404, "没有这个实验");
    if (e.status !== "done") throw new HttpError(409, "实验完成后才能做最终评估");
    if (e.final_status === "running") throw new HttpError(409, "最终评估正在进行");
    const s = this.settings(e.project_id);
    if (!s.final_eval_command) throw new HttpError(400, "请先在设置里填写最终评估命令");
    const dir = join(this.store.home, "runs", id);
    const finalDir = join(dir, "final");
    mkdirSync(finalDir, { recursive: true });
    const cwd = existsSync(e.cwd) ? e.cwd : dir;
    await this.launch(id, "final", e.target, cwd, s.final_eval_command, finalDir, { BOT_TEST_DIR: s.test_dir, BOT_TRAIN_RUN_DIR: dir, BOT_CONFIG_FILE: join(dir, "config.json"), BOT_SEED: e.seed === null ? "" : String(e.seed) });
    this.db.prepare("UPDATE experiments SET final_status='running' WHERE id=?").run(id);
    this.notify(e.project_id);
  }

  finalEvalCount(projectId: string) {
    return Number((this.db.prepare("SELECT COUNT(*) n FROM jobs j JOIN experiments e ON e.id=j.experiment_id WHERE e.project_id=? AND j.kind='final'").get(projectId) as Row).n);
  }

  jobRunningIn(path: string) {
    return Boolean(this.db.prepare("SELECT 1 FROM jobs j JOIN experiments e ON e.id=j.experiment_id WHERE j.status='running' AND (e.cwd=? OR e.cwd LIKE ?)").get(path, `${path}${sep}%`));
  }

  // ---------- running jobs ----------
  private async launch(expId: string, kind: string, target: string, cwd: string, command: string, dir: string, extra: Record<string, string>) {
    const jobId = randomUUID();
    const vars = { BOT_RUN_DIR: dir, BOT_METRICS_FILE: join(dir, "metrics.json"), BOT_ARTIFACTS_DIR: join(dir, "artifacts"), BOT_CONFIG_FILE: join(dir, "config.json"), ...extra };
    if (target === "local") {
      if (!existsSync(cwd)) throw new Error(`工作目录不存在：${cwd}`);
      const script = `( ${command}\n) > "$BOT_RUN_DIR/log.txt" 2>&1; echo $? > "$BOT_RUN_DIR/exit.tmp"; mv "$BOT_RUN_DIR/exit.tmp" "$BOT_RUN_DIR/exit"`;
      // Detached, so a daemon restart or an agent's exit does not take the training with it.
      const child = spawn("/bin/sh", ["-c", script], { cwd, detached: true, stdio: "ignore", env: { ...agentEnv(), ...vars } });
      const pid = await new Promise<number>((res, rej) => {
        child.once("spawn", () => res(child.pid!));
        child.once("error", rej);
      });
      child.unref();
      this.db.prepare("INSERT INTO jobs (id,experiment_id,kind,target,dir,pid,status,started_at) VALUES (?,?,?,?,?,?,'running',?)").run(jobId, expId, kind, target, dir, pid, Date.now());
      return;
    }
    const t = this.listTargets().find((x) => x.name === target);
    if (!t) throw new Error(`没有计算目标 ${target}`);
    const remote = `${t.remote_root}/runs/${expId}/${kind}`;
    const code = `${t.remote_root}/runs/${expId}/code`;
    await run(this.ssh(), [t.ssh_host, `mkdir -p ${sh(`${remote}/artifacts`)} ${sh(code)}`]);
    // Respects .gitignore so datasets and checkpoints in the repository are not copied on every run.
    await run(this.rsync(), ["-az", "--delete", "--exclude", ".git", "--filter", ":- .gitignore", `${cwd}/`, `${t.ssh_host}:${code}/`], 600000);
    if (existsSync(join(dir, "config.json"))) await run(this.rsync(), ["-az", join(dir, "config.json"), `${t.ssh_host}:${remote}/config.json`]);
    const exports = Object.entries({ ...vars, BOT_RUN_DIR: remote, BOT_METRICS_FILE: `${remote}/metrics.json`, BOT_ARTIFACTS_DIR: `${remote}/artifacts`, BOT_CONFIG_FILE: `${remote}/config.json`, ...(extra.BOT_TRAIN_RUN_DIR ? { BOT_TRAIN_RUN_DIR: `${t.remote_root}/runs/${expId}/train`, BOT_CONFIG_FILE: `${t.remote_root}/runs/${expId}/train/config.json` } : {}) })
      .map(([k, v]) => `export ${k}=${sh(v)}`)
      .join("; ");
    const inner = `cd ${sh(code)} && ${exports}; { ${t.setup ? `${t.setup}\n` : ""}${command}\n} > ${sh(`${remote}/log.txt`)} 2>&1; echo $? > ${sh(`${remote}/exit.tmp`)}; mv ${sh(`${remote}/exit.tmp`)} ${sh(`${remote}/exit`)}`;
    const launch = `if command -v setsid >/dev/null 2>&1; then setsid nohup sh -c ${sh(inner)} >/dev/null 2>&1 < /dev/null & else nohup sh -c ${sh(inner)} >/dev/null 2>&1 < /dev/null & fi; echo $!`;
    const pid = Number((await run(this.ssh(), [t.ssh_host, launch])).trim().split("\n").pop());
    if (!Number.isInteger(pid)) throw new Error("无法取得远程进程号");
    this.db.prepare("INSERT INTO jobs (id,experiment_id,kind,target,dir,remote_dir,pid,status,started_at) VALUES (?,?,?,?,?,?,?,'running',?)").run(jobId, expId, kind, target, dir, remote, pid, Date.now());
  }

  private ssh() {
    return process.env.BOT_SSH || "ssh";
  }

  private rsync() {
    return process.env.BOT_RSYNC || "rsync";
  }

  private async poll() {
    if (this.polling) return;
    this.polling = true;
    try {
      for (const j of this.db.prepare("SELECT * FROM jobs WHERE status='running'").all() as Row[]) {
        await (j.target === "local" ? this.pollLocal(j) : this.pollRemote(j)).catch(() => {});
      }
    } finally {
      this.polling = false;
    }
  }

  private async pollLocal(j: Row) {
    const exitFile = join(j.dir, "exit");
    if (existsSync(exitFile)) return this.finish(j, Number(readFileSync(exitFile, "utf8").trim()));
    try {
      process.kill(j.pid, 0);
    } catch {
      // The exit file is written just before the process ends, so look once more.
      if (existsSync(exitFile)) return this.finish(j, Number(readFileSync(exitFile, "utf8").trim()));
      this.finish(j, null);
    }
  }

  private async pollRemote(j: Row) {
    const last = this.lastSshPoll.get(j.id) ?? 0;
    if (Date.now() - last < this.sshPollMs) return;
    this.lastSshPoll.set(j.id, Date.now());
    const t = this.listTargets().find((x) => x.name === j.target);
    if (!t) return;
    // A network failure throws here and the job stays "running": only the machine can say it is gone.
    const out = await run(this.ssh(), [t.ssh_host, `if [ -f ${sh(`${j.remote_dir}/exit`)} ]; then echo EXIT; cat ${sh(`${j.remote_dir}/exit`)}; elif kill -0 ${Number(j.pid)} 2>/dev/null; then echo ALIVE; else echo GONE; fi`], 30000);
    const [state, code] = out.trim().split("\n");
    if (state === "ALIVE") return;
    await this.fetchRemote(t, j).catch(() => {});
    this.finish(j, state === "EXIT" ? Number(code) : null);
    this.lastSshPoll.delete(j.id);
  }

  private async fetchRemote(t: Row, j: Row) {
    await run(this.rsync(), ["-az", "--max-size=20m", "--include", "metrics.json", "--include", "log.txt", "--include", "artifacts/***", "--exclude", "*", `${t.ssh_host}:${j.remote_dir}/`, `${j.dir}/`], 600000);
  }

  private finish(j: Row, exitCode: number | null) {
    this.db.prepare("UPDATE jobs SET status='ended', exit_code=?, ended_at=? WHERE id=?").run(exitCode, Date.now(), j.id);
    const metrics = readMetrics(join(j.dir, "metrics.json"));
    const e = this.getExperiment(j.experiment_id);
    if (!e) return;
    if (j.kind === "final") {
      this.db.prepare("UPDATE experiments SET final_status=?, test_metrics=? WHERE id=?").run(exitCode === 0 ? "done" : "failed", metrics ? JSON.stringify(metrics) : null, e.id);
      this.notify(e.project_id);
      return;
    }
    if (e.status === "cancelled") {
      this.notify(e.project_id);
      return;
    }
    const status = exitCode === null ? "lost" : exitCode === 0 ? "done" : "failed";
    this.db.prepare("UPDATE experiments SET status=?, metrics=?, ended_at=? WHERE id=?").run(status, metrics ? JSON.stringify(metrics) : null, Date.now(), e.id);
    this.notify(e.project_id);
    this.onFinished(this.getExperiment(e.id)!);
  }

  async cancel(id: string) {
    const e = this.getExperiment(id);
    if (!e) throw new HttpError(404, "没有这个实验");
    const j = this.db.prepare("SELECT * FROM jobs WHERE experiment_id=? AND status='running' ORDER BY started_at DESC").get(id) as Row | undefined;
    if (!j) throw new HttpError(409, "这个实验没有在运行");
    if (j.kind === "train") this.db.prepare("UPDATE experiments SET status='cancelled', ended_at=? WHERE id=?").run(Date.now(), id);
    if (j.target === "local") {
      try {
        process.kill(-j.pid, "SIGTERM");
      } catch {}
    } else {
      const t = this.listTargets().find((x) => x.name === j.target);
      if (t) await run(this.ssh(), [t.ssh_host, `kill -TERM -- -${Number(j.pid)} 2>/dev/null || kill -TERM ${Number(j.pid)} 2>/dev/null; true`], 30000).catch(() => {});
    }
    this.db.prepare("UPDATE jobs SET status='ended', ended_at=? WHERE id=?").run(Date.now(), j.id);
    if (j.kind === "final") this.db.prepare("UPDATE experiments SET final_status='failed' WHERE id=?").run(id);
    this.notify(e.project_id);
    return this.getExperiment(id)!;
  }

  // ---------- reading results ----------
  runDir(id: string) {
    if (!/^[0-9a-f]{8}$/.test(id)) throw new HttpError(400, "实验 ID 无效");
    return join(this.store.home, "runs", id);
  }

  logTail(id: string, bytes = 64 * 1024) {
    const f = join(this.runDir(id), "log.txt");
    if (!existsSync(f)) return "";
    const text = readFileSync(f);
    return text.subarray(Math.max(0, text.length - bytes)).toString("utf8");
  }

  manifest(id: string) {
    const f = join(this.runDir(id), "artifacts", "manifest.json");
    if (!existsSync(f)) return null;
    try {
      const raw = JSON.parse(readFileSync(f, "utf8"));
      const clean = (v: unknown) => (typeof v === "string" ? v.slice(0, 500) : null);
      return (Array.isArray(raw?.cases) ? raw.cases : []).slice(0, 5000).map((c: any) => ({
        id: String(c?.id ?? "").slice(0, 200),
        image: clean(c?.image),
        label: clean(c?.label),
        pred: clean(c?.pred),
        metrics: Object.fromEntries(Object.entries(c?.metrics ?? {}).filter(([, v]) => typeof v === "number").slice(0, 20)),
      }));
    } catch {
      throw new HttpError(422, "manifest.json 格式错误");
    }
  }

  // Paths come from a file a training script wrote, so they are confined to that run's artifacts.
  artifactFile(id: string, rel: string) {
    const type = IMAGE_TYPES[extname(rel).toLowerCase()];
    if (!type) throw new HttpError(415, "只能查看图片");
    const base = realpathSync(join(this.runDir(id), "artifacts"));
    const full = resolve(base, rel);
    if (!existsSync(full)) throw new HttpError(404, "文件不存在");
    const real = realpathSync(full);
    if (!real.startsWith(base + sep) || !statSync(real).isFile()) throw new HttpError(403, "不能访问这个路径");
    return { file: real, type };
  }

  // ---------- agent tools ----------
  tool(tool: string, projectId: string, args: any, botName: string): unknown {
    switch (tool) {
      case "add_idea":
        return this.addIdea(projectId, args, botName);
      case "update_idea": {
        const u = this.updateIdea(textArg(args?.id, 40), args, false);
        return { id: u.id, status: u.status, suggested_verdict: u.suggested_verdict };
      }
      case "list_ideas":
        return this.listIdeas(projectId).slice(0, 100).map((i) => ({ id: i.id, title: i.title, status: i.status, suggested_verdict: i.suggested_verdict, conclusion: i.conclusion.slice(0, 300), failure_reason: i.failure_reason.slice(0, 300) }));
      case "list_experiments": {
        const list = this.listExperiments(projectId, textArg(args?.idea_id, 40) || undefined).slice(0, 100);
        return { summary: summarize(list), experiments: list.map((e) => ({ id: e.id, name: e.name, role: e.role, seed: e.seed, status: e.status, commit: e.commit_hash?.slice(0, 8) ?? null, dirty: Boolean(e.dirty), metrics: e.metrics })) };
      }
      case "get_experiment": {
        const e = this.getExperiment(textArg(args?.id, 40));
        if (!e || e.project_id !== projectId) throw new HttpError(404, "没有这个实验");
        return { ...this.forBots(e), log_tail: this.logTail(e.id, 3000) };
      }
      default:
        throw new HttpError(404, `没有工具 ${tool}`);
    }
  }
}
