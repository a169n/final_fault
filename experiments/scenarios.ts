import { execFile } from 'node:child_process';
import { existsSync, openSync, readFileSync, readSync, closeSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { chaosHeaders as headersFor, parseEnv } from './env.ts';
import { criteria, type Criterion, type ExpectedAlerts } from './acceptance.ts';
import {
  abuseSet, attackSet, bruteForceSet, burstSet, send, sendBurst, summarizeBurst,
  ATTACK_AMOUNT, ATTACK_PREFIX, type SentResult,
} from './attacks.ts';
import { login, type Rec } from './workload.ts';
import { dbWriter, restoreFromBackup, type RestoreReport } from './restore.ts';
import { restartedBetween, snapshotContainers, type ContainerState } from './resources.ts';

const exec = promisify(execFile);
const ROOT = fileURLToPath(new URL('..', import.meta.url));
const GATEWAY = 'http://localhost:8080';
const EVENTS_PATH = `${ROOT}logs/events.jsonl`;

export const dc = async (...args: string[]): Promise<void> => {
  await exec('docker', ['compose', ...args], { cwd: ROOT }).catch((e) => {
    console.error(`  ! docker compose ${args.join(' ')}: ${e.message.split('\n')[0]}`);
  });
};

// Operator queries run as the superuser over `docker exec` (pg_hba.conf: local postgres trust), on
// purpose: resetting state is an operator action on the host, and the application role app_rw has no
// TRUNCATE or DELETE (least privilege, Task 12). Never give app_rw these rights.
// They go to whichever node accepts writes: after a failover (final) that is not postgres-primary.
export const psql = async (sql: string): Promise<string> => {
  const { stdout } = await exec(
    'docker',
    ['compose', 'exec', '-T', await dbWriter(), 'psql', '-U', 'postgres', '-d', 'university', '-v', 'ON_ERROR_STOP=1',
      '-t', '-A', '-F', '|', '-c', sql],
    { cwd: ROOT, maxBuffer: 64 * 1024 * 1024 },
  );
  return stdout.trim();
};

// .env (written by npm run up:<mode>), read on each call so a regenerated .env is picked up.
export const dotEnv = (): Record<string, string> => {
  const file = `${ROOT}.env`;
  return existsSync(file) ? parseEnv(readFileSync(file, 'utf8')) : {};
};

// x-chaos-token from .env: the endterm services refuse /chaos* without it (403), baseline and midterm ignore it.
export const chaosHeaders = (): Record<string, string> => headersFor(dotEnv());

// true when the instance accepted the configuration (2xx)
export const chaos = async (port: number, body: unknown): Promise<boolean> =>
  fetch(`http://localhost:${port}/chaos`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...chaosHeaders() },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(3000),
  }).then((r) => r.ok).catch(() => false);

// The service replicas that expose /chaos (student, payment, transcript, timetable), by host port.
export const CHAOS_PORTS = [3011, 3012, 3021, 3022, 3031, 3041, 3042];
export const CHAOS_RESET = { latencyMs: 0, failRate: 0, crashAfterCheckpoint: false };

const crash = async (port: number): Promise<void> => {
  await fetch(`http://localhost:${port}/chaos/crash`, {
    method: 'POST',
    headers: chaosHeaders(),
    signal: AbortSignal.timeout(3000),
  }).catch(() => {});
};

export type Scenario = {
  name: string;
  title: string;
  kind: 'fault' | 'security' | 'monitoring';
  durationMs: number;
  injectAtMs: number;
  repairAtMs: number;
  inject: () => Promise<unknown>;
  repair: () => Promise<unknown>;
  rampAtMs?: number;
  rampConcurrency?: number;
  expectedAlerts: ExpectedAlerts;  // mustFire / mayFire (reports/final/ALERTS.md); anything else is unexpected
  acceptance: Criterion[];         // evaluated on metrics.json after the run (acceptance.ts)
  // checks after the run (DB queries, controller state); stored in metrics.json. `ctx` is the workload log.
  verify?: (ctx: VerifyCtx) => Promise<Record<string, unknown>>;
  concurrency?: number;            // workload workers (default 10)
};

export type VerifyCtx = { recs: Rec[]; t0: number; t1: number };

// What the database controller sees: who accepts writes and how many standbys stream from it.
export async function dbState(): Promise<{ writer: string | null; standbys: number | null; timeline: number | null; sync: boolean | null }> {
  try {
    const res = await fetch('http://localhost:3061/health', { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { writer?: string | null; nodes?: Record<string, { standbys?: number; timeline?: number; sync?: boolean }> };
    const w = body.writer ? body.nodes?.[body.writer] : undefined;
    return { writer: body.writer ?? null, standbys: w?.standbys ?? null, timeline: w?.timeline ?? null, sync: w?.sync ?? null };
  } catch {
    return { writer: null, standbys: null, timeline: null, sync: null };
  }
}

// A redundancy check that waits: after a repair the restarted node may still be cloning the primary.
async function dbStateWhenSettled(waitMs = 30_000): Promise<Awaited<ReturnType<typeof dbState>>> {
  const deadline = Date.now() + waitMs;
  let state = await dbState();
  while (!(state.writer && (state.standbys ?? 0) >= 1) && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 1000));
    state = await dbState();
  }
  return state;
}

const D = 70_000;
const INJECT = 20_000;
const REPAIR = 45_000;

// ---- helpers shared by the security scenarios (E9, E10) ----

const nowS = () => Math.floor(Date.now() / 1000);
const num = (s: string | null): number | null => (s == null || s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Count audit deny lines written since `offset`, whose rid matches one the attack sent (bounded read:
// logs/events.jsonl is large, so only the bytes appended during the attack are parsed).
function auditDeniesSince(offset: number, rids: Set<string>): number {
  if (!existsSync(EVENTS_PATH)) return 0;
  const size = statSync(EVENTS_PATH).size;
  if (size <= offset) return 0;
  const fd = openSync(EVENTS_PATH, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  let count = 0;
  for (const line of buf.toString('utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (e.kind === 'audit' && e.outcome === 'deny' && typeof e.rid === 'string' && rids.has(e.rid)) count++;
    } catch { /* partial line */ }
  }
  return count;
}

const statusCounts = (rs: SentResult[]): Record<string, number> => {
  const c: Record<string, number> = {};
  for (const r of rs) c[String(r.status)] = (c[String(r.status)] ?? 0) + 1;
  return c;
};
const denied = (rs: SentResult[]) => rs.filter((r) => r.status === 401 || r.status === 403).length;
const byCategory = (rs: SentResult[]): Record<string, Record<string, number>> => {
  const out: Record<string, SentResult[]> = {};
  for (const r of rs) (out[r.category] ??= []).push(r);
  return Object.fromEntries(Object.entries(out).map(([c, xs]) => [c, statusCounts(xs)]));
};

// A login the attack depends on. The error is kept, not swallowed: without the token the requests go
// out unauthenticated and get a 401 before the control under test runs, so the run records it and
// the category-aware criteria (acceptance.ts) fail on that evidence instead of passing for the wrong reason.
export type LoginOutcome = { ok: boolean; error?: string };
async function tryLogin(username: string, password: string): Promise<{ token?: string; outcome: LoginOutcome }> {
  try {
    return { token: await login(GATEWAY, username, password), outcome: { ok: true } };
  } catch (e) {
    console.error(`  ! login as ${username} failed: ${(e as Error).message}`);
    return { outcome: { ok: false, error: (e as Error).message } };
  }
}

// Attacker payments in the DB, by the attack's distinctive amount (attacks.ts ATTACK_AMOUNT, which no
// legitimate request uses) OR its attack- key. The amount is what makes it mode-independent: baseline
// stores a fresh UUID instead of the Idempotency-Key (idempotency.payment_key), so a key-only count
// would read 0 there even when forged/expired/no-token payments succeeded. The DB is truncated before
// every run (run.ts), so only this run's rows are counted. Any state counts: a pending row reached the DB too.
export const ATTACK_PAYMENTS_SQL =
  `select count(*) from payments where amount = ${ATTACK_AMOUNT} or idempotency_key like '${ATTACK_PREFIX}%'`;

// E9: tokens that must not work and a real student token used beyond its rights. The attacks run
// during the legitimate workload (inject at 20 s); verify() checks the DB and the audit log after.
function unauthorizedAccess(): Scenario {
  let captured: SentResult[] = [];
  let auditOffset = 0;
  let rids = new Set<string>();
  let logins: Record<string, LoginOutcome> = {};
  return {
    name: 'unauthorized-access',
    kind: 'security',
    title: 'Unauthorized access (forged, expired and alg:none tokens; privilege escalation)',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    expectedAlerts: { mustFire: ['AuthFailureSpike'], mayFire: [] },
    acceptance: [
      criteria.allAttacksDenied(),
      criteria.noAttackerPaymentsInDb(),
      criteria.noEvilStudents(),
      criteria.auditDeniesAtLeastAttempts(),
      criteria.ledgerBalanced(),
      criteria.availabilityAtLeast(0.999),
    ],
    inject: async () => {
      const env = dotEnv();
      auditOffset = existsSync(EVENTS_PATH) ? statSync(EVENTS_PATH).size : 0;
      const s7 = await tryLogin('s7', env.DEMO_PASSWORD ?? '');
      logins = { s7: s7.outcome };
      const s7Token = s7.token;
      const set = attackSet({ tag: `e9-${Date.now()}`, s7Token, jwtSecret: env.JWT_SECRET, nowS: nowS() });
      rids = new Set(set.map((a) => a.rid));
      captured = await send(GATEWAY, set, 5_000, 30);  // paced: s7's own attacks stay under its quota
    },
    repair: async () => {},  // nothing to repair: the attacks leave no state behind if the controls hold
    verify: async () => {
      const attempts = captured.length;
      const attackPaymentsInDb = num(await psql(ATTACK_PAYMENTS_SQL));
      const evilStudents = num(await psql("select count(*) from students where id like 'evil-%'"));
      await sleep(1_000);  // let the last audit lines flush to the shared log
      const auditDenies = auditDeniesSince(auditOffset, rids);
      return {
        attacks: { attempts, denied: denied(captured), statusCounts: statusCounts(captured), byCategory: byCategory(captured) },
        attackPaymentsInDb, evilStudents, auditDenies, logins,
      };
    },
  };
}

// E10: malformed input (no 5xx), a request burst (429 after the quota) and a login brute force
// (429 after 5). Run during the legitimate workload; verify() summarizes each and checks the stack
// stayed up.
function abuse(): Scenario {
  let malformed: SentResult[] = [];
  let burst: { results: SentResult[]; elapsedMs: number } = { results: [], elapsedMs: 0 };
  let brute: SentResult[] = [];
  let bruteElapsed = 0;
  let logins: Record<string, LoginOutcome> = {};
  let before: ContainerState[] | null = null;
  return {
    name: 'abuse',
    kind: 'security',
    title: 'Abuse (malformed input, request burst, login brute force)',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    expectedAlerts: { mustFire: ['AuthFailureSpike'], mayFire: ['InstanceDown'] },
    acceptance: [
      criteria.malformedNo5xx(),
      criteria.burstLimited(),
      criteria.bruteForceLimited(),
      criteria.instancesStayUp(),
      criteria.ledgerBalanced(),
      criteria.availabilityAtLeast(0.999),
    ],
    inject: async () => {
      const env = dotEnv();
      const tag = `e10-${Date.now()}`;
      before = await snapshotContainers();  // identity of every container before the abuse starts
      const staff = await tryLogin('bursar', env.DEMO_PASSWORD ?? '');
      const s7 = await tryLogin('s7', env.DEMO_PASSWORD ?? '');
      logins = { staff: staff.outcome, s7: s7.outcome };
      const staffToken = staff.token;
      const s7Token = s7.token;
      malformed = await send(GATEWAY, abuseSet({ tag, staffToken }), 5_000, 5);  // 4xx expected, never 5xx
      burst = await sendBurst(GATEWAY, burstSet({ tag, token: s7Token }), 2_000);  // 1000 in ~2 s
      const started = Date.now();
      brute = await send(GATEWAY, bruteForceSet({ tag }));  // 50 wrong-password logins
      bruteElapsed = Date.now() - started;
    },
    repair: async () => {},
    verify: async () => {
      const serverErrors = malformed.filter((r) => r.status >= 500 || r.status === 0).length;
      const instances = await instancesUp(before);
      return {
        malformed: { sent: malformed.length, serverErrors, statusCounts: statusCounts(malformed) },
        burst: summarizeBurst(burst.results, burst.elapsedMs),
        bruteForce: { statuses: brute.map((r) => r.status), elapsedMs: bruteElapsed },
        instances,
        logins,
      };
    },
  };
}

// Every application instance answers /health after the abuse, and no container restarted, stopped or
// disappeared between the snapshot taken when the abuse started and now (abuse must not take one down;
// with RESTART_POLICY=unless-stopped a crashed one is back before /health is probed, hence the diff).
// `restarted` is null when either snapshot could not be taken: missing evidence, not a pass.
async function instancesUp(before: ContainerState[] | null): Promise<{ allUpAfter: boolean; restarted: string[] | null; containersChecked: number }> {
  const ports: Record<string, number> = {
    'gateway-1': 8081, 'gateway-2': 8082, 'student-1': 3011, 'student-2': 3012,
    'payment-1': 3021, 'payment-2': 3022, 'transcript-1': 3031, 'timetable-1': 3041, 'timetable-2': 3042, 'auth-1': 3051,
  };
  const checks = await Promise.all(Object.entries(ports).map(async ([name, p]) =>
    [name, await fetch(`http://localhost:${p}/health`, { signal: AbortSignal.timeout(2_000) }).then((r) => r.ok).catch(() => false)] as const));
  const after = await snapshotContainers();
  const restarted = before && after ? restartedBetween(before, after) : null;
  return { allUpAfter: checks.every(([, ok]) => ok), restarted, containersChecked: before?.length ?? 0 };
}

// E2: the node that accepts writes is stopped. Baseline: every DB-backed route fails until the
// operator restarts it. Midterm/endterm: reads move to the standby, writes fail fast until the repair.
// Final: the controller promotes the standby (H8), so writes come back before the repair; the repair
// then restarts the old primary, which rejoins as a standby (config/postgres/scripts/node.sh).
function dbFailure(): Scenario {
  let stopped = 'postgres-primary';
  return {
    name: 'db-failure',
    kind: 'fault',
    title: 'Database failure (the primary is stopped)',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => { stopped = await dbWriter(); await dc('stop', stopped); },
    repair: () => dc('start', stopped),
    expectedAlerts: {
      mustFire: ['DatabaseDown'],
      mayFire: ['HighErrorRate', 'InstanceDown', 'DatabaseNoWriter', 'DatabaseFailover', 'DatabaseRedundancyLost'],
    },
    acceptance: [
      criteria.alertDetectedWithin('DatabaseDown', 10_000),
      criteria.readAvailabilityAtLeast(0.99),
      criteria.writePathRecoversWithin(10_000),
      criteria.noDuplicateCharges(),
      criteria.noLostRecords(),
      criteria.ledgerBalanced(),
      criteria.standbyStreamingAtEnd(),
    ],
    verify: async () => ({ stopped, db: await dbStateWhenSettled() }),
  };
}

// E11: the payment records are destroyed by a privileged statement (an operator error, a bad
// migration or a compromised superuser): TRUNCATE payments and every balance set to 0. Replication
// copies the damage to the standby at once, so redundancy does not help; only a backup does (H9).
// Repair: restore the newest backup and merge it back (experiments/restore.ts). Baseline, midterm
// and endterm take no backups, so there is nothing to restore and the records stay lost.
const ACKED_PAYMENT = (r: Rec) => r.op === 'payments' && (r.status === 201 || (r.status === 200 && r.payState === 'completed'));

function dataLoss(): Scenario {
  let wipeTs = 0;
  let restore: RestoreReport | null = null;
  return {
    name: 'data-loss',
    kind: 'fault',
    title: 'Data loss (payment records destroyed) and restore from backup',
    durationMs: 90_000, injectAtMs: 40_000, repairAtMs: 55_000,
    inject: async () => {
      wipeTs = Date.now();
      await psql('TRUNCATE payments; UPDATE students SET balance = 0;');
    },
    // the operator knows when the records vanished (PaymentRecordsLost) and takes the last backup from before it
    repair: async () => { restore = await restoreFromBackup({ beforeMs: wipeTs }); },
    expectedAlerts: { mustFire: ['PaymentRecordsLost'], mayFire: [] },
    acceptance: [
      criteria.alertDetectedWithin('PaymentRecordsLost', 20_000),
      criteria.restoreSucceeded(),
      criteria.lossWindowAtMost(20_000),
      criteria.ledgerBalanced(),
      criteria.noDuplicateChargesInDb(),
      criteria.availabilityAtLeast(0.999),
    ],
    verify: async ({ recs }) => {
      // Acknowledged before the wipe (the answer arrived before it) and what is left of them now.
      const before = recs.filter((r) => ACKED_PAYMENT(r) && r.ts + r.ms < wipeTs);
      const after = recs.filter((r) => ACKED_PAYMENT(r) && r.ts >= wipeTs);
      const keys = new Set((await psql("select idempotency_key from payments where state = 'completed'")).split('\n').filter(Boolean));
      const keyLevel = before.some((r) => keys.has(String(r.intent))) || after.some((r) => keys.has(String(r.intent)));
      let lost: number;
      let lossWindowMs: number | null;
      if (keyLevel) {
        const lostRecs = before.filter((r) => !keys.has(String(r.intent)));
        lost = new Set(lostRecs.map((r) => r.intent)).size;
        lossWindowMs = lostRecs.length ? wipeTs - Math.min(...lostRecs.map((r) => r.ts + r.ms)) : 0;
      } else {
        // Baseline stores no client key, so count: rows that are not explained by payments after the wipe.
        const survivors = Math.max(0, keys.size - after.length);
        lost = Math.max(0, before.length - survivors);
        lossWindowMs = lost === 0 ? 0 : before.length ? wipeTs - Math.min(...before.map((r) => r.ts + r.ms)) : null;
      }
      return {
        restore,
        dataLoss: {
          wipeTs, basis: keyLevel ? 'idempotency-key' : 'count',
          ackedBeforeLoss: new Set(before.map((r) => r.intent)).size,
          lostAfterRestore: lost,
          lossWindowMs,
          backupAgeAtLossMs: restore?.backupFinishedMs != null ? wipeTs - restore.backupFinishedMs : null,
          restoreDurationMs: restore?.durationMs ?? null,
        },
      };
    },
  };
}

// E12: reliability soak. Nine component faults in ten minutes, one a minute, each repaired by the
// "operator" 25 s later. The fault rate is a chosen parameter of the experiment (it is far higher
// than any real one); what is measured is how many of the faults become failures a client can see,
// how long those last, and from that the system-level MTTF, MTBF, MTTR and availability
// (experiments/reliability.ts). The schedule is identical in every mode.
type SoakFault = { atMs: number; name: string; inject: () => Promise<unknown>; repair: () => Promise<unknown> };
const SOAK_REPAIR_AFTER_MS = 25_000;

function soak(): Scenario {
  let dbStopped = 'postgres-primary';
  const stopDb: Pick<SoakFault, 'inject' | 'repair'> = {
    inject: async () => { dbStopped = await dbWriter(); await dc('stop', dbStopped); },
    repair: () => dc('start', dbStopped),
  };
  const faults: SoakFault[] = [
    { atMs: 30_000, name: 'app-crash student-1', inject: () => crash(3011), repair: () => dc('start', 'student-1') },
    { atMs: 90_000, name: 'node-kill payment-1', inject: () => dc('kill', 'payment-1'), repair: () => dc('start', 'payment-1') },
    { atMs: 150_000, name: 'db-primary-stop', ...stopDb },
    { atMs: 210_000, name: 'node-kill gateway-1', inject: () => dc('kill', 'gateway-1'), repair: () => dc('start', 'gateway-1') },
    { atMs: 270_000, name: 'slow student-2 (3 s)', inject: () => chaos(3012, { latencyMs: 3000 }), repair: () => chaos(3012, { latencyMs: 0 }) },
    { atMs: 330_000, name: 'app-crash payment-2', inject: () => crash(3022), repair: () => dc('start', 'payment-2') },
    { atMs: 390_000, name: 'db-primary-stop (again)', ...stopDb },
    { atMs: 450_000, name: 'node-kill student-2 + payment-2', inject: () => dc('kill', 'student-2', 'payment-2'), repair: () => dc('start', 'student-2', 'payment-2') },
    { atMs: 510_000, name: 'payment-1 crashes mid-transaction', inject: () => chaos(3021, { crashAfterCheckpoint: true }), repair: () => dc('start', 'payment-1') },
  ];
  let log: { name: string; injectTs: number; repairTs: number }[] = [];
  return {
    name: 'soak',
    kind: 'fault',
    title: 'Reliability soak (9 component faults in 10 minutes)',
    durationMs: 600_000, injectAtMs: 30_000, repairAtMs: 560_000,
    inject: async () => {
      log = [];
      const start = Date.now() - faults[0].atMs;
      for (const f of faults) {
        await sleep(Math.max(0, start + f.atMs - Date.now()));
        const entry = { name: f.name, injectTs: Date.now(), repairTs: 0 };
        log.push(entry);
        console.log(`  T+${(f.atMs / 1000).toFixed(0)}s  fault: ${f.name}`);
        await f.inject().catch((e) => console.error(`  ! ${f.name}: ${(e as Error).message}`));
        await sleep(Math.max(0, entry.injectTs + SOAK_REPAIR_AFTER_MS - Date.now()));
        entry.repairTs = Date.now();
        await f.repair().catch((e) => console.error(`  ! repair ${f.name}: ${(e as Error).message}`));
      }
    },
    repair: async () => { await dc('start'); for (const port of CHAOS_PORTS) await chaos(port, CHAOS_RESET); },
    expectedAlerts: {
      mustFire: ['InstanceDown', 'DatabaseDown'],
      mayFire: ['HighErrorRate', 'HighLatencyP95', 'PaymentsStuckPending', 'DatabaseNoWriter', 'DatabaseFailover', 'DatabaseRedundancyLost'],
    },
    acceptance: [
      criteria.availabilityAtLeast(0.995),
      criteria.writeAvailabilityAtLeast(0.98),
      criteria.badSecondsAtMost(30),
      criteria.noDuplicateCharges(),
      criteria.noLostRecords(),
      criteria.ledgerBalanced(),
      criteria.standbyStreamingAtEnd(),
    ],
    verify: async () => ({ faults: log, repairAfterMs: SOAK_REPAIR_AFTER_MS, db: await dbStateWhenSettled() }),
  };
}

export const SCENARIOS: Record<string, Scenario> = {
  'app-crash': {
    name: 'app-crash',
    kind: 'fault',
    title: 'Application crash',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => crash(3011),
    repair: () => dc('start', 'student-1'),
    expectedAlerts: { mustFire: [], mayFire: ['InstanceDown'] },
    acceptance: [criteria.availabilityAtLeast(0.999), criteria.noDuplicateCharges(), criteria.noLostRecords()],
  },

  'db-failure': dbFailure(),

  'net-timeout': {
    name: 'net-timeout',
    kind: 'fault',
    title: 'Network / service timeout',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => chaos(3011, { latencyMs: 3000 }),
    repair: () => chaos(3011, { latencyMs: 0 }),
    expectedAlerts: { mustFire: [], mayFire: ['HighLatencyP95'] },
    acceptance: [criteria.throughputDuringFaultAtLeast(0.7), criteria.p95AtMost(1_000)],
  },

  'node-failure': {
    name: 'node-failure',
    kind: 'fault',
    title: 'Hardware / node failure',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('kill', 'student-1', 'payment-1'),
    repair: () => dc('start', 'student-1', 'payment-1'),
    expectedAlerts: { mustFire: ['InstanceDown'], mayFire: [] },
    acceptance: [
      criteria.alertDetectedWithin('InstanceDown', 10_000),
      criteria.availabilityAtLeast(0.999),
      criteria.noDuplicateCharges(),
    ],
  },

  'txn-interrupt': {
    name: 'txn-interrupt',
    kind: 'fault',
    title: 'Corrupted / lost transaction',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => { await chaos(3021, { crashAfterCheckpoint: true }); await chaos(3022, { crashAfterCheckpoint: true }); },
    repair: () => dc('start', 'payment-1', 'payment-2'),
    expectedAlerts: { mustFire: [], mayFire: ['PaymentsStuckPending', 'HighErrorRate', 'InstanceDown'] },
    acceptance: [
      criteria.noDuplicateCharges(),
      criteria.noLostRecords(),
      criteria.noOrphanedPending(),
      criteria.ledgerBalanced(),
    ],
  },

  'high-load': {
    name: 'high-load',
    kind: 'fault',
    title: 'High load',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => {},
    repair: async () => {},
    rampAtMs: INJECT,
    rampConcurrency: 100,
    expectedAlerts: { mustFire: [], mayFire: ['HighLatencyP95'] },
    acceptance: [
      criteria.errorRateAtMost(0.01),
      criteria.p95AtMost(1_000),
      criteria.noRateLimited(),
      criteria.resourcesRecorded(),
    ],
  },

  'gateway-failure': {
    name: 'gateway-failure',
    kind: 'fault',
    title: 'Gateway failure (one of the redundant gateways is killed)',
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: () => dc('kill', 'gateway-1'),   // nginx fails over to gateway-2 (redundant.conf)
    repair: () => dc('start', 'gateway-1'),
    expectedAlerts: { mustFire: ['InstanceDown'], mayFire: [] },
    acceptance: [criteria.availabilityAtLeast(0.995), criteria.noDuplicateCharges(), criteria.noLostRecords()],
  },

  'error-spike': {
    name: 'error-spike',
    kind: 'monitoring',
    title: 'Error spike (student and payment replicas fail every request)',
    // Endterm masks read failures: a failing GET degrades to a 203 from the stale cache (S7), so
    // failing only student-1/student-2 raises no gateway 5xx and HighErrorRate cannot fire. Payment
    // POSTs cannot degrade, so failing both payment replicas too drives a genuine 5xx spike (~20 %
    // of traffic) that the alert measures. Both student replicas are still failed, as the plan names.
    durationMs: D, injectAtMs: INJECT, repairAtMs: REPAIR,
    inject: async () => { for (const p of [3011, 3012, 3021, 3022]) await chaos(p, { failRate: 1.0 }); },
    repair: async () => { for (const p of [3011, 3012, 3021, 3022]) await chaos(p, { failRate: 0 }); },
    expectedAlerts: { mustFire: ['HighErrorRate'], mayFire: ['InstanceDown'] },
    acceptance: [
      criteria.alertDetectedWithin('HighErrorRate', 15_000),
      criteria.alertResolvedWithin('HighErrorRate', 30_000),
      criteria.alertsCorrect(),
    ],
  },

  'unauthorized-access': unauthorizedAccess(),
  'abuse': abuse(),
  'data-loss': dataLoss(),
  'soak': soak(),
};

if (process.argv[1]?.endsWith('scenarios.ts')) {
  const [, , name, step] = process.argv;
  const s = SCENARIOS[name];
  if (!s || !['inject', 'repair'].includes(step ?? '')) {
    console.log('usage: node experiments/scenarios.ts <' + Object.keys(SCENARIOS).join('|') + '> <inject|repair>');
    process.exit(1);
  }
  await (step === 'inject' ? s.inject() : s.repair());
  console.log(`${name}: ${step} done`);
}
