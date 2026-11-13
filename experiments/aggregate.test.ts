import { test } from 'node:test';
import assert from 'node:assert/strict';
import { aggregate, renderCsv, renderResults, stat, type Row } from './aggregate.ts';
import type { RunResult } from './acceptance.ts';

type Over = {
  scenario?: string; mode?: string; rep?: number; a?: number | null; timeA?: number;
  pass?: boolean[]; alerts?: { name: string; fired: boolean; detectionMs: number | null }[];
  correct?: boolean; lost?: number; dup?: number; dupDb?: number; orphans?: number; detectionMs?: number | null;
};

// A minimal RunResult carrying only the fields aggregate() reads.
function run(o: Over = {}): RunResult {
  const pass = o.pass ?? [true, true];
  return {
    scenario: o.scenario ?? 'app-crash', title: 'Application crash', kind: 'fault', mode: o.mode ?? 'endterm', rep: o.rep ?? 1,
    runId: 'x', t0: 0, t1: 70_000, injectTs: 20_000, repairTs: 45_000,
    restore: { ok: true },
    expectedAlerts: { mustFire: ['InstanceDown'], mayFire: [] },
    alertCorrectness: { correct: o.correct ?? true, missing: [], unexpected: [] },
    metrics: {
      requests: { total: 1000, successful: 990, failed: 10, errorRate: 0.01, rateLimited: 0 },
      availability: { requestBased: o.a === undefined ? 0.99 : o.a, timeBased: o.timeA ?? 1, readRequestBased: 1 },
      response: { avgMs: 20, p95Ms: 50, detectionMs: o.detectionMs === undefined ? 100 : o.detectionMs, recoveryMs: 5_000 },
      reliability: { mttrMs: 3_000 },
      throughput: { preFaultRps: 100, duringFaultRps: 90, postRepairRps: 100 },
      alerts: o.alerts ?? [{ name: 'InstanceDown', fired: true, detectionMs: 6_000, resolvedAfterRepairMs: 2_000 }],
      resources: [],
    },
    consistency: {
      lostRecords: o.lost ?? 0, duplicateCharges: o.dup ?? 0, duplicateChargesDb: o.dupDb ?? 0, duplicateChargesClient: o.dup ?? 0,
      orphanedPending: o.orphans ?? 0, phantomRecords: 0, ledgerBalanced: true,
    },
    verify: null,
    acceptance: pass.map((p, i) => ({ id: `c${i}`, describe: `criterion ${i}`, pass: p })),
  } as unknown as RunResult;
}

const only = (rows: Row[]) => {
  assert.equal(rows.length, 1);
  return rows[0];
};

test('stat: mean and sample sd over the finite values; null/undefined are skipped and n says how many were used', () => {
  const s = stat([0.99, 1.0, null, undefined]);
  assert.equal(s.n, 2);
  assert.ok(Math.abs((s.mean ?? NaN) - 0.995) < 1e-12);
  assert.ok(Math.abs((s.sd ?? NaN) - Math.sqrt(0.00005)) < 1e-12);
  assert.deepEqual(stat([]), { n: 0, mean: null, sd: null });
  assert.deepEqual(stat([7]), { n: 1, mean: 7, sd: null });   // one value has no sample sd
});

test('aggregate: two runs with A = 0.99 and 1.0 give mean availability 0.995 and n = 2', () => {
  const row = only(aggregate([run({ rep: 1, a: 0.99 }), run({ rep: 2, a: 1.0 })]));
  assert.equal(row.n, 2);
  assert.ok(Math.abs((row.availabilityRequest.mean ?? NaN) - 0.995) < 1e-12);
  assert.deepEqual(row.reps, [1, 2]);
});

test('aggregate: one failing criterion in one repetition makes the verdict FAIL (1/2)', () => {
  const row = only(aggregate([run({ rep: 1 }), run({ rep: 2, pass: [true, false] })]));
  assert.equal(row.verdict, 'FAIL (1/2)');
  assert.deepEqual(row.criteria.map((c) => [c.id, c.passed, c.n]), [['c0', 2, 2], ['c1', 1, 2]]);
});

test('aggregate: PASS only when every criterion passed in every repetition', () => {
  assert.equal(only(aggregate([run({ rep: 1 }), run({ rep: 2 }), run({ rep: 3 })])).verdict, 'PASS');
  assert.equal(only(aggregate([run({ rep: 1, pass: [false, false] }), run({ rep: 2 }), run({ rep: 3 })])).verdict, 'FAIL (2/3)');
});

test('aggregate: groups by (scenario, mode), in scenario then mode order', () => {
  const rows = aggregate([
    run({ scenario: 'db-failure', mode: 'endterm' }), run({ scenario: 'app-crash', mode: 'endterm' }),
    run({ scenario: 'app-crash', mode: 'baseline' }), run({ scenario: 'app-crash', mode: 'endterm', rep: 2 }),
  ]);
  assert.deepEqual(rows.map((r) => [r.scenario, r.mode, r.n]), [
    ['app-crash', 'baseline', 1], ['app-crash', 'endterm', 2], ['db-failure', 'endterm', 1],
  ]);
});

test('aggregate: per-alert fired k/n, detection mean over the runs where it fired, correctness k/n', () => {
  const row = only(aggregate([
    run({ rep: 1, alerts: [{ name: 'InstanceDown', fired: true, detectionMs: 4_000 }] }),
    run({ rep: 2, alerts: [{ name: 'InstanceDown', fired: true, detectionMs: 8_000 }], correct: false }),
    run({ rep: 3, alerts: [{ name: 'InstanceDown', fired: false, detectionMs: null }] }),
  ]));
  const a = row.alerts.find((x) => x.name === 'InstanceDown');
  assert.ok(a);
  assert.equal(a.fired, 2);
  assert.equal(a.detectionMs.n, 2);
  assert.equal(a.detectionMs.mean, 6_000);
  assert.equal(row.alertCorrect, 2);
});

test('aggregate: integrity totals sum over the repetitions', () => {
  const row = only(aggregate([run({ rep: 1, lost: 1, dup: 3, dupDb: 0, orphans: 2 }), run({ rep: 2, lost: 0, dup: 1, orphans: 0 })]));
  assert.equal(row.integrity.lost, 1);
  assert.equal(row.integrity.duplicates, 4);
  assert.equal(row.integrity.duplicatesDb, 0);
  assert.equal(row.integrity.orphanedPending, 2);
  assert.equal(row.integrity.ledgerBalanced, 2);
});

test('aggregate: a metric missing in some runs keeps the group n but reports the smaller value count', () => {
  const row = only(aggregate([run({ rep: 1, detectionMs: 100 }), run({ rep: 2, detectionMs: null })]));
  assert.equal(row.n, 2);
  assert.equal(row.detectionMs.n, 1);
  assert.equal(row.detectionMs.mean, 100);
});

test('renderResults: the four tables are present and a mode with no runs is shown as such', () => {
  const md = renderResults(aggregate([run({ mode: 'baseline' }), run({ mode: 'endterm', a: 1 })]));
  for (const h of ['## (a)', '## (b)', '## (c)', '## (d)']) assert.ok(md.includes(h), `missing ${h}`);
  assert.match(md, /no runs/);
  assert.match(md, /midterm/);
  assert.match(md, /PASS/);
  assert.match(md, /99\.000 %/);
});

test('renderCsv: a header plus one line per (scenario, mode) group with the same number of fields', () => {
  const csv = renderCsv(aggregate([run({ mode: 'baseline' }), run({ mode: 'endterm' }), run({ scenario: 'db-failure' })]));
  const lines = csv.trim().split('\n');
  assert.equal(lines.length, 4);
  const width = lines[0].split(',').length;
  for (const l of lines) assert.equal(l.split(',').length, width);
  assert.match(lines[0], /^scenario,mode,n,verdict,/);
});

test('loadRuns skips smoke-test repetition 0 and names an unreadable file', async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { loadRuns } = await import('./aggregate.ts');
  const dir = mkdtempSync(join(tmpdir(), 'agg-'));
  for (const [d, body] of [['a__endterm__r0', '{"scenario":"a"}'], ['a__endterm__r1', '{"scenario":"a"}']]) {
    mkdirSync(join(dir, d));
    writeFileSync(join(dir, d, 'metrics.json'), body);
  }
  assert.equal(loadRuns(dir).length, 1);
  assert.equal(loadRuns(dir, true).length, 2);
  mkdirSync(join(dir, 'b__endterm__r1'));
  writeFileSync(join(dir, 'b__endterm__r1', 'metrics.json'), '{"trunc');
  assert.throws(() => loadRuns(dir), /b__endterm__r1/);
});
