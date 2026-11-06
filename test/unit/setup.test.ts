import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { boot } from "../helpers.ts";
import { listedModels } from "../../src/daemon/server.ts";
import { templatesFor } from "../../src/daemon/workspaces.ts";
import { MODELS, validModel } from "../../src/daemon/types.ts";

const GROK = `You are logged in with grok.com.

Default model: grok-4.7

Available models:
  * grok-4.7 (default)
  - grok-4.7-build-fast
  - grok-4.5
`;
const AGY = "Fetching available models...\ngemini-4-argon-medium\tGemini 4 Argon (Medium)\ngemini-4-argon-high\tGemini 4 Argon (High)\nclaude-sonnet-5-5-low\tClaude Sonnet 5.5 (Low)\n";

test("model pickers list what this person's CLI reports, falling back to the defaults", () => {
  assert.deepEqual(listedModels(GROK, "grok"), ["grok-4.7", "grok-4.7-build-fast", "grok-4.5"]);
  assert.deepEqual(listedModels(AGY, "antigravity"), ["gemini-4-argon", "claude-sonnet-5-5"]);
  assert.deepEqual(listedModels("something else", "grok"), MODELS.grok);
});

const agent = (loggedIn: boolean, models: string[]) => ({ installed: true, loggedIn, models });

test("each team seat goes to an agent this person can use", () => {
  const onlyCodex = templatesFor({ codex: agent(true, MODELS.codex) });
  const seat = (list: ReturnType<typeof templatesFor>, key: string) => list.find((t) => t.key === key)!;
  assert.deepEqual([seat(onlyCodex, "chief").agent, seat(onlyCodex, "chief").model], ["codex", "gpt-6.1-terra"]);
  assert.equal(seat(onlyCodex, "reviewer").model, "gpt-6-astra");
  assert.equal(seat(onlyCodex, "scholar").on, false, "optional seats stay off");
  assert.ok(onlyCodex.every((t) => t.ready));

  const full = templatesFor({ claude: agent(true, MODELS.claude), codex: agent(true, MODELS.codex), antigravity: agent(true, ["gemini-3.8-flash"]) });
  assert.equal(seat(full, "chief").agent, "claude");
  assert.equal(seat(full, "engineer").agent, "codex");
  assert.equal(seat(full, "scholar").agent, "antigravity");
  assert.equal(seat(full, "scholar").on, true, "with three agents there is someone for research");

  const notLoggedIn = templatesFor({ claude: agent(false, MODELS.claude) });
  assert.equal(seat(notLoggedIn, "chief").agent, "claude");
  assert.equal(seat(notLoggedIn, "chief").ready, false);

  const listed = templatesFor({ grok: agent(true, ["grok-4.5"]) });
  assert.equal(seat(listed, "chief").model, "grok-4.5", "a model the CLI does not list is not suggested");

  const none = templatesFor({});
  assert.ok(none.every((t) => t.agent === null && t.model === null));
});

test("custom model names are allowed, other vendors' models are not", async () => {
  assert.equal(validModel("claude", "claude-opus-6"), true);
  assert.equal(validModel("claude", "gpt-6-luna"), false);
  assert.equal(validModel("antigravity", "claude-sonnet-5-5"), true);
  assert.equal(validModel("claude", "--dangerous"), false);
  assert.equal(validModel("nobody", "x"), false);

  const t = await boot(() => {
    throw new Error("no agents in this test");
  });
  const cwd = mkdtempSync(join(tmpdir(), "bot-setup-"));
  const ok = await t.api("POST", "/api/bots", { name: "New", role: "r", agent: "claude", model: "claude-opus-6", cwd });
  assert.equal(ok.status, 201, JSON.stringify(ok.body));
  assert.equal(ok.body.model, "claude-opus-6");
  assert.equal((await t.api("POST", "/api/bots", { name: "Bad", role: "r", agent: "claude", model: "gpt-6-luna", cwd })).status, 400);
  const state = (await t.api("GET", "/api/state")).body;
  assert.ok(state.workspace_templates.every((x: any) => "ready" in x && !("role" in x)));
  const refreshed = await t.api("POST", "/api/agents/refresh", {});
  assert.equal(refreshed.status, 200);
  assert.ok(refreshed.body.agents.claude);
  t.close();
});
