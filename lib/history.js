// GhostTrace - Gecmis Katmani (History Layer)

import { logWarn, LogCategory } from './logger.js';

const encoder = new TextEncoder();

const DEFAULT_PAGE_SIZE = 5000;
const DEFAULT_MAX_PAGES = 200;

/** Gecmis kaydinin olculen bayt buyuklugu. */
export function estimateHistoryBytes(item) {
  if (!item) return 0;
  return encoder.encode(`${item.url || ''}${item.title || ''}`).length + 64;
}

/** Verilen metin filtresiyle gecmisi sonuna kadar sayfalayarak okur. */
export async function searchHistoryPaged({
  text = '',
  pageSize = DEFAULT_PAGE_SIZE,
  maxPages = DEFAULT_MAX_PAGES,
  filter = null
} = {}) {
  const collected = [];
  const seenUrls = new Set();
  let endTime;
  let truncated = false;

  for (let page = 0; page < maxPages; page++) {
    const query = { text, startTime: 0, maxResults: pageSize };
    if (endTime !== undefined) query.endTime = endTime;

    let batch;
    try {
      batch = await chrome.history.search(query);
    } catch (err) {
      // truncated = true ZORUNLU: yarida kesilen tarama TAM sayilirsa cagiran taraf "hepsini gordum" varsayar, buldugunu siler ve "temizlendi" der.
      truncated = true;
      await logWarn(
        LogCategory.PURGE,
        `Gecmis aramasi ${page + 1}. sayfada basarisiz; tarama yarim kaldi`,
        { page: page + 1, error: String(err) }
      );
      break;
    }
    if (!Array.isArray(batch) || batch.length === 0) break;

    let added = 0;
    let oldest = Infinity;
    for (const item of batch) {
      if (!item?.url) continue;
      const visitTime = Number(item.lastVisitTime) || 0;
      if (visitTime < oldest) oldest = visitTime;
      if (seenUrls.has(item.url)) continue;
      seenUrls.add(item.url);
      if (!filter || filter(item)) collected.push(item);
      added++;
    }

    // Sayfa dolmadiysa gecmisin sonuna geldik.
    if (batch.length < pageSize) break;
    // Ayni zaman damgasinda sikisip kaldiysak sonsuz donguye girmeyelim.
    if (added === 0) break;
    if (!Number.isFinite(oldest)) break;

    // +1 ms: ayni damgayi tasiyan kayitlar bir sonraki sayfada da gorunur, seenUrls tekrarlari eler.
    endTime = oldest + 1;
    if (page === maxPages - 1) truncated = true;
  }

  return { items: collected, truncated };
}

/** Kapsama giren gecmis kayitlarini bulur. `isHostProtected(host)` true donerse o kayit atlanir (alt alan adi beyaz listede olabilir). */
export async function findHistoryForScope(scope, { isHostProtected = null, pageSize } = {}) {
  if (!scope) return { items: [], truncated: false };
  return searchHistoryPaged({
    text: scope.searchText,
    pageSize,
    filter: (item) => {
      if (!scope.matches(item.url)) return false;
      if (isHostProtected && isHostProtected(item.url)) return false;
      return true;
    }
  });
}

/** Tek seferde kac silme istegi paralel gonderilir. */
export const DELETE_CHUNK_SIZE = 400;

/** Kapsama giren gecmis kayitlarini PARCALI olarak siler. */
export async function deleteHistoryForScope(scope, options = {}) {
  const { items, truncated } = await findHistoryForScope(scope, options);
  const result = await deleteHistoryItems(items, options);
  return { ...result, truncated };
}

/** Verilen gecmis kayitlarini PARCALI ve BUTCELI olarak siler. */
export async function deleteHistoryItems(items, { budgetMs = null, chunkSize = DELETE_CHUNK_SIZE } = {}) {
  const origins = new Set();
  if (items.length === 0) return { count: 0, bytes: 0, failed: 0, origins, remaining: 0 };

  const startedAt = Date.now();
  let count = 0;
  let bytes = 0;
  let failed = 0;
  let processed = 0;

  for (let offset = 0; offset < items.length; offset += chunkSize) {
    const chunk = items.slice(offset, offset + chunkSize);

    const results = await Promise.all(chunk.map(item => {
      if (item.url.startsWith('http://') || item.url.startsWith('https://')) {
        try { origins.add(new URL(item.url).origin); } catch { /* gecersiz URL atlanir */ }
      }
      const itemBytes = estimateHistoryBytes(item);
      // Reddi YUTMUYORUZ.
      return chrome.history.deleteUrl({ url: item.url })
        .then(() => ({ ok: true, bytes: itemBytes }), () => ({ ok: false, bytes: 0 }));
    }));

    for (const value of results) {
      if (value.ok) { count++; bytes += value.bytes; } else { failed++; }
    }
    processed += chunk.length;

    // Butce dolduysa kalani cagirana birak; olayi uzatip worker'in oldurulmesini beklemek yerine kontrollu duruyoruz.
    if (budgetMs !== null && (Date.now() - startedAt) >= budgetMs && processed < items.length) {
      return { count, bytes, failed, origins, remaining: items.length - processed };
    }
  }

  return { count, bytes, failed, origins, remaining: 0 };
}

/** Rozet icin hizli sayim. */
export async function countHistoryForScope(scope, { cap = 500 } = {}) {
  if (!scope) return { count: 0, capped: false };
  try {
    const batch = await chrome.history.search({
      text: scope.searchText,
      startTime: 0,
      maxResults: cap + 1
    });
    const matching = batch.filter(item => item?.url && scope.matches(item.url));
    return { count: Math.min(matching.length, cap), capped: matching.length > cap };
  } catch {
    return { count: 0, capped: false };
  }
}
