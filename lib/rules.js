// GhostTrace - Kural Motoru (Rules Engine)

import { extractHostname, normalizeDomain, getRootDomain, getPublicSuffix } from './domain.js';
import { getRules, mutateRules, KEEP_MODES } from './storage.js';

export const RuleType = Object.freeze({
  WHITE: 'white',
  GREY: 'grey',
  TEMP: 'temp',
  DEFAULT: 'default'
});

export const PROTECTED_TYPES = Object.freeze([RuleType.WHITE, RuleType.GREY, RuleType.TEMP]);

export const SNOOZE_ALARM_PREFIX = 'gt:snooze:';

/** Bir host icin snooze alarminin adi. */
export function snoozeAlarmName(host) {
  return `${SNOOZE_ALARM_PREFIX}${normalizeDomain(host) || host}`;
}

/** Snooze alarm adindan host'u cozer. */
export function hostFromSnoozeAlarm(alarmName) {
  return alarmName?.startsWith(SNOOZE_ALARM_PREFIX) ? alarmName.slice(SNOOZE_ALARM_PREFIX.length) : '';
}

/** Bir eslesmenin veriyi korumali kilip kilmadiginin TEK kaynagi. */
export function isRuleProtected(match) {
  return Boolean(match) && PROTECTED_TYPES.includes(match.type);
}

/** Kural TUM veriyi mi koruyor, yoksa yalnizca bazi cerezleri mi? keepMode: all (tam) | session (yalnizca oturum cerezleri) | custom (kalip). */
export function isRuleFullyProtected(match) {
  if (!isRuleProtected(match)) return false;
  if (match.type !== RuleType.WHITE) return true;
  return (match.rule?.keepMode || 'all') === 'all';
}

/** Kural nesnesini kanonik forma getirir. */
export function normalizeRule(domain, type, options = {}) {
  const host = normalizeDomain(domain);
  if (!host) return null;

  const effectiveType = PROTECTED_TYPES.includes(type) ? type : RuleType.WHITE;
  const root = getRootDomain(host);
  const isSubdomainRule = host !== root;
  // Bitis zamani verilmediyse sureden turetilir.
  const sure = Number(options.durationMinutes) || 0;
  const expiresAt = effectiveType === RuleType.TEMP
    ? (Number(options.expiresAt) || (sure > 0 ? Date.now() + sure * 60_000 : null))
    : null;

  return {
    domain: host,
    type: effectiveType,
    // Kapsam iki turde de gecerli, yalnizca varsayilani farkli: kok -> ACIK (opt-out), alt alan -> KAPALI (opt-in).
    subdomains: isSubdomainRule ? options.subdomains === true : options.subdomains !== false,
    expiresAt,
    // Sure SAYI olarak saklanir.
    durationMinutes: effectiveType === RuleType.TEMP ? (Number(options.durationMinutes) || null) : null,
    // Gecerli modlar: all | session | custom. 'session' onceden sessizce 'all'a cevriliyordu.
    keepMode: KEEP_MODES.includes(options.keepMode) ? options.keepMode : 'all',
    keepCookies: Array.isArray(options.keepCookies)
      ? [...new Set(options.keepCookies.map(p => String(p).trim().toLowerCase()).filter(Boolean))]
      : [],
    addedAt: Number(options.addedAt) || Date.now(),
    updatedAt: Date.now()
  };
}

/** Host icin gecerli kurali hiyerarsik olarak bulur. */
export function matchDomainRule(hostnameOrUrl, rules = {}) {
  const miss = { type: RuleType.DEFAULT, matchedDomain: null, rule: null, expired: false };

  const host = normalizeDomain(hostnameOrUrl);
  if (!host) return miss;

  const evaluate = (matchedDomain, rule) => {
    if (!rule) return miss;
    if (rule.type === RuleType.TEMP && rule.expiresAt && rule.expiresAt <= Date.now()) {
      return { type: RuleType.DEFAULT, matchedDomain, rule, expired: true };
    }
    return { type: rule.type, matchedDomain, rule, expired: false };
  };

  // 1. Birebir eslesme
  if (rules[host]) return evaluate(host, rules[host]);

  // 2. Ust alan adi zinciri.
  const labels = host.split('.');
  const suffixLabelCount = (getPublicSuffix(host) || '').split('.').filter(Boolean).length || 1;
  const minLabels = suffixLabelCount + 1;

  for (let i = 1; labels.length - i >= minLabels; i++) {
    const parent = labels.slice(i).join('.');
    const parentRule = rules[parent];
    if (parentRule && parentRule.subdomains !== false) {
      return evaluate(parent, parentRule);
    }
  }

  return miss;
}

// Alarm eslemesi: "temp kurali varsa alarmi da vardir" degismezi

async function syncSnoozeAlarm(host, rule) {
  if (!chrome.alarms) return;
  const name = snoozeAlarmName(host);
  try {
    if (rule?.type === RuleType.TEMP && rule.expiresAt && rule.expiresAt > Date.now()) {
      await chrome.alarms.create(name, { when: rule.expiresAt });
    } else {
      await chrome.alarms.clear(name);
    }
  } catch (err) {
    console.warn('[GhostTrace] Snooze alarmi eslenemedi:', err);
  }
}

/** Kural ekler veya guncelleyip alarmini esler. */
export async function setDomainRule(domain, type = RuleType.WHITE, options = {}) {
  const host = normalizeDomain(domain);
  if (!host) return null;

  let saved = null;
  await mutateRules(rules => {
    const previous = rules[host];
    const rule = normalizeRule(host, type, {
      ...options,
      addedAt: options.addedAt ?? previous?.addedAt
    });
    if (!rule) return undefined;

    // Eski kanonik olmayan varyantlari (www.x.com / raw host) temizle
    delete rules[`www.${host}`];
    const rawHost = extractHostname(domain);
    if (rawHost && rawHost !== host) delete rules[rawHost];

    rules[host] = rule;
    saved = rule;
    return rules;
  });

  if (saved) await syncSnoozeAlarm(host, saved);
  return saved;
}

/** Kurali (ve varsa alarmini) siler. */
export async function deleteDomainRule(domain) {
  const host = normalizeDomain(domain);
  if (!host) return false;

  let deleted = false;
  await mutateRules(rules => {
    const rawHost = extractHostname(domain);
    for (const key of new Set([host, rawHost, `www.${host}`])) {
      if (key && rules[key]) {
        delete rules[key];
        deleted = true;
      }
    }
    return deleted ? rules : undefined;
  });

  // Kural gitmisse alarm da gitmelidir - aksi halde ileride ayni host icin eklenen yeni kural bu alarm tarafindan silinir.
  await syncSnoozeAlarm(host, null);
  return deleted;
}

/** Suresi dolmus gecici izinleri ve yetim snooze alarmlarini temizler. */
export async function pruneExpiredRules() {
  const expired = [];
  const now = Date.now();

  await mutateRules(rules => {
    for (const [host, rule] of Object.entries(rules)) {
      if (rule?.type === RuleType.TEMP && rule.expiresAt && rule.expiresAt <= now) {
        expired.push(host);
        delete rules[host];
      }
    }
    return expired.length ? rules : undefined;
  });

  // Kurali olmayan snooze alarmlarini da toparla
  if (chrome.alarms) {
    try {
      const rules = await getRules();
      const alarms = await chrome.alarms.getAll();
      await Promise.all(
        alarms
          .filter(alarm => alarm.name.startsWith(SNOOZE_ALARM_PREFIX))
          .filter(alarm => {
            const host = hostFromSnoozeAlarm(alarm.name);
            return !host || rules[host]?.type !== RuleType.TEMP;
          })
          .map(alarm => chrome.alarms.clear(alarm.name))
      );
    } catch (err) {
      console.warn('[GhostTrace] Yetim snooze alarmlari temizlenemedi:', err);
    }
  }

  return expired;
}

/** Oturumluk (gri liste) kurallarin hostlarini dondurur. */
export async function getSessionScopedHosts() {
  const rules = await getRules();
  return Object.entries(rules)
    .filter(([, rule]) => rule?.type === RuleType.GREY)
    .map(([host]) => host);
}
