// Alert capture: polls Prometheus' GET /api/v1/alerts every second while an experiment runs and keeps
// one observation per alert name (pending, firing and resolved times). The fold is pure so it is tested.

export type AlertObs = {
  name: string;
  firstPendingTs: number | null;  // when Prometheus first saw the condition (activeAt when it reports one)
  firstFiringTs: number | null;   // first poll that saw the alert firing (1 s resolution)
  resolvedTs: number | null;      // first poll with the alert gone after it fired; null while firing or if it never fired
};

export type PromAlert = { labels: { alertname: string; [k: string]: string }; state: string; activeAt?: string };

const POLL_MS = 1_000;

// An alert name is active if any of its series is pending or firing, and firing if any series is firing.
export function foldAlerts(state: Map<string, AlertObs>, alerts: PromAlert[], ts: number): Map<string, AlertObs> {
  const byName = new Map<string, { firing: boolean; activeAt: number | null }>();
  for (const a of alerts) {
    const name = a.labels?.alertname;
    if (!name || (a.state !== 'pending' && a.state !== 'firing')) continue;
    const parsed = a.activeAt ? Date.parse(a.activeAt) : NaN;
    const activeAt = Number.isFinite(parsed) ? parsed : null;
    const cur = byName.get(name) ?? { firing: false, activeAt: null };
    cur.firing ||= a.state === 'firing';
    if (activeAt != null && (cur.activeAt == null || activeAt < cur.activeAt)) cur.activeAt = activeAt;
    byName.set(name, cur);
  }

  for (const [name, seen] of byName) {
    const obs = state.get(name) ?? { name, firstPendingTs: null, firstFiringTs: null, resolvedTs: null };
    obs.firstPendingTs ??= seen.activeAt != null && seen.activeAt <= ts ? seen.activeAt : ts;
    if (seen.firing) {
      obs.firstFiringTs ??= ts;
      obs.resolvedTs = null;  // (re)firing: the resolution, if any, is the next one
    }
    state.set(name, obs);
  }
  for (const obs of state.values()) {
    if (!byName.has(obs.name) && obs.firstFiringTs != null && obs.resolvedTs == null) obs.resolvedTs = ts;
  }
  return state;
}

export async function fetchAlerts(promUrl: string): Promise<PromAlert[]> {
  const res = await fetch(`${promUrl}/api/v1/alerts`, { signal: AbortSignal.timeout(2_000) });
  if (!res.ok) throw new Error(`prometheus /api/v1/alerts: HTTP ${res.status}`);
  const body = (await res.json()) as { data?: { alerts?: PromAlert[] } };
  return body.data?.alerts ?? [];
}

// Names of the alerts that are firing right now (used by the known-state restore).
export async function firingNow(promUrl: string): Promise<string[]> {
  const alerts = await fetchAlerts(promUrl);
  return [...new Set(alerts.filter((a) => a.state === 'firing').map((a) => a.labels.alertname))].sort();
}

// Polls until `signal` aborts, then returns one observation per alert name seen. A failed poll is
// skipped and counted in `stats.pollErrors`, so a Prometheus hiccup does not end the capture.
export async function pollAlerts(
  promUrl: string,
  signal: AbortSignal,
  stats: { polls: number; pollErrors: number } = { polls: 0, pollErrors: 0 },
): Promise<AlertObs[]> {
  const state = new Map<string, AlertObs>();
  while (!signal.aborted) {
    const started = Date.now();
    stats.polls++;
    try {
      foldAlerts(state, await fetchAlerts(promUrl), started);
    } catch {
      stats.pollErrors++;
    }
    const wait = Math.max(0, POLL_MS - (Date.now() - started));
    await sleepUnless(wait, signal);
  }
  return [...state.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Sleeps `ms`, or less if `signal` aborts first. The abort listener is removed on timeout, so a long
// poll loop does not pile listeners onto one signal.
export function sleepUnless(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise<void>((resolve) => {
    const onAbort = () => { clearTimeout(t); resolve(); };
    const t = setTimeout(() => { signal.removeEventListener('abort', onAbort); resolve(); }, ms);
    signal.addEventListener('abort', onAbort, { once: true });
  });
}
