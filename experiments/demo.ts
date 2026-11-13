// Live demonstration (Task 18; script and expected output in reports/endterm/DEMO.md).
//   npm run demo                 the default order: app-crash, db-failure, gateway-failure, unauthorized, abuse
//   npm run demo -- full         every demo below
//   npm run demo -- <name>       one demo: app-crash | db-failure | gateway-failure | unauthorized | abuse |
//                                outlier | alerts | node-failure | timetable
// Works in all three modes (npm run up:baseline|midterm|endterm): each demo prints what to expect in the
// deployed mode, so the same commands show the contrast (e.g. baseline accepts the unauthorized payment).
// Every demo prints the Grafana link for its own time window. Synthetic data, local stack only.
// The pure helpers are exported and unit-tested (demo.test.ts); nothing runs on import.
import { closeSync, existsSync, openSync, readSync, statSync } from 'node:fs';
import { resolve } from 'node:path';
import { createInterface } from 'node:readline/promises';
import { fileURLToPath } from 'node:url';
import { ATTACK_PAYMENTS_SQL, SCENARIOS, chaos, chaosHeaders, dc, dotEnv, psql } from './scenarios.ts';
import {
  ATTACK_AMOUNT, REJECTION_SEEDS, abuseSet, attackSet, bruteForceSet, burstSet, send, sendBurst, sendOne,
  summarizeBurst, type HttpReq, type SentResult,
} from './attacks.ts';
import { fetchAlerts, type PromAlert } from './alerts.ts';
import { isMode, type Mode } from './env.ts';
import { dashboardUrl } from './snapshot.ts';
import { login } from './workload.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const EVENTS_PATH = `${ROOT}logs/events.jsonl`;
const GW = 'http://localhost:8080';          // nginx: the entry point clients use
const GRAFANA = 'http://localhost:3000';
const PROM = 'http://localhost:9090';
const PAY = { studentId: 's7', amount: 100 };  // legitimate demo payment (attacks use ATTACK_AMOUNT)
const TOKEN_REUSE_MS = 10 * 60_000;           // tokens live 15 min (app/security/tokens.py TTL_S)
const HEALTH_PORTS: Record<string, number> = {
  'gateway-1': 8081, 'gateway-2': 8082, 'auth-1': 3051, 'student-1': 3011, 'student-2': 3012,
  'payment-1': 3021, 'payment-2': 3022, 'transcript-1': 3031,
};

// ---------------------------------------------------------------- pure helpers (unit-tested)

export const DEFAULT_ORDER = ['app-crash', 'db-failure', 'gateway-failure', 'unauthorized', 'abuse'];
export const DEMOS = [...DEFAULT_ORDER, 'outlier', 'alerts', 'node-failure', 'timetable'];

// What each demo should show in each mode. Printed before the demo runs; these are expectations from
// the design (reports/endterm/DEMO.md), not measurements.
export const EXPECT: Record<string, Record<Mode, string>> = {
  'app-crash': {
    baseline: 'student-1 stays down (restart policy "no"); about half of the reads fail (round robin onto a dead replica)',
    midterm: 'health check + retry hide the crash (2xx); the restart policy brings student-1 back',
    endterm: 'as midterm: 2xx throughout; student-1 restarts on its own',
  },
  'db-failure': {
    baseline: 'reads and writes fail (5xx or 000) while the primary is down',
    midterm: 'reads from the standby (200) or stale cache (203); payments fail fast (503) instead of hanging',
    endterm: 'as midterm; DatabaseDown fires within about 10 s (see the alerts demo)',
  },
  'gateway-failure': {
    baseline: 'nginx has only gateway-1: every request fails (502/000) until it is started again',
    midterm: 'same as baseline: the single gateway is a single point of failure (502/000)',
    endterm: 'nginx fails over to gateway-2: the per-second histogram stays 2xx',
  },
  unauthorized: {
    baseline: 'no authentication: every attack is ACCEPTED (2xx) and the attacker payments reach the DB; no audit lines',
    midterm: 'same as baseline: ACCEPTED, attacker payments reach the DB, no audit lines',
    endterm: 'no token / forged / expired / alg:none -> 401, s7 paying for s8 -> 403; one audit deny line per rid; DB unchanged',
  },
  abuse: {
    baseline: 'no validation or limits: some malformed bodies are accepted (2xx) or crash a handler (5xx); the burst is all 200; brute force all 401',
    midterm: 'same as baseline (no validation, no rate limiting)',
    endterm: 'malformed -> 422/400/413, never 5xx; burst -> 429 with Retry-After; brute force -> 429 after 5-10 tries; every instance stays healthy',
  },
  outlier: {
    baseline: 'no timeout: every request that lands on student-1 takes about 3 s; nothing is ejected',
    midterm: 'each request on student-1 pays the 800 ms attempt timeout before the retry; nothing is ejected (pool-level breaker only)',
    endterm: 'after 3 consecutive timeouts student-1 is ejected (instance_ejected=1 on the gateways) and latency drops back; it is re-probed after 10 s',
  },
  alerts: {
    baseline: 'DatabaseDown fires (monitoring runs in every mode); HighErrorRate likely fires too (reads fail)',
    midterm: 'DatabaseDown fires; HighErrorRate may fire (payments fail, reads are served)',
    endterm: 'DatabaseDown fires; HighErrorRate may fire (payments fail, reads are served)',
  },
  'node-failure': {
    baseline: 'about half of the requests fail while student-1 and payment-1 are dead; they stay down',
    midterm: 'the surviving node carries everything: 2xx throughout',
    endterm: 'as midterm: 2xx throughout',
  },
  timetable: {
    baseline: 'the job stays "running" forever at its last progress after the owner crashes',
    midterm: 'the job resumes from its last checkpoint on the other replica and reaches done',
    endterm: 'as midterm (the job is started with an admin token)',
  },
};

export function resolveDemo(arg: string | undefined): string[] | null {
  if (arg === undefined || arg === 'all') return [...DEFAULT_ORDER];
  if (arg === 'full') return [...DEMOS];
  return DEMOS.includes(arg) ? [arg] : null;
}

// The gateway's /health reports `mode`; a pre-endterm gateway only reports `ft`.
export function modeOf(health: unknown): Mode | null {
  if (!health || typeof health !== 'object') return null;
  const { mode, ft } = health as { mode?: unknown; ft?: unknown };
  if (typeof mode === 'string' && isMode(mode)) return mode;
  if (typeof ft === 'boolean') return ft ? 'midterm' : 'baseline';
  return null;
}

const statusText = (s: number) => (s === 0 ? '000' : String(s));

export function histogram(statuses: number[]): string {
  if (statuses.length === 0) return '(no requests)';
  const counts = new Map<number, number>();
  for (const s of statuses) counts.set(s, (counts.get(s) ?? 0) + 1);
  return [...counts].sort((a, b) => a[0] - b[0]).map(([s, c]) => `${statusText(s)} x${c}`).join('  ');
}

export function latencySummary(ms: number[]): { n: number; avgMs: number; p95Ms: number } {
  if (ms.length === 0) return { n: 0, avgMs: 0, p95Ms: 0 };
  const sorted = ms.slice().sort((a, b) => a - b);
  const avg = sorted.reduce((s, x) => s + x, 0) / sorted.length;
  const p95 = sorted[Math.max(0, Math.ceil(0.95 * sorted.length) - 1)];  // nearest rank
  return { n: sorted.length, avgMs: Math.round(avg), p95Ms: Math.round(p95) };
}

// `ts` is when the client got its answer, so a request that hangs is counted in the second it ended.
export type Rec = { ts: number; status: number; ms: number };

export function bySecond<T extends { ts: number }>(recs: T[], t0: number, seconds: number): { second: number; recs: T[] }[] {
  const out = Array.from({ length: seconds }, (_, second) => ({ second, recs: [] as T[] }));
  for (const r of recs) {
    const s = Math.floor((r.ts - t0) / 1000);
    if (s >= 0 && s < seconds) out[s].recs.push(r);
  }
  return out;
}

// Series of one metric from a Prometheus text page (label values without escapes are enough here).
export function parseGauge(text: string, name: string): { labels: Record<string, string>; value: number }[] {
  const out: { labels: Record<string, string>; value: number }[] = [];
  const line = new RegExp(`^${name}(?:\\{([^}]*)\\})?\\s+(\\S+)`);
  for (const raw of text.split('\n')) {
    const m = line.exec(raw);
    if (!m) continue;
    const labels: Record<string, string> = {};
    for (const l of (m[1] ?? '').matchAll(/([A-Za-z_][A-Za-z0-9_]*)="([^"]*)"/g)) labels[l[1]] = l[2];
    out.push({ labels, value: Number(m[2]) });
  }
  return out;
}

export const ejectedTargets = (metricsText: string): string[] =>
  parseGauge(metricsText, 'instance_ejected').filter((s) => s.value === 1).map((s) => s.labels.target);

export type AuditEvent = {
  kind: 'audit'; rid: string; svc?: string; outcome?: string; reason?: string; status?: number;
  action?: string; sub?: string | null; role?: string | null;
};

// The audit lines (kind=audit) of the given request ids, from a chunk of logs/events.jsonl.
export function auditFor(jsonl: string, rids: Set<string>): AuditEvent[] {
  const out: AuditEvent[] = [];
  for (const line of jsonl.split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'audit' && typeof e.rid === 'string' && rids.has(e.rid)) out.push(e);
    } catch { /* a partial line at the end of the chunk */ }
  }
  return out;
}

// Only fixed fields are printed: the audit line never holds a credential (app/security/audit.py), and
// this formatter does not print anything it was not asked for either.
export function formatAudit(e: AuditEvent): string {
  const who = e.sub ? `${e.sub}${e.role ? ` (${e.role})` : ''}` : '-';
  return `${e.svc ?? '?'}  rid=${e.rid}  ${e.outcome ?? '?'} ${e.status ?? '-'} ${e.reason ?? '?'}  ${e.action ?? '?'}  sub=${who}`;
}

// One line per alert name: firing if any of its series fires, else pending. Firing first.
export function describeAlerts(alerts: PromAlert[]): string[] {
  const state = new Map<string, 'firing' | 'pending'>();
  for (const a of alerts) {
    const name = a.labels?.alertname;
    if (!name || (a.state !== 'firing' && a.state !== 'pending')) continue;
    if (a.state === 'firing' || !state.has(name)) state.set(name, a.state);
  }
  return [...state]
    .sort((a, b) => (a[1] === b[1] ? a[0].localeCompare(b[0]) : a[1] === 'firing' ? -1 : 1))
    .map(([name, s]) => `${s.padEnd(7)}  ${name}`);
}

export function onePerCategory<T extends { category: string }>(set: T[], categories: readonly string[]): T[] {
  return categories.map((c) => set.find((r) => r.category === c)).filter((r): r is T => r !== undefined);
}

// abuseSet sends every rejection seed 10 times; the demo sends each once, plus the other three probes.
export function distinctAbuse(set: HttpReq[]): HttpReq[] {
  let malformed = 0;
  return set.filter((r) => r.category !== 'malformed-payment' || malformed++ < REJECTION_SEEDS.length);
}

export function unauthorizedVerdict(results: { status: number }[], dbDelta: number | null): string {
  const n = results.length;
  const accepted = results.filter((r) => r.status >= 200 && r.status < 300).length;
  const unanswered = results.filter((r) => r.status === 0 || r.status >= 500).length;
  const db = dbDelta === null ? 'DB not checked' : `${dbDelta} attacker payment(s) written to the DB`;
  if (accepted > 0 || (dbDelta ?? 0) > 0) return `ACCEPTED: ${accepted} of ${n} unauthorized requests answered 2xx; ${db}`;
  if (unanswered > 0) return `INCONCLUSIVE: ${unanswered} of ${n} got no answer or a 5xx (is the stack up?); ${db}`;
  return `PASS: all ${n} refused (${histogram(results.map((r) => r.status))}); ${dbDelta === null ? 'DB not checked' : 'DB unchanged'}`;
}

export function grafanaLink(base: string, t0: number, t1: number, padMs = 15_000): string {
  return dashboardUrl(base, t0 - padMs, t1 + padMs, false);
}

// ---------------------------------------------------------------- HTTP and stack helpers

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const sleepUntil = (t: number) => sleep(Math.max(0, t - Date.now()));
const bold = (t: string) => `\x1b[1m${t}\x1b[0m`;
const json = (url: string) =>
  fetch(url, { signal: AbortSignal.timeout(3000) }).then((r) => r.json()).catch(() => ({}));
const text = (url: string, timeoutMs = 1500) =>
  fetch(url, { signal: AbortSignal.timeout(timeoutMs) }).then((r) => (r.ok ? r.text() : null)).catch(() => null);

type Ctx = { mode: Mode; tokens: Map<string, { token: string; at: number }> };

// Endterm only (as run.ts): baseline and midterm have no authentication in the request path, so the
// demo's requests go out without a token there. A failed login is printed and the requests go out
// without a token, so the 401s show on screen instead of the demo stopping.
async function tokenFor(ctx: Ctx, user: string): Promise<string | undefined> {
  if (ctx.mode !== 'endterm') return undefined;
  const cached = ctx.tokens.get(user);
  if (cached && Date.now() - cached.at < TOKEN_REUSE_MS) return cached.token;
  try {
    const token = await login(GW, user, dotEnv().DEMO_PASSWORD ?? '');
    ctx.tokens.set(user, { token, at: Date.now() });
    return token;
  } catch (e) {
    console.log(`  ! ${(e as Error).message}: sending without a token (expect 401)`);
    return undefined;
  }
}

async function authHeaders(ctx: Ctx, user = 'bursar'): Promise<Record<string, string>> {
  const token = await tokenFor(ctx, user);
  return token ? { authorization: `Bearer ${token}` } : {};
}

type Op = 'students' | 'transcripts' | 'payments';

async function request(auth: Record<string, string>, op: Op, timeoutMs = 3000): Promise<Rec> {
  const started = Date.now();
  const pay = op === 'payments';
  try {
    const r = await fetch(`${GW}/api/${op}${pay ? '' : '/s7'}`, {
      method: pay ? 'POST' : 'GET',
      // every payment carries its own Idempotency-Key (endterm rejects a payment without one: 400)
      headers: { ...auth, ...(pay ? { 'content-type': 'application/json', 'idempotency-key': crypto.randomUUID() } : {}) },
      body: pay ? JSON.stringify(PAY) : undefined,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await r.arrayBuffer().catch(() => undefined);
    return { ts: Date.now(), status: r.status, ms: Date.now() - started };
  } catch {
    return { ts: Date.now(), status: 0, ms: Date.now() - started };  // hung or refused
  }
}

async function probe(auth: Record<string, string>, n: number, op: Op): Promise<string> {
  const statuses: number[] = [];
  for (let i = 0; i < n; i++) statuses.push((await request(auth, op)).status);
  return histogram(statuses);
}

// Client traffic in the background: `workers` loops over `ops` until stopped.
function traffic(auth: Record<string, string>, ops: Op[], workers: number, timeoutMs = 3000) {
  const recs: Rec[] = [];
  let stopped = false;
  const loops = Array.from({ length: workers }, async (_, w) => {
    for (let i = w; !stopped; i++) {
      recs.push(await request(auth, ops[i % ops.length], timeoutMs));
      await sleep(20);
    }
  });
  return { recs, stop: async () => { stopped = true; await Promise.allSettled(loops); } };
}

// Prints one line per second of the background traffic; runs each action at its second (not awaited,
// so the traffic keeps flowing while docker works). Returns once every action has finished.
async function timeline(opts: {
  t0: number; seconds: number; recs: Rec[];
  actions: Record<number, [string, () => Promise<unknown>]>;
  extra?: () => Promise<string>;
}): Promise<void> {
  const pending: Promise<unknown>[] = [];
  for (let s = 0; s < opts.seconds; s++) {
    const action = opts.actions[s];
    if (action) {
      console.log(`  t+${String(s).padStart(2)}s  >> ${action[0]}`);
      pending.push(action[1]().catch((e) => console.log(`  ! ${action[0]}: ${(e as Error).message}`)));
    }
    await sleepUntil(opts.t0 + (s + 1) * 1000);
    const [bucket] = bySecond(opts.recs, opts.t0 + s * 1000, 1);
    const lat = latencySummary(bucket.recs.map((r) => r.ms));
    const extra = opts.extra ? `   ${await opts.extra()}` : '';
    console.log(`  t+${String(s).padStart(2)}s  ${histogram(bucket.recs.map((r) => r.status)).padEnd(28)}` +
      ` avg ${String(lat.avgMs).padStart(4)} ms  p95 ${String(lat.p95Ms).padStart(4)} ms${extra}`);
  }
  await Promise.allSettled(pending);
}

function readSince(offset: number): string {
  if (!existsSync(EVENTS_PATH)) return '';
  const size = statSync(EVENTS_PATH).size;
  if (size <= offset) return '';
  const fd = openSync(EVENTS_PATH, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  return buf.toString('utf8');
}
const eventsSize = () => (existsSync(EVENTS_PATH) ? statSync(EVENTS_PATH).size : 0);

async function countAttackPayments(): Promise<number | null> {
  try {
    const n = Number(await psql(ATTACK_PAYMENTS_SQL));
    return Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

async function healthLine(): Promise<string> {
  const checks = await Promise.all(Object.entries(HEALTH_PORTS).map(async ([name, port]) =>
    `${name} ${(await text(`http://localhost:${port}/health`, 2000)) !== null ? 'up' : 'DOWN'}`));
  return checks.join(', ');
}

const short = (target: string) => target.replace(/^https?:\/\//, '').replace(/:\d+$/, '');

// ---------------------------------------------------------------- the demos

async function appCrash(ctx: Ctx) {
  const auth = await authHeaders(ctx);
  console.log(`  before   students: ${await probe(auth, 20, 'students')}`);
  await SCENARIOS['app-crash'].inject();
  console.log('  >> student-1 crashed (POST /chaos/crash)');
  await sleep(500);
  console.log(`  during   students: ${await probe(auth, 40, 'students')}`);
  console.log(`           gateway view: ${JSON.stringify((await json(`${GW}/health`)).instances ?? {})}`);
  await sleep(8000);
  console.log(`  after 8s students: ${await probe(auth, 20, 'students')}`);
  await SCENARIOS['app-crash'].repair();
}

async function dbFailure(ctx: Ctx) {
  const auth = await authHeaders(ctx);
  const line = async (n: number) =>
    `students: ${await probe(auth, n, 'students')}   transcripts: ${await probe(auth, 5, 'transcripts')}   payments: ${await probe(auth, 3, 'payments')}`;
  console.log(`  before   ${await line(10)}`);
  await SCENARIOS['db-failure'].inject();
  console.log('  >> postgres-primary stopped');
  await sleep(2000);
  console.log(`  during   ${await line(5)}`);
  await SCENARIOS['db-failure'].repair();
  console.log('  >> postgres-primary started');
  await sleep(6000);
  console.log(`  after    ${await line(10)}`);
}

async function gatewayFailure(ctx: Ctx) {
  const auth = await authHeaders(ctx);
  const t0 = Date.now();
  const tr = traffic(auth, ['students', 'students', 'payments'], 4);
  await timeline({
    t0, seconds: 16, recs: tr.recs,
    actions: {
      3: ['kill gateway-1 (docker compose kill)', () => SCENARIOS['gateway-failure'].inject()],
      11: ['start gateway-1', () => SCENARIOS['gateway-failure'].repair()],
    },
  });
  await tr.stop();
  const during = tr.recs.filter((r) => r.ts >= t0 + 3000 && r.ts < t0 + 11_000).map((r) => r.status);
  console.log(`  while gateway-1 was down: ${histogram(during)}`);
  console.log(`  instances now: ${await healthLine()}`);
}

async function outlier(ctx: Ctx) {
  const auth = await authHeaders(ctx);
  const ejected = async () => {
    const pages = await Promise.all([8081, 8082].map((p) => text(`http://localhost:${p}/metrics`, 800)));
    return 'ejected: ' + pages.map((page, i) => `gw${i + 1}=${page === null ? '?' : ejectedTargets(page).map(short).join(',') || '-'}`).join(' ');
  };
  const t0 = Date.now();
  const tr = traffic(auth, ['students'], 4, 5000);  // 5 s client timeout: baseline's 3 s answers still arrive
  try {
    await timeline({
      t0, seconds: 24, recs: tr.recs, extra: ejected,
      actions: {
        2: ['student-1 slow: +3000 ms per request (/chaos latencyMs)', () => chaos(3011, { latencyMs: 3000 })],
        18: ['student-1 healthy again (latencyMs 0)', () => chaos(3011, { latencyMs: 0 })],
      },
    });
  } finally {
    await tr.stop();
    await chaos(3011, { latencyMs: 0 });
  }
  console.log('  the gauge is instance_ejected{target} on each gateway\'s /metrics (Grafana panel "Outlier ejection")');
}

const ATTACK_LABELS: Record<string, string> = {
  'no-token': 'no token',
  'forged-signature': 'forged signature (admin claims)',
  'expired-token': 'expired token (admin claims)',
  'alg-none': 'alg:none token (admin claims)',
  'pay-for-other-student': "student s7 pays for s8",
};

async function unauthorized(ctx: Ctx) {
  const env = dotEnv();
  const s7Token = await tokenFor(ctx, 's7');
  const tag = `demo-${Date.now()}`;
  const set = attackSet({ tag, s7Token, jwtSecret: env.JWT_SECRET, nowS: Math.floor(Date.now() / 1000) });
  const picks = onePerCategory(set, Object.keys(ATTACK_LABELS));
  const before = await countAttackPayments();
  const offset = eventsSize();
  const results: SentResult[] = [];
  console.log(`  each attack is POST /api/payments {studentId: "s8", amount: ${ATTACK_AMOUNT}}`);
  if (ctx.mode !== 'endterm') console.log(`  (${ctx.mode}: no login, so the s7 attack goes out without a token as well)`);
  for (const req of picks) {
    const r = await sendOne(GW, req);
    results.push(r);
    console.log(`  ${ATTACK_LABELS[req.category].padEnd(32)} -> ${statusText(r.status)}   rid=${req.rid}`);
  }
  await sleep(1000);  // let the gateways' audit lines reach the shared log
  const audit = auditFor(readSince(offset), new Set(picks.map((r) => r.rid)));
  console.log(`  audit lines for these rids (${EVENTS_PATH.replace(ROOT, '')}):`);
  if (audit.length === 0) console.log(`    (none${ctx.mode === 'endterm' ? '' : `: ${ctx.mode} has no policy enforcement point`})`);
  for (const e of audit) console.log(`    ${formatAudit(e)}`);
  const after = await countAttackPayments();
  const delta = before !== null && after !== null ? after - before : null;
  console.log(`  attacker payments in the DB (amount ${ATTACK_AMOUNT}): before ${before ?? '?'}, after ${after ?? '?'}`);
  console.log(`  ${bold(unauthorizedVerdict(results, delta))}`);
  console.log(`  follow one request through every hop: grep ${picks[0]?.rid} logs/events.jsonl`);
}

async function abuse(ctx: Ctx) {
  const staffToken = await tokenFor(ctx, 'bursar');
  const s7Token = await tokenFor(ctx, 's7');
  const tag = `demo-${Date.now()}`;

  const reqs = distinctAbuse(abuseSet({ tag, staffToken }));
  const malformed = await send(GW, reqs, 5_000);
  console.log(`  malformed input (${malformed.length} requests: ${REJECTION_SEEDS.length} bad payment bodies, invalid JSON, 1 MiB body, bad path):`);
  console.log(`    ${histogram(malformed.map((r) => r.status))}`);
  malformed.forEach((r, i) => {
    if (r.status >= 400 && r.status < 500) return;
    const body = reqs[i].body ?? reqs[i].path;
    console.log(`    ${statusText(r.status)} ${r.status === 0 || r.status >= 500 ? 'SERVER ERROR' : 'ACCEPTED'}  ${body.length > 70 ? body.slice(0, 67) + '...' : body}`);
  });

  const burst = await sendBurst(GW, burstSet({ tag, token: s7Token }), 2_000);
  const b = summarizeBurst(burst.results, burst.elapsedMs);
  const retryAfter = burst.results.find((r) => r.status === 429)?.retryAfter;
  console.log(`  burst: ${b.sent} GETs of /api/students/s7 as s7 in ${b.elapsedMs} ms`);
  console.log(`    2xx ${b.ok}   429 ${b.limited} (Retry-After on ${b.limitedWithRetryAfter}${retryAfter ? `, e.g. "${retryAfter}"` : ''})   other ${b.other}`);

  const brute = await send(GW, bruteForceSet({ tag }).slice(0, 20));
  const first429 = brute.findIndex((r) => r.status === 429);
  console.log(`  login brute force: 20 wrong passwords for s7: ${histogram(brute.map((r) => r.status))}` +
    (first429 >= 0 ? `   (first 429 at attempt ${first429 + 1})` : ''));

  await sleep(1000);
  console.log(`  instances after the abuse: ${await healthLine()}`);
}

async function alerts(ctx: Ctx) {
  const auth = await authHeaders(ctx);
  const tr = traffic(auth, ['students', 'transcripts', 'payments'], 2);  // the ratio rules need traffic
  const poll = async () => fetchAlerts(PROM).then(describeAlerts).catch(() => null);
  console.log(`  alerts before: ${(await poll())?.join(' | ') || '(none firing or pending)'}   (${PROM}/alerts)`);
  const t0 = Date.now();
  let last = '';
  let detectedMs: number | null = null;
  try {
    await SCENARIOS['db-failure'].inject();
    console.log(`  t+${((Date.now() - t0) / 1000).toFixed(1)}s  >> postgres-primary stopped`);
    while (Date.now() - t0 < 40_000 && (detectedMs === null || Date.now() - t0 < detectedMs + 8_000)) {
      const lines = await poll();
      const now = ((Date.now() - t0) / 1000).toFixed(1);
      const shown = lines === null ? '(Prometheus not reachable)' : lines.join(' | ') || '(none)';
      if (shown !== last) console.log(`  t+${now}s  ${shown}`);
      last = shown;
      if (detectedMs === null && lines?.includes('firing   DatabaseDown')) {
        detectedMs = Date.now() - t0;
        console.log(`  ${bold(`DatabaseDown firing ${(detectedMs / 1000).toFixed(1)} s after the stop (1 s polling)`)}`);
      }
      await sleep(1000);
    }
    if (detectedMs === null) console.log('  ! DatabaseDown did not fire within 40 s');
  } finally {
    await SCENARIOS['db-failure'].repair();
  }
  const t1 = Date.now();
  console.log(`  t+${((t1 - t0) / 1000).toFixed(1)}s  >> postgres-primary started`);
  while (Date.now() - t1 < 60_000) {
    const lines = await poll();
    const shown = lines === null ? '(Prometheus not reachable)' : lines.join(' | ') || '(none)';
    if (shown !== last) console.log(`  t+${((Date.now() - t0) / 1000).toFixed(1)}s  ${shown}`);
    last = shown;
    if (lines !== null && !lines.some((l) => l.endsWith(' DatabaseDown'))) {
      console.log(`  ${bold(`DatabaseDown resolved ${((Date.now() - t1) / 1000).toFixed(1)} s after the restart`)}`);
      break;
    }
    await sleep(1000);
  }
  await tr.stop();
  console.log(`  client traffic during the demo: ${histogram(tr.recs.map((r) => r.status))}`);
}

async function nodeFailure(ctx: Ctx) {
  const auth = await authHeaders(ctx);
  console.log(`  before   students: ${await probe(auth, 20, 'students')}   payments: ${await probe(auth, 10, 'payments')}`);
  await SCENARIOS['node-failure'].inject();
  console.log('  >> student-1 and payment-1 killed');
  await sleep(500);
  console.log(`  during   students: ${await probe(auth, 20, 'students')}   payments: ${await probe(auth, 10, 'payments')}`);
  await SCENARIOS['node-failure'].repair();
  await sleep(5000);
  console.log(`  after    students: ${await probe(auth, 20, 'students')}   payments: ${await probe(auth, 10, 'payments')}`);
}

async function timetable(ctx: Ctx) {
  const auth = await authHeaders(ctx, 'admin');  // endterm: only admin may start a timetable job
  const term = `demo-${Date.now()}`;
  const job = await fetch(`${GW}/api/timetables`, {
    method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ term }),
    signal: AbortSignal.timeout(5000),
  }).then((r) => r.json()).catch(() => ({}));
  const owner: string | undefined = job.owner;
  if (!owner?.startsWith('timetable-')) {
    console.log(`  could not start a job (${JSON.stringify(job)}) -- is the platform up?`);
    return;
  }
  const show = async () => {
    const j = await fetch(`${GW}/api/timetables/${term}`, { headers: auth, signal: AbortSignal.timeout(3000) })
      .then((r) => r.json()).catch(() => ({}));
    return `state=${j.state}  owner=${j.owner}  progress=${j.progress}`;
  };
  console.log(`  job ${term} started on ${owner}`);
  await sleep(2000);
  console.log(`  t+2s   ${await show()}`);
  await fetch(`http://localhost:304${owner.slice(-1)}/chaos/crash`, { method: 'POST', headers: chaosHeaders() })  // timetable-1 -> :3041
    .catch(() => {});
  console.log(`  >> ${owner} crashed`);
  for (let i = 3; i <= 16; i++) {
    await sleep(1000);
    console.log(`  t+${i}s  ${await show()}`);
  }
  await dc('start', owner);
}

const RUN: Record<string, { title: string; run: (ctx: Ctx) => Promise<void> }> = {
  'app-crash': { title: 'Application crash: student-1 kills its own process', run: appCrash },
  'db-failure': { title: 'Database failure: the PostgreSQL primary is stopped', run: dbFailure },
  'gateway-failure': { title: 'Gateway failure: gateway-1 is killed under live traffic', run: gatewayFailure },
  unauthorized: { title: 'Unauthorized access: missing, forged, expired and alg:none tokens; s7 pays for s8', run: unauthorized },
  abuse: { title: 'Abuse: malformed input, request burst, login brute force', run: abuse },
  outlier: { title: 'Outlier ejection: student-1 becomes slow', run: outlier },
  alerts: { title: 'Alerting: Prometheus alerts during a database failure', run: alerts },
  'node-failure': { title: 'Node failure: student-1 and payment-1 are killed together', run: nodeFailure },
  timetable: { title: 'Timetable job interrupted: the instance generating it crashes mid-job', run: timetable },
};

async function runDemo(ctx: Ctx, name: string): Promise<void> {
  console.log(`\n${bold(`== ${RUN[name].title} ==`)}`);
  console.log(`  expected in ${ctx.mode}: ${EXPECT[name][ctx.mode]}`);
  const t0 = Date.now();
  try {
    await RUN[name].run(ctx);
  } catch (e) {
    console.log(`  ! ${name} failed: ${(e as Error).message}`);
  }
  console.log(`  Grafana (this step): ${grafanaLink(GRAFANA, t0, Date.now())}`);
}

async function main(): Promise<void> {
  const names = resolveDemo(process.argv[2]);
  if (!names) {
    console.log(`usage: npm run demo [-- all | full | ${DEMOS.join(' | ')}]`);
    process.exit(1);
  }
  const mode = modeOf(await json(`${GW}/health`));
  if (!mode) {
    console.log('deployed mode: not running -- start one with npm run up:baseline | up:midterm | up:endterm');
    process.exit(1);
  }
  console.log(`deployed mode: ${bold(mode)}   Grafana ${GRAFANA}/d/university   Prometheus ${PROM}/alerts`);
  const ctx: Ctx = { mode, tokens: new Map() };
  const rl = names.length > 1 && process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  for (const [i, name] of names.entries()) {
    await runDemo(ctx, name);
    if (rl && i < names.length - 1) await rl.question('\npress Enter for the next scenario ');
  }
  rl?.close();
  process.exit(0);  // keep-alive sockets must not hold the demo open
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
