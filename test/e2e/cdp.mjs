// Minimal CDP istemcisi (playwright yok, bagimlilik yok).
// Node 22+ yerlesik WebSocket kullanir.

export async function httpJson(url) {
  const res = await fetch(url);
  return res.json();
}

export class CdpClient {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.nextId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
  }

  connect() {
    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(this.wsUrl);
      this.ws.addEventListener('open', () => resolve(this));
      this.ws.addEventListener('error', (e) => reject(new Error('WS hatasi: ' + (e.message || 'bilinmiyor'))));
      this.ws.addEventListener('message', (event) => {
        const msg = JSON.parse(event.data);
        if (msg.id && this.pending.has(msg.id)) {
          const { resolve: res, reject: rej } = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.error) rej(new Error(`${msg.error.message} (${JSON.stringify(msg.error.data ?? '')})`));
          else res(msg.result);
        } else if (msg.method) {
          for (const fn of this.eventHandlers.get(msg.method) || []) fn(msg.params, msg.sessionId);
        }
      });
    });
  }

  on(method, fn) {
    if (!this.eventHandlers.has(method)) this.eventHandlers.set(method, []);
    this.eventHandlers.get(method).push(fn);
  }

  /**
   * timeoutMs ayarlanabilir olmali: CEVAP VERMEYEN hedefler var.
   *
   * Chrome for Testing'in kendi "Contextual Tasks" eklentisinin service
   * worker'i Runtime.evaluate'e hic yanit vermiyor. Sabit 30 sn ile o tek
   * hedef, dogru eklentiyi arayan dongunun TUM butcesini yiyordu; GhostTrace
   * hedefi listede hazir dururken "bulunamadi" hatasi aliniyordu.
   */
  send(method, params = {}, sessionId, { timeoutMs = 30000 } = {}) {
    const id = this.nextId++;
    const payload = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify(payload));
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`CDP zaman asimi (${timeoutMs}ms): ${method}`));
        }
      }, timeoutMs);
    });
  }

  close() { try { this.ws.close(); } catch { /* zaten kapali */ } }
}

/** Bir hedefe baglanip sessionId doner. */
export async function attach(client, targetId) {
  const { sessionId } = await client.send('Target.attachToTarget', { targetId, flatten: true });
  return sessionId;
}

/**
 * Verilen baglamda ifade calistirir ve DUZ DEGER doner.
 * Hata olursa firlatir - sessizce undefined donmek testi yalancilastirir.
 */
export async function evaluate(client, sessionId, expression, options = {}) {
  const result = await client.send('Runtime.evaluate', {
    expression: `(async () => { ${expression} })()`,
    awaitPromise: true,
    returnByValue: true
  }, sessionId, options);
  if (result.exceptionDetails) {
    const d = result.exceptionDetails;
    throw new Error(`Sayfa ici hata: ${d.exception?.description || d.text}`);
  }
  return result.result.value;
}

export const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Bir kosul saglanana kadar bekler; saglanmazsa firlatir. */
export async function waitFor(label, fn, { timeoutMs = 15000, intervalMs = 250 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let last;
  while (Date.now() < deadline) {
    try {
      last = await fn();
      if (last) return last;
    } catch (err) {
      last = err.message;
    }
    await sleep(intervalMs);
  }
  throw new Error(`Beklenen kosul olusmadi: ${label} (son deger: ${JSON.stringify(last)})`);
}
