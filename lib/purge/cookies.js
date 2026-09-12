// GhostTrace - Cerez temizligi

import { hostFromCookieDomain } from '../domain.js';
import { fetchCookies, removeCookies } from '../cookies.js';
import { logSuccess, logWarn, logError, LogCategory } from '../logger.js';

/** Geri konamayan KORUMALI cerezleri loglar. */
export async function raporlaGeriKonamayan(failedRestores, domain = null) {
  if (!failedRestores?.length) return;
  await logError(
    LogCategory.COOKIE,
    `${failedRestores.length} KORUMALI cerez yan hasar olarak silindi ve geri konamadi`,
    { cookies: failedRestores },
    domain
  );
}

/** Kapsama giren cerezleri siler. */
export async function cleanCookiesForScope(scope, ctx) {
  const hosts = new Set();
  if (!scope) return { count: 0, bytes: 0, hosts };

  try {
    const cookies = await fetchCookies({ domain: scope.cookieFilterDomain });
    const targets = [];

    for (const cookie of cookies) {
      if (!scope.matchesCookie(cookie)) continue;
      const host = hostFromCookieDomain(cookie.domain);
      if (host) hosts.add(host);
      if (ctx.isCookieProtected(cookie)) continue;
      targets.push(cookie);
    }

    // shouldPreserve: yan hasar goren KORUMALI cerezler geri konur.
    const outcome = await removeCookies(targets, {
      shouldPreserve: (candidate) => ctx.isCookieProtected(candidate),
      protectedHosts: ctx.protectedHosts
    });
    const { count, bytes } = outcome;

    if (count > 0) {
      await logSuccess(LogCategory.COOKIE, `${count} cerez silindi`, { count, bytes }, scope.base);
    }

    // chrome.cookies.remove basarisizlikta null doner ve hata atmaz.
    const failed = outcome.failed;
    // Geri koyma basarisizligi SESSIZ KALMAZ: korumali bir cerez yan hasar olarak yok olduysa kullanici "N cerez silindi" basari satirinin altinda oturumunu kaybetmis olur.
    await raporlaGeriKonamayan(outcome.failedRestores, scope.base);

    if (failed > 0) {
      // MESAJ BIR SEBEP IDDIA ETMEZ.
      await logWarn(
        LogCategory.COOKIE,
        `${failed} cerez silinemedi`,
        { attempted: targets.length, removed: count, failed, cookies: outcome.failures },
        scope.base
      );
    }

    return { count, bytes, hosts };
  } catch (err) {
    await logError(LogCategory.COOKIE, `Cerez temizleme hatasi: ${err.message}`, { error: String(err) }, scope.base);
    return { count: 0, bytes: 0, hosts };
  }
}
