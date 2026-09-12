// GhostTrace - 3. taraf gozlemcisinin yasam dongusu.

import { Action } from '../messaging.js';
import { getSettings } from '../storage.js';
import { logInfo, logWarn, LogCategory } from '../logger.js';
import { CONTENT_SCRIPT_ID } from './constants.js';
import { openWebTabs } from './tabs.js';

/** Gozlemciyi ZATEN ACIK sekmelere enjekte eder. */
export async function backfillObserverIntoOpenTabs(allFrames = false) {
  if (!chrome.scripting?.executeScript) return 0;

  const tabs = await openWebTabs();

  // PARALEL: sekmeler birbirinden bagimsiz.
  const outcomes = await Promise.all(tabs.map(tab => {
    if (tab.id === undefined) return Promise.resolve(false);
    return chrome.scripting.executeScript({
      // Kapsam KAYITLA AYNI olmali.
      target: { tabId: tab.id, allFrames },
      files: ['content/trace-observer.js']
    }).then(() => true, () => false);
    // chrome://, Web Store ve erisim verilmemis sayfalarda hata atar.
  }));
  const injected = outcomes.filter(Boolean).length;

  if (injected > 0) {
    await logInfo(LogCategory.SYSTEM, `3. taraf gozlemcisi ${injected} acik sekmeye enjekte edildi`);
  }
  return injected;
}

/** Acik sekmelerdeki gozlemciye "dur" der: kaydi silmek zaten enjekte edilmis script'i durdurmaz, yani "kapali" derken veri toplamaya devam ederdi. */
export async function stopObserverInOpenTabs() {
  const tabs = await openWebTabs();

  // Enjeksiyonla ayni gerekce: sekmeler bagimsiz, seri beklemenin karsiligi yok.
  const durdur = async (tabId) => {
    try {
      // Gozlemci o sekmede hic calismamis olabilir; hata beklenen bir hal.
      await chrome.tabs.sendMessage(tabId, { action: Action.STOP_THIRD_PARTY_OBSERVER });
      return true;
    } catch {
      return false;
    }
  };
  const outcomes = await Promise.all(
    tabs.map(tab => (tab.id === undefined ? false : durdur(tab.id)))
  );
  const stopped = outcomes.filter(Boolean).length;

  if (stopped > 0) {
    await logInfo(LogCategory.SYSTEM, `${stopped} sekmede 3. taraf gozlemcisi durduruldu`);
  }
  return stopped;
}

/** Kaydi kurar; zaten varsa false doner. "Duplicate script ID" ariza degil beklenen bir hal - yukari atmak ardindaki geri doldurmayi atlatiyordu. */
async function registerObserverScript(allFrames) {
  try {
    await chrome.scripting.registerContentScripts([{
      id: CONTENT_SCRIPT_ID,
      js: ['content/trace-observer.js'],
      matches: ['http://*/*', 'https://*/*'],
      // document_start: Resource Timing tamponu 250 girdide tasabilir ve document_idle'a kadar beklenirse ilk kaynaklar kacirilabilir.
      runAt: 'document_start',
      allFrames,
      persistAcrossSessions: true
    }]);
    return true;
  } catch (err) {
    if (/duplicate/i.test(err?.message || '')) return false;
    throw err;
  }
}

/** Kaydi kaldirir. Zaten yoksa hatayi yutar (ayni saklama gecikmesi). */
async function unregisterObserverScript() {
  try {
    await chrome.scripting.unregisterContentScripts({ ids: [CONTENT_SCRIPT_ID] });
  } catch (err) {
    if (!/nonexistent|no script|not found/i.test(err?.message || '')) throw err;
  }
}

/** Ayar kapaliysa icerik script'i HIC kaydedilmez - sayfalarda kod calismaz. options.backfillOpenTabs: kayit zaten varken de acik sekmeleri doldur; guncelleme enjekte edilmis script'i oldurdugu icin zorunlu. */
async function runRegistrationSync({ backfillOpenTabs = false } = {}) {
  if (!chrome.scripting?.getRegisteredContentScripts) return;

  try {
    const settings = await getSettings();
    const registered = await chrome.scripting.getRegisteredContentScripts({ ids: [CONTENT_SCRIPT_ID] })
      .catch(() => []);
    const isRegistered = registered.length > 0;
    const wanted = settings.enabled && settings.trackThirdParty;
    const wantAllFrames = settings.trackThirdPartyFrames === true;

    // Kayit VAR ama kapsami degismisse yeniden kurulmali: registerContentScripts mevcut bir kaydin allFrames degerini guncellemez.
    const scopeChanged = isRegistered && Boolean(registered[0]?.allFrames) !== wantAllFrames;

    if (wanted && isRegistered && scopeChanged) {
      await unregisterObserverScript();
      // Eski kapsamdaki enjekte script'ler susturulmali.
      await stopObserverInOpenTabs();
      await registerObserverScript(wantAllFrames);
      await backfillObserverIntoOpenTabs(wantAllFrames);
      await logInfo(LogCategory.SYSTEM,
        `3. taraf gozlemcisi kapsami degisti (iframe: ${wantAllFrames ? 'acik' : 'kapali'})`);
    } else if (wanted && !isRegistered) {
      // Yeni mi kuruldu, zaten mi vardi?
      if (await registerObserverScript(wantAllFrames)) {
        await logInfo(LogCategory.SYSTEM, '3. taraf gozlemcisi etkinlestirildi');
      }
      // Kayit yalnizca SONRAKI yuklemelere uygular; acik sekmeleri geri doldur.
      await backfillObserverIntoOpenTabs(wantAllFrames);
    } else if (wanted && isRegistered && backfillOpenTabs) {
      // Kayit sag kalmis ama enjekte edilmis script olmus olabilir (guncelleme).
      await backfillObserverIntoOpenTabs(wantAllFrames);
    } else if (!wanted && isRegistered) {
      await unregisterObserverScript();
      // Kayit silmek, enjekte edilmis script'i durdurmaz; acikca soylemeliyiz.
      await stopObserverInOpenTabs();
      await logInfo(LogCategory.SYSTEM, '3. taraf gozlemcisi kapatildi');
    }
  } catch (err) {
    await logWarn(LogCategory.SYSTEM, `Icerik script'i kaydi guncellenemedi: ${err.message}`);
  }
}

// Cagrilar SIRAYA girer: ayni ayar yazmasi bu isi iki yoldan tetikliyor (mesaj isleyicisi + onChanged).
let syncChain = Promise.resolve();

export function syncContentScriptRegistration(options) {
  const next = () => runRegistrationSync(options);
  syncChain = syncChain.then(next, next);
  return syncChain;
}
