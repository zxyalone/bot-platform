export type AgentKind = "claude" | "codex" | "grok" | "antigravity";
export type Effort = "low" | "medium" | "high";
export type PermissionPreset = "ask" | "auto_edit" | "read_only";
export type Route = "official" | "gateway";
export type ApprovalDecision = "allow" | "allow_session" | "deny";
export type TurnStatus = "completed" | "interrupted" | "failed";

export interface Bot {
  id: string;
  workspace_id: string;
  name: string;
  role: string;
  agent: AgentKind;
  model: string;
  effort: Effort;
  permission: PermissionPreset;
  route: Route;
  cwd: string;
  budget_tokens: number;
  can_call: string | null;
  is_chief: number;
  paused: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface Group {
  id: string;
  workspace_id: string;
  name: string;
  cwd: string;
  budget_tokens: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface Conversation {
  id: string;
  bot_id: string | null;
  group_id: string | null;
  parent_conv_id: string | null;
  kind: "direct" | "group" | "member" | "call";
  last_seq: number;
  title: string;
  agent: AgentKind;
  route: Route;
  cwd: string;
  session_id: string | null;
  status: "idle" | "running";
  cost_total: number;
  archived: number;
  created_at: number;
  updated_at: number;
}

export interface Item {
  id: string;
  conv_id: string;
  turn_id: string | null;
  seq?: number;
  type: "user" | "assistant" | "tool" | "approval" | "error" | "turn_summary" | "call" | "job" | "notice" | "queued" | "result" | "comparison";
  status: string;
  data: Record<string, unknown>;
  created_at: number;
  updated_at: number;
}

// Vendor protocols are normalized to these events; nothing above the adapters knows the wire format.
export type AgentEvent =
  | { type: "session"; sessionId: string }
  | { type: "text_delta"; key: string; text: string }
  | { type: "text_done"; key: string; text: string }
  | { type: "tool"; key: string; title: string; detail?: string; output?: string; status: "running" | "done" | "failed"; files?: string[]; command?: string }
  | { type: "approval"; requestId: string; title: string; detail: string; canRemember: boolean }
  | { type: "approval_cancelled"; requestId: string }
  | { type: "usage_tick"; tokens: number }
  | { type: "usage"; inputTokens: number; cachedTokens: number; outputTokens: number; costTotalUsd?: number }
  | { type: "turn_end"; status: TurnStatus; error?: string }
  | { type: "exit"; error?: string };

export interface RuntimeOptions {
  agent: AgentKind;
  model: string;
  effort: Effort;
  permission: PermissionPreset;
  route: Route;
  cwd: string;
  systemPrompt: string;
  sessionId: string | null;
  bus?: { command: string; args: string[]; env: Record<string, string> };
  onEvent: (event: AgentEvent) => void;
}

export interface AgentRuntime {
  start(): Promise<void>;
  send(text: string): Promise<void>;
  // Adds to the turn in progress. Agents without it get the message after the turn ends.
  steer?(text: string): Promise<void>;
  interrupt(): Promise<void>;
  answerApproval(requestId: string, decision: ApprovalDecision): void;
  stop(): void;
}

export type RuntimeFactory = (options: RuntimeOptions) => AgentRuntime;

export const MODELS: Record<AgentKind, string[]> = {
  claude: ["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"],
  codex: ["gpt-6.1-sol", "gpt-6-astra", "gpt-6.1-terra", "gpt-6-luna"],
  grok: ["grok-4.7", "grok-4.7-build-fast", "grok-4.6"],
  antigravity: ["gemini-4-argon", "gemini-3.8-flash"],
};

export const BUS_TOOLS = ["list_bots", "ask_bot", "assign_task", "get_task", "remember", "recall"];
export const RESEARCH_TOOLS = ["add_idea", "update_idea", "list_ideas", "run_experiment", "list_experiments", "get_experiment"];
export const CHIEF_TOOLS = ["create_bot", "update_bot", "pause_bot", "propose_plan"];
