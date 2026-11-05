// Unsent text, kept in the browser so a reload or a restart does not lose it.
const STORAGE_KEY = "bot-platform:drafts";
const MAX_DRAFTS = 200;

// A group's new conversation has neither a Bot nor a conversation id, so the group has to be part of the key.
export const draftKey = ({ groupId, botId, convId }) => `${groupId ? `g:${groupId}` : `b:${botId}`}/${convId ?? "new"}`;

export function loadDrafts(storage) {
  try {
    const list = JSON.parse(storage.getItem(STORAGE_KEY));
    return new Map(Array.isArray(list) ? list.filter((e) => Array.isArray(e) && typeof e[0] === "string" && typeof e[1] === "string") : []);
  } catch {
    return new Map();
  }
}

export function saveDrafts(storage, drafts) {
  try {
    storage.setItem(STORAGE_KEY, JSON.stringify([...drafts].filter(([, text]) => text.trim()).slice(-MAX_DRAFTS)));
  } catch {
    // Full or unavailable: the drafts still live in memory until the page goes away.
  }
}
