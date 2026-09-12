// GhostTrace - Temizlik sabitleri

export const EMPTY_RESULT = Object.freeze({
  cookies: 0, history: 0, downloads: 0, storage: 0, bytes: 0, truncated: false, remaining: 0
});

export const HISTORY_BUDGET_MS = 20_000;
export const BULK_HISTORY_BUDGET_MS = 60_000;
export const ERASE_CHUNK_SIZE = 200;
