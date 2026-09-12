/* global sessionStorage */
// GECICI - yalnizca sonda-kovaSilme.mjs olcumu icin. Uruene ait degil.
(async () => {
  const t0 = performance.now();
  try {
    const adlar = await navigator.storageBuckets.keys();
    await Promise.all(adlar.map(a => navigator.storageBuckets.delete(a)));
    sessionStorage.setItem('gtSilme', JSON.stringify({
      sildi: adlar, ms: Math.round(performance.now() - t0) }));
  } catch (e) {
    sessionStorage.setItem('gtSilme', JSON.stringify({ hata: String(e) }));
  }
})();
