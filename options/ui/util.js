// GhostTrace - Ayarlar paneli: genel yardimcilar

/** Cagrilari toparlar: son cagridan `wait` ms sonra bir kez calisir. */
export function debounce(fn, wait = 300) {
  let timer = null;
  return (...args) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(...args); }, wait);
  };
}
