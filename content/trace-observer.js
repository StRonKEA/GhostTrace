// GhostTrace - 3. Taraf Iz Gozlemcisi (icerik script'i). webRequest degil: o yol her istekte SW'yi uyandirir ve tum trafigi okuma yetkisi ister.

(() => {
  'use strict';

  // Ayni sayfada iki kez calismayi engelle.
  const previous = window.__ghostTraceObserver;
  if (previous && !previous.stopped) return;
  const self = { stopped: false };
  window.__ghostTraceObserver = self;

  const FLUSH_INTERVAL_MS = 3000;
  const MAX_HOSTS_PER_BATCH = 60;
  const MAX_TOTAL_HOSTS = 300;

  const selfHost = location.hostname;
  if (!selfHost) return;

  // URL izleme parametrelerini (utm_*, fbclid vb.) sayfa adresinden temizler.
  function stripLocationTracking() {
    if (window !== window.top) return;
    try {
      const url = new URL(location.href);
      if (!url.search) return;
      const toRemove = [];
      for (const key of url.searchParams.keys()) {
        if (/^utm_|^ga_|^fbclid$|^gclid$|^gbraid$|^wbraid$|^gad_source$|^mc_eid$|^igshid$|^yclid$|^_hsenc$|^_hsmi$|^mkt_tok$|^si$|^msclkid$|^dclid$/i.test(key)) {
          toRemove.push(key);
        }
      }
      if (toRemove.length === 0) return;
      for (const key of toRemove) url.searchParams.delete(key);
      const clean = (url.pathname || '/') + (url.search ? url.search : '') + (url.hash || '');
      window.history.replaceState(window.history.state, '', clean);
    } catch {
      // Sayfa history veya URL erisimini engellediyse sessizce gec
    }
  }
  stripLocationTracking();

  const reported = new Set();
  const pending = new Set();
  let flushTimer = null;
  let stopped = false;

  /** Durumu pencereye de yansitir: yeniden enjeksiyon bunu okuyor. */
  const markStopped = () => { stopped = true; self.stopped = true; };

  function consider(rawUrl) {
    if (stopped || reported.size >= MAX_TOTAL_HOSTS) return;
    if (!rawUrl || rawUrl.length > 2048) return;

    let host;
    try {
      const url = new URL(rawUrl, location.href);
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return;
      host = url.hostname;
    } catch {
      return;
    }

    if (!host || host === selfHost) return;
    // Ayni sitenin alt alan adlarini 3. taraf saymak icin kok karsilastirmasi gerekir.
    if (reported.has(host) || pending.has(host)) return;

    pending.add(host);
    scheduleFlush();
  }

  function scheduleFlush() {
    if (flushTimer || stopped) return;
    flushTimer = setTimeout(flush, FLUSH_INTERVAL_MS);
  }

  function flush() {
    flushTimer = null;
    if (stopped || pending.size === 0) return;

    const batch = Array.from(pending).slice(0, MAX_HOSTS_PER_BATCH);
    for (const host of batch) {
      pending.delete(host);
      reported.add(host);
    }

    try {
      chrome.runtime.sendMessage(
        { action: 'REPORT_THIRD_PARTY', parent: selfHost, hosts: batch },
        () => {
          // Service worker uyaniyor olabilir; yanit beklemiyoruz.
          void chrome.runtime.lastError;
        }
      );
    } catch {
      // Eklenti guncellendi/kaldirildi: gozlemi tamamen durdur.
      markStopped();
      return;
    }

    if (pending.size > 0) scheduleFlush();
  }

  // Service worker "dur" derse gozlemi tamamen kapat.
  let liveObserver = null;
  try {
    chrome.runtime.onMessage.addListener((message) => {
      if (message?.action !== 'STOP_THIRD_PARTY_OBSERVER') return;
      markStopped();
      pending.clear();
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      if (liveObserver) {
        try { liveObserver.disconnect(); } catch { /* zaten kapali */ }
        liveObserver = null;
      }
    });
  } catch {
    // Mesaj dinleyicisi kurulamadi; gozlem yine de calisir.
  }

  // Origin'in depolama kullanimini BIR KEZ olcup bildirir.
  const STORAGE_MEASURE_DELAY_MS = 6000;

  function measureStorageOnce() {
    if (stopped) return;
    // Olcum YALNIZCA ust cerceveden: alt cerceve kendi origin'ini olcer ama SW degeri sekme url'sine yazar - reklam cercevesinin depolamasi haber sitesine mal edilirdi. 3. taraf HOST bildirimi bundan etkilenmez.
    if (window !== window.top) return;
    if (!navigator.storage?.estimate) return;

    navigator.storage.estimate().then(estimate => {
      if (stopped) return;
      const usage = Number(estimate?.usage);
      if (!Number.isFinite(usage) || usage <= 0) return;
      try {
        chrome.runtime.sendMessage(
          { action: 'REPORT_STORAGE_ESTIMATE', usage },
          () => { void chrome.runtime.lastError; }
        );
      } catch {
        stopped = true;
      }
    }).catch(() => {
      // Olcum yapilamadi; sessizce vazgec.
    });
  }

  setTimeout(measureStorageOnce, STORAGE_MEASURE_DELAY_MS);

  // 1. Sayfa yuklenirken olusan kayitlar
  try {
    for (const entry of performance.getEntriesByType('resource')) {
      consider(entry.name);
    }
  } catch {
    // Resource Timing kullanilamiyor
  }

  // 2. Sonradan gelen kayitlar
  try {
    const observer = new PerformanceObserver(list => {
      if (stopped) return;
      for (const entry of list.getEntries()) consider(entry.name);
    });
    observer.observe({ type: 'resource', buffered: true });
    liveObserver = observer;

    window.addEventListener('pagehide', () => {
      // ONCE BOSALT, sonra dur.
      if (flushTimer) {
        clearTimeout(flushTimer);
        flushTimer = null;
      }
      flush();
      markStopped();
      observer.disconnect();
      liveObserver = null;
    }, { once: true });
  } catch {
    // PerformanceObserver yok: yalnizca ilk anlik goruntu ile yetinilir
  }
})();
