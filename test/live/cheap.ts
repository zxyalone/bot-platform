// The cheapest model each agent offers. Live tests spend the user's own subscriptions, so nothing here should cost more.
export const CHEAPEST = {
  claude: "claude-haiku-5-5",
  codex: "gpt-6-luna",
  grok: "grok-4.7-build-fast",
  antigravity: "gemini-3.8-flash",
} as const;
