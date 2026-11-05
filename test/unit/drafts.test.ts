import { test } from "node:test";
import assert from "node:assert/strict";
import { draftKey, loadDrafts, saveDrafts } from "../../src/web/drafts.js";

const store = () => {
  const m = new Map<string, string>();
  return { getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => void m.set(k, v), m };
};

test("two groups' new conversations do not share a draft, and neither do a group and a Bot", () => {
  const keys = [draftKey({ groupId: "g1", botId: null, convId: null }), draftKey({ groupId: "g2", botId: null, convId: null }), draftKey({ groupId: null, botId: "b1", convId: null }), draftKey({ groupId: "g1", botId: null, convId: "c" })];
  assert.equal(new Set(keys).size, 4);
});

test("drafts survive a reload; empty ones are not kept", () => {
  const s = store();
  const a = new Map([["x", "写到一半"], ["y", "   "], ["z", ""]]);
  saveDrafts(s, a);
  assert.deepEqual([...loadDrafts(s)], [["x", "写到一半"]]);
});

test("broken or unavailable storage costs the drafts, not the page", () => {
  const s = store();
  s.setItem("bot-platform:drafts", "{nope");
  assert.equal(loadDrafts(s).size, 0);
  assert.equal(loadDrafts(undefined).size, 0);
  assert.doesNotThrow(() => saveDrafts({ getItem: () => null, setItem: () => { throw new Error("full"); } }, new Map([["a", "b"]])));
});

test("only the most recent drafts are kept", () => {
  const s = store();
  saveDrafts(s, new Map(Array.from({ length: 300 }, (_, i) => [`k${i}`, "x"] as [string, string])));
  const back = loadDrafts(s);
  assert.equal(back.size, 200);
  assert.ok(back.has("k299") && !back.has("k0"));
});
