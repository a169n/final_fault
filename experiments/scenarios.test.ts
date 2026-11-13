import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ATTACK_PAYMENTS_SQL, SCENARIOS } from './scenarios.ts';
import { ATTACK_AMOUNT } from './attacks.ts';
import { evaluate, type RunResult } from './acceptance.ts';
import { restartedBetween, type ContainerState } from './resources.ts';

// The scenario table of Task 15 (docs/superpowers/plans/2026-11-09-endterm-resilient-university.md).
const TABLE: Record<string, { kind: string; mustFire: string[]; mayFire: string[]; criteria: number }> = {
  'app-crash': { kind: 'fault', mustFire: [], mayFire: ['InstanceDown'], criteria: 3 },
  'db-failure': {
    kind: 'fault', mustFire: ['DatabaseDown'],
    mayFire: ['HighErrorRate', 'InstanceDown', 'DatabaseNoWriter', 'DatabaseFailover', 'DatabaseRedundancyLost'], criteria: 7,
  },
  'net-timeout': { kind: 'fault', mustFire: [], mayFire: ['HighLatencyP95'], criteria: 2 },
  'node-failure': { kind: 'fault', mustFire: ['InstanceDown'], mayFire: [], criteria: 3 },
  'txn-interrupt': { kind: 'fault', mustFire: [], mayFire: ['PaymentsStuckPending', 'HighErrorRate', 'InstanceDown'], criteria: 4 },
  'high-load': { kind: 'fault', mustFire: [], mayFire: ['HighLatencyP95'], criteria: 4 },
  'gateway-failure': { kind: 'fault', mustFire: ['InstanceDown'], mayFire: [], criteria: 3 },
  'error-spike': { kind: 'monitoring', mustFire: ['HighErrorRate'], mayFire: ['InstanceDown'], criteria: 3 },
  'unauthorized-access': { kind: 'security', mustFire: ['AuthFailureSpike'], mayFire: [], criteria: 6 },
  'abuse': { kind: 'security', mustFire: ['AuthFailureSpike'], mayFire: ['InstanceDown'], criteria: 6 },
  // final
  'data-loss': { kind: 'fault', mustFire: ['PaymentRecordsLost'], mayFire: [], criteria: 6 },
  'soak': {
    kind: 'fault', mustFire: ['InstanceDown', 'DatabaseDown'],
    mayFire: ['HighErrorRate', 'HighLatencyP95', 'PaymentsStuckPending', 'DatabaseNoWriter', 'DatabaseFailover', 'DatabaseRedundancyLost'],
    criteria: 7,
  },
};

// A run that meets every endterm target in the table.
function goodRun(over: Record<string, any> = {}): RunResult {
  const base: Record<string, any> = {
    metrics: {
      availability: { requestBased: 0.9999, readRequestBased: 0.9999, writeRequestBased: 0.999, badSeconds: 4 },
      writePath: { wentDown: true, recoveryMs: 5_000 },
      requests: { errorRate: 0.0001, rateLimited: 0 },
      response: { p95Ms: 200 },
      throughput: { preFaultRps: 100, duringFaultRps: 95, postRepairRps: 100 },
      alerts: ['InstanceDown', 'DatabaseDown', 'HighErrorRate', 'PaymentRecordsLost'].map((name) => ({ name, detectionMs: 6_000, resolvedAfterRepairMs: 10_000 })),
      resources: [{ name: 'gateway-1', maxCpuPct: 10, maxMemMiB: 80 }],
    },
    consistency: { duplicateCharges: 0, duplicateChargesDb: 0, lostRecords: 0, orphanedPending: 0, ledgerBalanced: true },
    alertCorrectness: { correct: true, missing: [], unexpected: [] },
    verify: {
      attacks: {
        attempts: 80, denied: 80, statusCounts: { 401: 40, 403: 40 },
        byCategory: {
          'no-token': { 401: 10 }, 'forged-signature': { 401: 10 }, 'expired-token': { 401: 10 }, 'alg-none': { 401: 10 },
          'pay-for-other-student': { 403: 13 }, 'create-student': { 403: 13 }, 'list-all-students': { 403: 14 },
        },
      },
      attackPaymentsInDb: 0,
      evilStudents: 0,
      auditDenies: 80,
      malformed: { sent: 204, serverErrors: 0, statusCounts: { 422: 200, 400: 2, 413: 2 } },
      burst: { sent: 1000, ok: 60, limited: 940, limitedWithRetryAfter: 940, other: 0, firstLimitedAt: 60, elapsedMs: 2_000 },
      bruteForce: { statuses: [...Array(10).fill(401), ...Array(40).fill(429)], elapsedMs: 1_500 },
      instances: { allUpAfter: true, restarted: [], containersChecked: 16 },
      logins: { s7: { ok: true }, staff: { ok: true } },
      db: { writer: 'postgres-replica', standbys: 1 },
      restore: { ok: true },
      dataLoss: { ackedBeforeLoss: 700, lostAfterRestore: 90, lossWindowMs: 9_000 },
    },
  };
  for (const [k, v] of Object.entries(over)) base[k] = v === null || typeof v !== 'object' ? v : { ...base[k], ...v };
  return base as unknown as RunResult;
}

test('the twelve scenarios of the table exist with their kind, expected alerts and acceptance criteria', () => {
  assert.deepEqual(Object.keys(SCENARIOS).sort(), Object.keys(TABLE).sort());
  for (const [name, row] of Object.entries(TABLE)) {
    const s = SCENARIOS[name];
    assert.equal(s.name, name);
    assert.equal(s.kind, row.kind, name);
    assert.deepEqual(s.expectedAlerts, { mustFire: row.mustFire, mayFire: row.mayFire }, name);
    assert.equal(s.acceptance.length, row.criteria, name);
    assert.equal(new Set(s.acceptance.map((c) => c.id)).size, s.acceptance.length, `${name}: duplicate criterion id`);
    // the ten 70 s scenarios share one timeline; data-loss and soak have their own
    if (!['data-loss', 'soak'].includes(name)) assert.ok(s.injectAtMs === 20_000 && s.repairAtMs === 45_000, name);
  }
  assert.ok(Object.values(SCENARIOS).filter((s) => s.kind !== 'security').length >= 4);  // spec §6
  assert.ok(Object.values(SCENARIOS).filter((s) => s.kind === 'security').length >= 2);
  for (const name of ['unauthorized-access', 'abuse']) assert.equal(typeof SCENARIOS[name].verify, 'function');
});

test('a run meeting every endterm target passes every criterion of every scenario', () => {
  for (const s of Object.values(SCENARIOS)) {
    const failed = evaluate(s, goodRun()).filter((c) => !c.pass).map((c) => c.id);
    assert.deepEqual(failed, [], s.name);
  }
});

const failedIds = (name: string, r: RunResult) => evaluate(SCENARIOS[name], r).filter((c) => !c.pass).map((c) => c.id);

test('db-failure: read availability below 99 % or DatabaseDown later than 10 s fails', () => {
  assert.deepEqual(failedIds('db-failure', goodRun({ metrics: { availability: { requestBased: 0.8, readRequestBased: 0.98 } } })),
    ['read-availability-ge-99pct']);
  const late = goodRun();
  late.metrics.alerts = [{ name: 'DatabaseDown', detectionMs: 12_000 } as any];
  assert.deepEqual(failedIds('db-failure', late), ['DatabaseDown-detect-le-10000ms']);
});

test('high-load: a run without resource samples fails "resources recorded"', () => {
  assert.deepEqual(failedIds('high-load', goodRun({ metrics: { resources: [] } })), ['resources-recorded']);
});

test('unauthorized-access: one attack that got through fails, and so does a missing audit event', () => {
  const through = goodRun({ verify: { attacks: { attempts: 80, denied: 79, statusCounts: { 201: 1, 401: 40, 403: 39 } }, attackPaymentsInDb: 1 } });
  assert.deepEqual(failedIds('unauthorized-access', through), ['attacks-all-denied', 'attacker-payments-in-db-eq-0']);
  assert.deepEqual(failedIds('unauthorized-access', goodRun({ verify: { auditDenies: 79 } })), ['audit-denies-ge-attempts']);
  assert.deepEqual(failedIds('unauthorized-access', goodRun({ verify: { evilStudents: 1 } })), ['evil-students-eq-0']);
  assert.ok(failedIds('unauthorized-access', goodRun({ verify: null as any })).length >= 4);  // no evidence is not a pass
});

test('abuse: a 5xx caused by malformed input, an unlimited burst or a restarted instance fails', () => {
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { malformed: { sent: 204, serverErrors: 1 } } })), ['malformed-input-no-5xx']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { burst: { sent: 1000, ok: 1000, limited: 0, limitedWithRetryAfter: 0, other: 0, firstLimitedAt: null, elapsedMs: 2_000 } } })),
    ['burst-429-after-quota']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { bruteForce: { statuses: Array(50).fill(401), elapsedMs: 1_500 } } })),
    ['bruteforce-429-after-5']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { instances: { allUpAfter: true, restarted: ['gateway-1'] } } })),
    ['instances-stay-up']);
});

test('unauthorized-access: a failed s7 login (privilege-escalation attempts sent without a token, 401) fails', () => {
  // what verify() records when login as s7 fails: the three s7-token categories come back 401, not 403
  const noLogin = goodRun({ verify: {
    logins: { s7: { ok: false, error: 'login as s7 failed: HTTP 429' } },
    attacks: { attempts: 80, denied: 80, statusCounts: { 401: 80 }, byCategory: {
      'no-token': { 401: 10 }, 'forged-signature': { 401: 10 }, 'expired-token': { 401: 10 }, 'alg-none': { 401: 10 },
      'pay-for-other-student': { 401: 13 }, 'create-student': { 401: 13 }, 'list-all-students': { 401: 14 },
    } },
  } });
  assert.deepEqual(failedIds('unauthorized-access', noLogin), ['attacks-all-denied']);
  // one category partly 401 is enough; and a run without the per-category evidence is not a pass
  const partial = goodRun({ verify: { attacks: { attempts: 80, denied: 80, statusCounts: { 401: 41, 403: 39 }, byCategory: {
    'no-token': { 401: 40 }, 'pay-for-other-student': { 403: 12, 401: 1 }, 'create-student': { 403: 13 }, 'list-all-students': { 403: 14 },
  } } } });
  assert.deepEqual(failedIds('unauthorized-access', partial), ['attacks-all-denied']);
  assert.deepEqual(failedIds('unauthorized-access', goodRun({ verify: { attacks: { attempts: 80, denied: 80, statusCounts: { 401: 40, 403: 40 } } } })),
    ['attacks-all-denied']);
});

test('abuse: malformed input refused at the auth layer (failed staff login) does not count as validated', () => {
  const noLogin = goodRun({ verify: {
    logins: { staff: { ok: false, error: 'login as bursar failed: HTTP 401' }, s7: { ok: true } },
    malformed: { sent: 203, serverErrors: 0, statusCounts: { 401: 202, 413: 1 } },
  } });
  assert.deepEqual(failedIds('abuse', noLogin), ['malformed-input-no-5xx']);
  for (const s of ['403', '429']) {
    assert.deepEqual(failedIds('abuse', goodRun({ verify: { malformed: { sent: 203, serverErrors: 0, statusCounts: { 422: 200, [s]: 3 } } } })),
      ['malformed-input-no-5xx'], s);
  }
});

test('abuse: a container restarted during the abuse (back up by verify time) fails "instances stay up"', () => {
  const at = '2026-11-09T17:00:00.000000000Z';
  const before: ContainerState[] = ['gateway-1', 'gateway-2', 'student-1'].map((n) => ({ name: `ft-${n}-1`, restartCount: 0, startedAt: at, running: true }));
  // restart policy brought gateway-1 back: running again, healthy, but RestartCount and StartedAt moved
  const after = before.map((c) => c.name === 'ft-gateway-1-1' ? { ...c, restartCount: 1, startedAt: '2026-11-09T17:00:31.000000000Z' } : c);
  const restarted = restartedBetween(before, after);
  assert.deepEqual(restarted, ['ft-gateway-1-1']);
  const run = goodRun({ verify: { instances: { allUpAfter: true, restarted, containersChecked: before.length } } });
  assert.deepEqual(failedIds('abuse', run), ['instances-stay-up']);
  // no snapshot (docker could not be asked) or an empty one is missing evidence, not a pass
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { instances: { allUpAfter: true, restarted: null, containersChecked: 0 } } })), ['instances-stay-up']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { instances: { allUpAfter: true, restarted: [], containersChecked: 0 } } })), ['instances-stay-up']);
  assert.deepEqual(failedIds('abuse', goodRun({ verify: { instances: { allUpAfter: true, restarted: [] } } })), ['instances-stay-up']);
});

test('unauthorized-access: attacker payments are counted by amount, so a baseline that drops the Idempotency-Key is still caught', () => {
  // Baseline stores a fresh UUID instead of the client's key (idempotency.payment_key), so an
  // attack- key filter alone would read 0 even when the forged/expired/no-token payments succeeded.
  assert.match(ATTACK_PAYMENTS_SQL, new RegExp(`\\bamount = ${ATTACK_AMOUNT.toString().replace('.', '\\.')}\\b`));
  assert.match(ATTACK_PAYMENTS_SQL, / or idempotency_key like 'attack-%'/);
  assert.doesNotMatch(ATTACK_PAYMENTS_SQL, /state\s*=/);  // a pending attacker row counts too
  // what verify() records in that baseline case fails the criterion
  assert.deepEqual(failedIds('unauthorized-access', goodRun({ verify: {
    attacks: { attempts: 63, denied: 0, statusCounts: { 201: 63 } }, attackPaymentsInDb: 36,
  } })).filter((id) => id === 'attacker-payments-in-db-eq-0'), ['attacker-payments-in-db-eq-0']);
  // and a missing count is not a pass
  assert.ok(failedIds('unauthorized-access', goodRun({ verify: { attackPaymentsInDb: null as any } })).includes('attacker-payments-in-db-eq-0'));
});

test('db-failure: a write path that only comes back after the repair, or a missing standby at the end, fails', () => {
  const ids = (r: RunResult) => evaluate(SCENARIOS['db-failure'], r).filter((c) => !c.pass).map((c) => c.id);
  assert.deepEqual(ids(goodRun({ metrics: { writePath: { wentDown: true, recoveryMs: 26_000 } } })), ['write-recovery-le-10000ms']);
  assert.deepEqual(ids(goodRun({ metrics: { writePath: { wentDown: true, recoveryMs: null } } })), ['write-recovery-le-10000ms']);
  assert.deepEqual(ids(goodRun({ metrics: { writePath: { wentDown: false, recoveryMs: null } } })), []);
  assert.deepEqual(ids(goodRun({ verify: { db: { writer: 'postgres-replica', standbys: 0 } } })), ['standby-streaming-at-end']);
});

test('data-loss: no restore, a loss window over 20 s or an unmeasured one fails', () => {
  const ids = (r: RunResult) => evaluate(SCENARIOS['data-loss'], r).filter((c) => !c.pass).map((c) => c.id);
  assert.deepEqual(ids(goodRun()), []);
  assert.deepEqual(ids(goodRun({ verify: { restore: { ok: false, error: 'no backup found' } } })), ['restore-succeeded']);
  assert.deepEqual(ids(goodRun({ verify: { dataLoss: { ackedBeforeLoss: 700, lossWindowMs: 38_000 } } })), ['loss-window-le-20000ms']);
  assert.deepEqual(ids(goodRun({ verify: { dataLoss: { ackedBeforeLoss: 700, lossWindowMs: null } } })), ['loss-window-le-20000ms']);
});

test('soak: too many bad seconds or a low write availability fails', () => {
  const ids = (r: RunResult) => evaluate(SCENARIOS['soak'], r).filter((c) => !c.pass).map((c) => c.id);
  assert.deepEqual(ids(goodRun({ metrics: { availability: { requestBased: 0.9999, writeRequestBased: 0.9, badSeconds: 60 } } })),
    ['write-availability-ge-98pct', 'bad-seconds-le-30']);
});
