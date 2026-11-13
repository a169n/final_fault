import { test } from 'node:test';
import assert from 'node:assert/strict';
import { binRecs, componentA, parallel, pool, reliabilityOf, series, type Bin } from './reliability.ts';
import type { Rec } from './workload.ts';

const bins = (spec: Record<number, [number, number]>): Map<number, Bin> =>
  new Map(Object.entries(spec).map(([k, [total, ok]]) => [Number(k), { total, ok }]));
const full = (n: number, bad: number[] = []) => bins(Object.fromEntries(
  Array.from({ length: n }, (_, i) => [i, bad.includes(i) ? [100, 50] : [100, 100]])));

test('a second is failed below 99 % success, not at 99 %', () => {
  const r = reliabilityOf(bins({ 0: [100, 99], 1: [100, 98], 2: [100, 100] }));
  assert.equal(r.failedSeconds, 1);
  assert.deepEqual(r.episodes, [{ startS: 1, endS: 2, failedSeconds: 1 }]);
});

test('failed seconds one good second apart are one failure; two apart are two', () => {
  assert.equal(reliabilityOf(full(20, [5, 6, 8])).failures, 1);
  assert.equal(reliabilityOf(full(20, [5, 6, 9])).failures, 2);
});

test('MTTR, MTTF, MTBF, availability and failure rate from pooled runs', () => {
  const p = pool([reliabilityOf(full(100, [10, 11, 12, 13])), reliabilityOf(full(100, [50, 51]))]);
  assert.equal(p.T, 200);
  assert.equal(p.failures, 2);
  assert.equal(p.downtime, 6);
  assert.equal(p.mttr, 3);
  assert.equal(p.mttf, 97);
  assert.equal(p.mtbf, 100);                    // = MTTF + MTTR
  assert.equal(p.availability, 0.97);           // = MTTF / (MTTF + MTTR)
  assert.ok(Math.abs(p.lambdaPerHour! - 2 / (194 / 3600)) < 1e-9);
});

test('no failure: MTTF is censored and the rate gets the rule-of-three bound', () => {
  const p = pool([reliabilityOf(full(600)), reliabilityOf(full(600))]);
  assert.equal(p.censored, true);
  assert.equal(p.mttf, null);
  assert.equal(p.lambdaPerHour, 0);
  assert.equal(p.lambdaUpper95PerHour, 3 / (1200 / 3600));
});

test('binRecs leaves out requests cut off by the end of the window and applies the filter', () => {
  const rec = (ts: number, ok: boolean, op = 'students', abandoned = false) => ({ ts, ok, op, abandoned }) as unknown as Rec;
  const b = binRecs([rec(1000, true), rec(1500, false, 'payments'), rec(2100, false, 'students', true)], 1000);
  assert.deepEqual([...b.entries()], [[0, { total: 2, ok: 1 }]]);
  assert.deepEqual([...binRecs([rec(1000, true), rec(1500, false, 'payments')], 1000, (r) => r.op === 'payments').entries()],
    [[0, { total: 1, ok: 0 }]]);
});

test('series multiplies availabilities, parallel multiplies unavailabilities', () => {
  assert.ok(Math.abs(series(0.9, 0.9) - 0.81) < 1e-12);
  assert.ok(Math.abs(parallel(0.9, 0.9) - 0.99) < 1e-12);
  assert.equal(componentA(99, 1), 0.99);
});
