import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureSpec, dashboardUrl, parseTag, timeWindow } from './snapshot.ts';

test('dashboardUrl: the university dashboard over the run window, in kiosk mode', () => {
  assert.equal(dashboardUrl('http://localhost:3000', 1_000, 71_000), 'http://localhost:3000/d/university?from=1000&to=71000&kiosk');
  assert.equal(dashboardUrl('http://localhost:3000/', 1, 2), 'http://localhost:3000/d/university?from=1&to=2&kiosk');
});

test('timeWindow: t0..t1 of the run, widened by the padding on both sides', () => {
  assert.deepEqual(timeWindow({ t0: 10_000, t1: 80_000 }, 0), { from: 10_000, to: 80_000 });
  assert.deepEqual(timeWindow({ t0: 10_000, t1: 80_000 }, 5_000), { from: 5_000, to: 85_000 });
});

test('parseTag: <scenario>__<mode>__r<N>; anything else (a path, traversal) is rejected', () => {
  assert.deepEqual(parseTag('db-failure__endterm__r2'), { scenario: 'db-failure', mode: 'endterm', rep: 2 });
  assert.equal(parseTag('../etc__endterm__r1'), null);
  assert.equal(parseTag('db-failure__endterm'), null);
});

test('captureSpec: the default 1600x1000 shot, or with --full a viewport tall enough for every dashboard row', () => {
  assert.deepEqual(captureSpec('db-failure__endterm__r1', false), {
    file: 'db-failure__endterm__r1.png', viewport: { width: 1600, height: 1000 },
  });
  const full = captureSpec('db-failure__endterm__r1', true);
  assert.equal(full.file, 'db-failure__endterm__r1-full.png');
  assert.equal(full.viewport.width, 1600);
  assert.ok(full.viewport.height >= 1900, 'the dashboard grid is 47 rows deep (~1 850 px in kiosk mode)');
});
