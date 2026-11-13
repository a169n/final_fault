import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyse, faultWindow, recoveryByOp, renderMarkdown } from './recovery-by-op.ts';
import type { Rec } from './workload.ts';

const T0 = 1_000_000;
const rec = (t: number, op: string, ok: boolean, extra: Partial<Rec> = {}): Rec => ({
  ts: T0 + t, op, status: ok ? 200 : 503, ok, degraded: false, ms: 5, rid: `r-${op}-${t}`, rateLimited: false, ...extra,
});

// reads succeed throughout; payments fail from +1 s to +4 s and are back at +5 s
function writeOutage(): Rec[] {
  const recs: Rec[] = [];
  for (let t = 0; t < 10_000; t += 500) {
    recs.push(rec(t, 'students', true));
    recs.push(rec(t + 10, 'payments', !(t >= 1_000 && t <= 4_000)));
  }
  return recs;
}

test('recoveryByOp: a payment outage that the reads hide is seen per operation', () => {
  const byOp = recoveryByOp(writeOutage(), T0);
  const pay = byOp.find((o) => o.op === 'payments')!;
  assert.equal(pay.failures, 7);
  assert.equal(pay.firstFailMs, 1_010);
  assert.equal(pay.lastFailMs, 4_010);
  assert.equal(pay.recoveredMs, 4_510);
  const reads = byOp.find((o) => o.op === 'students')!;
  assert.deepEqual(reads, { op: 'students', failures: 0, firstFailMs: null, lastFailMs: null, recoveredMs: null });
});

test('recoveryByOp: window-close abandons are not failures, and failures before the injection are ignored', () => {
  const recs = [
    rec(-500, 'payments', false),
    rec(100, 'payments', true),
    rec(200, 'payments', false, { err: 'abandoned_at_window_close', abandoned: true }),
  ];
  const pay = recoveryByOp(recs, T0).find((o) => o.op === 'payments')!;
  assert.equal(pay.failures, 0);
  assert.equal(pay.recoveredMs, null);
});

test('recoveryByOp: no success after the last failure -> recoveredMs is null', () => {
  const pay = recoveryByOp([rec(0, 'payments', true), rec(100, 'payments', false)], T0).find((o) => o.op === 'payments')!;
  assert.equal(pay.lastFailMs, 100);
  assert.equal(pay.recoveredMs, null);
});

test('faultWindow: counts only [inject, repair), and pools reads', () => {
  const recs = [
    rec(-1, 'students', false),
    rec(0, 'students', false, { ms: 2_400 }),
    rec(10, 'transcripts', true, { ms: 3 }),
    rec(20, 'payments', false),
    rec(1_000, 'students', false),  // at the repair: outside
  ];
  const w = faultWindow(recs, T0, T0 + 1_000);
  const reads = w.find((x) => x.op === 'reads')!;
  assert.equal(reads.requests, 2);
  assert.equal(reads.failed, 1);
  assert.deepEqual(reads.latencies.sort((a, b) => a - b), [3, 2_400]);
  assert.equal(w.find((x) => x.op === 'all')!.requests, 3);
});

test('renderMarkdown lists only operations that failed, with recovery after the repair', () => {
  const run = analyse({ scenario: 'db-failure', mode: 'endterm', rep: 1, injectTs: T0, repairTs: T0 + 3_000, recs: writeOutage() });
  const md = renderMarkdown([run], 'test');
  assert.match(md, /\| db-failure \| endterm \| payments \| 7 \| 1\.01 s \[1\/3\] \| 4\.01 s \[1\/3\] \| 4\.51 s \[1\/3\] \| 1\.51 s \[1\/3\] \|/);
  assert.doesNotMatch(md, /\| db-failure \| endterm \| students \| 0 \|/);
});
