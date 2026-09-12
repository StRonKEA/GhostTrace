// GhostTrace - Sekmeler arasi tazeleme kaydi

const registry = new Map();

/** Bir gorunumu tazeleme adiyla kaydeder. Modul yuklenirken cagrilir. */
export function registerView(name, refresh) {
  registry.set(name, refresh);
}

/** Verilen gorunumleri tazeler. Ad verilmezse KAYITLI HEPSINI tazeler. */
export async function refreshViews(...names) {
  const targets = names.length > 0 ? names : [...registry.keys()];
  await Promise.all(targets.map(name => {
    const fn = registry.get(name);
    return fn ? fn() : undefined;
  }));
}
