// Station search for the page: a typed query against DMRC's station names, OSM's spelling of them
// and DMRC codes, ignoring case, spaces and punctuation. Pure, for the tests.
const norm = text => (text || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
const words = text => (text || '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);

// Up to `limit` of stations ({code, name, osmName}) matching query, best first: an exact name or
// code, then a name or code starting with it, then a word starting with it, then anywhere in a name.
// Ties go alphabetically.
export function findStations(stations, query, limit = 8) {
  const q = norm(query);
  if (!q) return [];
  const found = [];
  for (const st of stations) {
    const keys = [st.name, st.osmName, st.code].map(norm);
    const rank = keys.includes(q) ? 0 : keys.some(k => k.startsWith(q)) ? 1
      : [st.name, st.osmName].flatMap(words).some(w => w.startsWith(q)) ? 2 : keys.some(k => k.includes(q)) ? 3 : -1;
    if (rank >= 0) found.push([rank, st]);
  }
  return found.sort((a, b) => a[0] - b[0] || a[1].name.localeCompare(b[1].name)).slice(0, limit).map(([, st]) => st);
}
