// Acceptance criteria and alert correctness, evaluated on a run's metrics.json (RunResult).
// Pure, so it is unit-tested and the aggregation (Task 17) can re-evaluate stored runs.
import type { Consistency, Metrics } from './metrics.ts';
import type { Scenario } from './scenarios.ts';
import { bruteForceVerdict, burstVerdict, type BruteForce, type BurstSummary } from './attacks.ts';

export type ExpectedAlerts = { mustFire: string[]; mayFire: string[] };

export type AlertCorrectness = { correct: boolean; missing: string[]; unexpected: string[] };

export type CriterionResult = { id: string; describe: string; pass: boolean };

export type Restore = {
  ok: boolean;
  durationMs: number;
  healthy: boolean;
  replicationStreaming: boolean;
  chaosReset: Record<string, boolean>;
  dbReset: boolean;
  alertsClear: boolean | null;   // null: Prometheus could not be asked
  firingAtStart: string[];
  error?: string;
};

// The content of reports/final/runs/<scenario>__<mode>__r<N>/metrics.json.
export type RunResult = {
  scenario: string;
  title: string;
  kind: Scenario['kind'];
  mode: string;
  rep: number;
  runId: string;
  t0: number;
  t1: number;
  injectTs: number;
  repairTs: number;
  restore: Restore;
  abandonedAtClose?: number;   // requests cut off by the end of the window: excluded from the metrics
  expectedAlerts: ExpectedAlerts;
  alertCorrectness: AlertCorrectness;
  metrics: Metrics;
  consistency: Consistency;
  verify: Record<string, unknown> | null;
  acceptance: CriterionResult[];
};

export type Criterion = { id: string; describe: string; check: (m: RunResult) => boolean };

// The result of a security scenario's verify() (E9/E10), stored in metrics.json as RunResult.verify.
export type SecurityVerify = {
  // byCategory: status counts per attack category (attacks.ts ATTACK_CATEGORIES)
  attacks?: { attempts: number; denied: number; statusCounts: Record<string, number>; byCategory?: Record<string, Record<string, number>> };
  attackPaymentsInDb?: number;   // payments rows with the attack amount or an attack- key (scenarios.ts ATTACK_PAYMENTS_SQL)
  evilStudents?: number;         // students whose id starts with evil-
  auditDenies?: number;          // audit lines (outcome=deny) whose rid is one of the attack rids
  malformed?: { sent: number; serverErrors: number; statusCounts: Record<string, number> };
  burst?: BurstSummary;
  bruteForce?: BruteForce;
  // restarted: containers whose RestartCount/StartedAt changed (or that stopped) between the snapshot at
  // inject and the one in verify(); null when a snapshot could not be taken
  instances?: { allUpAfter: boolean; restarted: string[] | null; containersChecked?: number };
  logins?: Record<string, { ok: boolean; error?: string }>;  // the logins the attack depended on
};

// The E9 categories sent with s7's real token: the policy must refuse them (403). A 401 there means the
// token was missing (login failed) and the request never reached the authorization check under test.
export const PRINCIPAL_ATTACK_CATEGORIES = ['pay-for-other-student', 'create-student', 'list-all-students'];
// Statuses that mean a malformed request was refused before validation ran (no/invalid token, policy,
// quota), so it says nothing about how the input is handled.
const NOT_VALIDATED = ['401', '403', '429'];

// `observed` is the names of the alerts that reached `firing` during the run.
export function alertCorrectness(expected: ExpectedAlerts, observed: string[]): AlertCorrectness {
  const fired = new Set(observed);
  const allowed = new Set([...expected.mustFire, ...expected.mayFire]);
  const missing = expected.mustFire.filter((a) => !fired.has(a));
  const unexpected = [...fired].filter((a) => !allowed.has(a)).sort();
  return { correct: missing.length === 0 && unexpected.length === 0, missing, unexpected };
}

// A check that throws (a field the run could not measure) fails: missing evidence is not a pass.
export function evaluate(s: Scenario, r: RunResult): CriterionResult[] {
  return s.acceptance.map((c) => {
    let pass = false;
    try {
      pass = c.check(r) === true;
    } catch {
      pass = false;
    }
    return { id: c.id, describe: c.describe, pass };
  });
}

const pctLabel = (x: number) => `${+(x * 100).toFixed(3)}pct`;
const alert = (r: RunResult, name: string) => r.metrics.alerts.find((a) => a.name === name);
const isNum = (x: unknown): x is number => typeof x === 'number' && Number.isFinite(x);
const sec = (r: RunResult): SecurityVerify => (r.verify ?? {}) as SecurityVerify;

// Reusable criteria for the scenario table (Task 15). Each reads only metrics.json fields.
export const criteria = {
  availabilityAtLeast: (min: number): Criterion => ({
    id: `availability-ge-${pctLabel(min)}`,
    describe: `request-based availability >= ${+(min * 100).toFixed(3)} %`,
    check: (r) => isNum(r.metrics.availability.requestBased) && r.metrics.availability.requestBased >= min,
  }),
  errorRateAtMost: (max: number): Criterion => ({
    id: `error-rate-le-${pctLabel(max)}`,
    describe: `error rate <= ${+(max * 100).toFixed(3)} %`,
    check: (r) => isNum(r.metrics.requests.errorRate) && r.metrics.requests.errorRate <= max,
  }),
  p95AtMost: (ms: number): Criterion => ({
    id: `p95-le-${ms}ms`,
    describe: `p95 latency <= ${ms} ms`,
    check: (r) => isNum(r.metrics.response.p95Ms) && r.metrics.response.p95Ms <= ms,
  }),
  noRateLimited: (): Criterion => ({
    id: 'rate-limited-eq-0',
    describe: 'no legitimate request is rate limited (429)',
    check: (r) => r.metrics.requests.rateLimited === 0,
  }),
  throughputDuringFaultAtLeast: (ratio: number): Criterion => ({
    id: `during-fault-rps-ge-${ratio}x-pre-fault`,
    describe: `throughput during the fault >= ${ratio} x throughput before it`,
    check: (r) => {
      const { preFaultRps, duringFaultRps } = r.metrics.throughput;
      return isNum(preFaultRps) && isNum(duringFaultRps) && preFaultRps > 0 && duringFaultRps >= ratio * preFaultRps;
    },
  }),
  noDuplicateCharges: (): Criterion => ({
    id: 'duplicates-eq-0',
    describe: 'no duplicate charge (DB and client side)',
    check: (r) => r.consistency.duplicateCharges === 0,
  }),
  noLostRecords: (): Criterion => ({
    id: 'lost-eq-0',
    describe: 'no acknowledged payment missing from the DB',
    check: (r) => r.consistency.lostRecords === 0,
  }),
  noOrphanedPending: (): Criterion => ({
    id: 'orphaned-pending-eq-0',
    describe: 'no payment left pending at the end',
    check: (r) => r.consistency.orphanedPending === 0,
  }),
  ledgerBalanced: (): Criterion => ({
    id: 'ledger-balanced',
    describe: 'sum of completed payments equals the sum of student balances',
    check: (r) => r.consistency.ledgerBalanced === true,
  }),
  alertDetectedWithin: (name: string, ms: number): Criterion => ({
    id: `${name}-detect-le-${ms}ms`,
    describe: `${name} fires within ${ms / 1000} s of the injection`,
    check: (r) => {
      const a = alert(r, name);
      return a != null && isNum(a.detectionMs) && a.detectionMs >= 0 && a.detectionMs <= ms;
    },
  }),
  alertResolvedWithin: (name: string, ms: number): Criterion => ({
    id: `${name}-resolve-le-${ms}ms-after-repair`,
    describe: `${name} resolves within ${ms / 1000} s of the repair`,
    check: (r) => {
      const a = alert(r, name);
      return a != null && isNum(a.resolvedAfterRepairMs) && a.resolvedAfterRepairMs <= ms;
    },
  }),
  alertsCorrect: (): Criterion => ({
    id: 'alerts-correct',
    describe: 'every mustFire alert fired and no unexpected alert fired',
    check: (r) => r.alertCorrectness.correct === true,
  }),
  readAvailabilityAtLeast: (min: number): Criterion => ({
    id: `read-availability-ge-${pctLabel(min)}`,
    describe: `read-request availability >= ${+(min * 100).toFixed(3)} % (reads fail over to the standby)`,
    check: (r) => isNum(r.metrics.availability.readRequestBased) && r.metrics.availability.readRequestBased >= min,
  }),
  resourcesRecorded: (): Criterion => ({
    id: 'resources-recorded',
    describe: 'CPU and memory were sampled during the run',
    check: (r) => Array.isArray(r.metrics.resources) && r.metrics.resources.length > 0,
  }),
  // ---- final: write path, failover, backup/restore ----
  writeAvailabilityAtLeast: (min: number): Criterion => ({
    id: `write-availability-ge-${pctLabel(min)}`,
    describe: `payment (write) availability >= ${+(min * 100).toFixed(3)} %`,
    check: (r) => isNum(r.metrics.availability.writeRequestBased) && r.metrics.availability.writeRequestBased >= min,
  }),
  writePathRecoversWithin: (ms: number): Criterion => ({
    id: `write-recovery-le-${ms}ms`,
    describe: `payments succeed again within ${ms / 1000} s of the injection (before the operator repairs anything)`,
    check: (r) => {
      const w = r.metrics.writePath;
      return w != null && (w.wentDown === false || (isNum(w.recoveryMs) && w.recoveryMs <= ms));
    },
  }),
  standbyStreamingAtEnd: (): Criterion => ({
    id: 'standby-streaming-at-end',
    describe: 'at the end of the run a primary accepts writes and a standby streams from it (redundancy restored)',
    check: (r) => {
      const d = (r.verify ?? {}) as { db?: { writer?: string | null; standbys?: number } };
      return typeof d.db?.writer === 'string' && isNum(d.db?.standbys) && d.db.standbys >= 1;
    },
  }),
  restoreSucceeded: (): Criterion => ({
    id: 'restore-succeeded',
    describe: 'the newest backup passed its checksum, restored into a scratch database and was merged back',
    check: (r) => ((r.verify ?? {}) as { restore?: { ok?: boolean } }).restore?.ok === true,
  }),
  lossWindowAtMost: (ms: number): Criterion => ({
    id: `loss-window-le-${ms}ms`,
    describe: `acknowledged payments are missing for at most the last ${ms / 1000} s before the data loss (recovery point)`,
    check: (r) => {
      const d = (r.verify ?? {}) as { dataLoss?: { lossWindowMs?: number | null; ackedBeforeLoss?: number } };
      return isNum(d.dataLoss?.ackedBeforeLoss) && d.dataLoss.ackedBeforeLoss > 0
        && isNum(d.dataLoss?.lossWindowMs) && d.dataLoss.lossWindowMs <= ms;
    },
  }),
  badSecondsAtMost: (max: number): Criterion => ({
    id: `bad-seconds-le-${max}`,
    describe: `at most ${max} seconds with fewer than 99 % of requests successful`,
    check: (r) => isNum(r.metrics.availability.badSeconds) && r.metrics.availability.badSeconds <= max,
  }),
  // ---- E9 unauthorized-access ----
  allAttacksDenied: (): Criterion => ({
    id: 'attacks-all-denied',
    describe: 'every attack attempt was denied (401/403), none got a 2xx; the s7-token attempts were refused by the policy (403), not for a missing token',
    check: (r) => {
      const a = sec(r).attacks;
      if (!a || !isNum(a.attempts) || a.attempts <= 0 || !isNum(a.denied)) return false;
      const good = Object.entries(a.statusCounts).every(([s, _c]) => Number(s) === 401 || Number(s) === 403);
      if (!(a.denied === a.attempts && good)) return false;
      // category-aware: each privilege-escalation category was sent and every attempt got a 403
      return PRINCIPAL_ATTACK_CATEGORIES.every((c) => {
        const counts = a.byCategory?.[c];
        if (!counts) return false;
        const total = Object.values(counts).reduce((x, y) => x + y, 0);
        return total > 0 && counts['403'] === total;
      });
    },
  }),
  noAttackerPaymentsInDb: (): Criterion => ({
    id: 'attacker-payments-in-db-eq-0',
    describe: 'no attacker payment (attack amount or attack- idempotency key) reached the database',
    check: (r) => sec(r).attackPaymentsInDb === 0,
  }),
  noEvilStudents: (): Criterion => ({
    id: 'evil-students-eq-0',
    describe: 'no student with an evil- id was created',
    check: (r) => sec(r).evilStudents === 0,
  }),
  auditDeniesAtLeastAttempts: (): Criterion => ({
    id: 'audit-denies-ge-attempts',
    describe: 'at least one audit deny event per attack attempt',
    check: (r) => {
      const a = sec(r);
      return isNum(a.auditDenies) && isNum(a.attacks?.attempts) && a.auditDenies >= (a.attacks?.attempts ?? Infinity);
    },
  }),
  // ---- E10 abuse ----
  malformedNo5xx: (): Criterion => ({
    id: 'malformed-input-no-5xx',
    describe: 'no malformed request caused a 5xx, and every one reached input validation (none refused with 401/403/429 first)',
    check: (r) => {
      const m = sec(r).malformed;
      if (m == null || !isNum(m.sent) || m.sent <= 0 || m.serverErrors !== 0 || m.statusCounts == null) return false;
      return NOT_VALIDATED.every((s) => !(m.statusCounts[s] > 0));
    },
  }),
  burstLimited: (): Criterion => ({
    id: 'burst-429-after-quota',
    describe: 'the request burst got 429 after the quota, with Retry-After, and no 5xx',
    check: (r) => {
      const b = sec(r).burst;
      return b != null && burstVerdict(b);
    },
  }),
  bruteForceLimited: (): Criterion => ({
    id: 'bruteforce-429-after-5',
    describe: 'the login brute force got 429 after the 5-attempt burst',
    check: (r) => {
      const bf = sec(r).bruteForce;
      return bf != null && bruteForceVerdict(bf);
    },
  }),
  instancesStayUp: (): Criterion => ({
    id: 'instances-stay-up',
    describe: 'no instance went down or was restarted during the abuse (container RestartCount/StartedAt unchanged, every instance healthy after)',
    check: (r) => {
      const i = sec(r).instances;
      return i != null && i.allUpAfter === true && Array.isArray(i.restarted) && i.restarted.length === 0
        && isNum(i.containersChecked) && i.containersChecked > 0;
    },
  }),
};
