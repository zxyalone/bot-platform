import { ClaudeRuntime } from "./adapters/claude.ts";
import { CodexRuntime } from "./adapters/codex.ts";
import { AcpRuntime } from "./adapters/acp.ts";
import type { AgentRuntime, RuntimeOptions } from "./types.ts";

export const realFactory = (o: RuntimeOptions): AgentRuntime => (o.agent === "claude" ? new ClaudeRuntime(o) : o.agent === "codex" ? new CodexRuntime(o) : new AcpRuntime(o));
