import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";

export function agentEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  // Set when the daemon itself was launched from a Claude Code session.
  delete env.CLAUDECODE;
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CLAUDE_CODE_SSE_PORT;
  // A call to another Bot can legitimately take a long time; the default limit would abandon it.
  env.MCP_TOOL_TIMEOUT = "3600000";
  env.PATH = [join(homedir(), ".npm-global", "bin"), join(homedir(), ".local", "bin"), "/opt/homebrew/bin", "/usr/local/bin", env.PATH].filter(Boolean).join(":");
  return env;
}

export interface LineProcess {
  child: ChildProcessWithoutNullStreams;
  write(obj: unknown): void;
  stderrTail(): string;
}

// Spawns without a shell. Every value reaches the agent as one argv entry.
export function spawnLines(
  command: string,
  args: string[],
  cwd: string,
  onMessage: (msg: any) => void,
  onExit: (detail: { code: number | null; signal: string | null; error?: string }) => void,
): LineProcess {
  const child = spawn(command, args, { cwd, env: agentEnv(), stdio: ["pipe", "pipe", "pipe"] });
  let buf = "";
  let tail = "";
  let exited = false;
  const finish = (d: { code: number | null; signal: string | null; error?: string }) => {
    if (exited) return;
    exited = true;
    onExit(d);
  };
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buf += chunk;
    let i: number;
    while ((i = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, i).trim();
      buf = buf.slice(i + 1);
      if (!line) continue;
      let msg: unknown;
      try {
        msg = JSON.parse(line);
      } catch {
        continue;
      }
      onMessage(msg);
    }
  });
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (d: string) => {
    tail = (tail + d).slice(-1200);
  });
  child.stdin.on("error", () => {});
  child.on("error", (e) => finish({ code: null, signal: null, error: e.message }));
  child.on("close", (code, signal) => finish({ code, signal }));
  return {
    child,
    write: (obj) => {
      if (child.stdin.writable) child.stdin.write(JSON.stringify(obj) + "\n");
    },
    stderrTail: () => tail.trim(),
  };
}

export const clip = (s: unknown, n = 4000) => {
  const t = typeof s === "string" ? s : s === undefined || s === null ? "" : JSON.stringify(s, null, 2);
  return t.length > n ? t.slice(0, n) + `\n…（已截断，共 ${t.length} 字符）` : t;
};
