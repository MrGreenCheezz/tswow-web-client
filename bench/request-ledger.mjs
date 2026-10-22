// 22.10 (12.14): what the bench server answered, per route — how many requests, how many distinct URLs, how many were
// repeats of a URL already answered in the same window, and the bytes. The render worker's loading is judged by these
// against the in-page renderer (one fetch per tile, not one per thread). A pure module, so the test imports it.

/** The route a request belongs to: the first one or two path segments that name a resource family. */
export function requestRoute(key) {
  const path = String(key).split('?')[0];
  const parts = path.split('/').filter(Boolean);
  if (parts.length === 0) return '/';
  if ((parts[0] === 'visual' || parts[0] === 'dbc') && parts.length > 1) return `/${parts[0]}/${parts[1]}`;
  if (parts[0] === 'environment' && parts[1] === 'model') return '/environment/model';
  return `/${parts[0]}`;
}

export function createRequestLedger() {
  /** URL → times answered in this window. */
  let seen = new Map();
  let routes = new Map();
  return {
    record(key, bytes) {
      const count = (seen.get(key) ?? 0) + 1;
      seen.set(key, count);
      const route = requestRoute(key);
      const entry = routes.get(route) ?? { count: 0, unique: 0, repeats: 0, bytes: 0 };
      entry.count++;
      if (count === 1) entry.unique++;
      else entry.repeats++;
      entry.bytes += Number(bytes) || 0;
      routes.set(route, entry);
    },
    reset() {
      seen = new Map();
      routes = new Map();
    },
    snapshot() {
      const byRoute = Object.fromEntries([...routes].sort(([a], [b]) => a.localeCompare(b)).map(([route, entry]) => [route, { ...entry }]));
      let count = 0, unique = 0, repeats = 0, bytes = 0;
      for (const entry of routes.values()) {
        count += entry.count; unique += entry.unique; repeats += entry.repeats; bytes += entry.bytes;
      }
      return { count, unique, repeats, bytes, byRoute };
    },
  };
}

/** One console line: totals, then the routes that repeated or carried the most bytes. */
export function requestLedgerLine(snapshot) {
  const mb = (bytes) => (bytes / 1048576).toFixed(2);
  const routes = Object.entries(snapshot.byRoute)
    .filter(([, entry]) => entry.repeats > 0 || entry.bytes >= 1048576)
    .map(([route, entry]) => `${route} ${entry.count}${entry.repeats ? ` (${entry.repeats} repeats)` : ''} ${mb(entry.bytes)} MB`);
  return `${snapshot.count} requests, ${snapshot.unique} URLs, ${snapshot.repeats} repeats, ${mb(snapshot.bytes)} MB${routes.length ? `; ${routes.join(', ')}` : ''}`;
}
