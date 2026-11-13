import { test } from 'node:test';
import assert from 'node:assert/strict';
import { alertCorrectness, evaluate, criteria, type RunResult } from './acceptance.ts';
import type { Scenario } from './scenarios.ts';

const noop = async () => {};

function scenario(acceptance: Scenario['acceptance']): Scenario {
  return {
    name: 't', title: 'test', kind: 'fault', durationMs: 1, injectAtMs: 0, repairAtMs: 0,
    inject: noop, repair: noop, expectedAlerts: { mustFire: [], mayFire: [] }, acceptance,
  };
}

const run = (over: Record<string, unknown> = {}) => ({
  metrics: {
    availability: { requestBased: 0.9995 },
    requests: { errorRate: 0.0005, rateLimited: 0 },
    response: { p95Ms: 300 },
    throughput: { preFaultRps: 100, duringFaultRps: 80, postRepairRps: 100 },
    alerts: [{ name: 'InstanceDown', detectionMs: 6_000, resolvedAfterRepairMs: 4_000 }],
  },
  consistency: { duplicateCharges: 0, lostRecords: 0, orphanedPending: 0, ledgerBalanced: true },
  alertCorrectness: { correct: true, missing: [], unexpected: [] },
  ...over,
}) as unknown as RunResult;

test('alertCorrectness: a fired alert in neither list is unexpected and makes the result incorrect', () => {
  const r = alertCorrectness({ mustFire: ['A'], mayFire: ['B'] }, ['A', 'C']);
  assert.equal(r.correct, false);
  assert.deepEqual(r.unexpected, ['C']);
  assert.deepEqual(r.missing, []);
});

test('alertCorrectness: a mustFire alert that did not fire is missing; mayFire alerts are optional', () => {
  assert.deepEqual(alertCorrectness({ mustFire: ['A'], mayFire: ['B'] }, ['B']), { correct: false, missing: ['A'], unexpected: [] });
  assert.deepEqual(alertCorrectness({ mustFire: ['A'], mayFire: ['B'] }, ['A']), { correct: true, missing: [], unexpected: [] });
  assert.deepEqual(alertCorrectness({ mustFire: [], mayFire: [] }, []), { correct: true, missing: [], unexpected: [] });
});

test('evaluate: a criterion whose check returns false fails, one that returns true passes', () => {
  const s = scenario([
    { id: 'yes', describe: 'always true', check: () => true },
    { id: 'no', describe: 'always false', check: () => false },
  ]);
  assert.deepEqual(evaluate(s, run()), [
    { id: 'yes', describe: 'always true', pass: true },
    { id: 'no', describe: 'always false', pass: false },
  ]);
});

test('evaluate: a check that throws (missing data) fails instead of crashing the run', () => {
  const s = scenario([{ id: 'boom', describe: 'reads a missing field', check: (r) => (r as any).nope.deeper > 0 }]);
  assert.deepEqual(evaluate(s, run()), [{ id: 'boom', describe: 'reads a missing field', pass: false }]);
});

test('criteria helpers read metrics.json fields', () => {
  const r = run();
  assert.equal(criteria.availabilityAtLeast(0.999).check(r), true);
  assert.equal(criteria.availabilityAtLeast(0.9999).check(r), false);
  assert.equal(criteria.noDuplicateCharges().check(r), true);
  assert.equal(criteria.noLostRecords().check(r), true);
  assert.equal(criteria.noLostRecords().check(run({ consistency: { lostRecords: null } })), false);  // unknown is not a pass
  assert.equal(criteria.noOrphanedPending().check(r), true);
  assert.equal(criteria.ledgerBalanced().check(r), true);
  // ledger query failed: consistencyFrom reports null, which must fail, not pass as 0 === 0
  const unmeasured = run({ consistency: { duplicateCharges: 0, lostRecords: 0, orphanedPending: null, ledgerBalanced: null } });
  assert.equal(criteria.ledgerBalanced().check(unmeasured), false);
  assert.equal(criteria.noOrphanedPending().check(unmeasured), false);
  assert.equal(criteria.p95AtMost(1_000).check(r), true);
  assert.equal(criteria.errorRateAtMost(0.01).check(r), true);
  assert.equal(criteria.noRateLimited().check(r), true);
  assert.equal(criteria.throughputDuringFaultAtLeast(0.7).check(r), true);
  assert.equal(criteria.throughputDuringFaultAtLeast(0.9).check(r), false);
  assert.equal(criteria.alertDetectedWithin('InstanceDown', 10_000).check(r), true);
  assert.equal(criteria.alertDetectedWithin('InstanceDown', 5_000).check(r), false);
  assert.equal(criteria.alertDetectedWithin('DatabaseDown', 10_000).check(r), false);  // never fired
  assert.equal(criteria.alertResolvedWithin('InstanceDown', 30_000).check(r), true);
  assert.equal(criteria.alertsCorrect().check(r), true);
  assert.equal(criteria.alertsCorrect().check(run({ alertCorrectness: { correct: false } })), false);
  assert.deepEqual(
    [criteria.alertDetectedWithin('DatabaseDown', 10_000).id, criteria.availabilityAtLeast(0.999).id],
    ['DatabaseDown-detect-le-10000ms', 'availability-ge-99.9pct'],
  );
});
