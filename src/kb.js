// Recurring-issue detection -> autonomous KB article drafting.
// Groups resolved tickets in memory by shared category + overlapping keywords.
// When a cluster crosses a threshold, it becomes a candidate for an auto-drafted
// KB article (which then goes through the same human-approval gate).

const THRESHOLD = 2; // recurring = seen at least this many times

function keywords(text) {
  return new Set((text || '').toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter(w => w.length > 3));
}

export function findRecurring(memoryRecords) {
  const resolved = memoryRecords.filter(r => r.metadata?.resolution);
  const byCat = new Map();
  for (const r of resolved) {
    const cat = r.metadata.category || 'General';
    if (!byCat.has(cat)) byCat.set(cat, []);
    byCat.get(cat).push(r);
  }
  const clusters = [];
  for (const [cat, items] of byCat) {
    if (items.length < THRESHOLD) continue;
    // Confirm they share vocabulary, not just a category label.
    const kwCounts = new Map();
    for (const it of items) for (const k of keywords(it.text)) kwCounts.set(k, (kwCounts.get(k) || 0) + 1);
    const shared = [...kwCounts.entries()].filter(([, n]) => n >= THRESHOLD).map(([k]) => k);
    if (!shared.length) continue;
    clusters.push({
      theme: `${cat} - ${shared.slice(0, 4).join(', ')}`,
      category: cat,
      count: items.length,
      ids: items.map(i => i.id),
      resolutions: items.map(i => i.metadata.resolution),
    });
  }
  return clusters.sort((a, b) => b.count - a.count);
}
