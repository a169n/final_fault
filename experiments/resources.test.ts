import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseInspect, restartedBetween, type ContainerState } from './resources.ts';

test('parseInspect reads docker inspect lines and drops unreadable ones', () => {
  const out = parseInspect([
    '/ft-student-1-1 0 2026-11-09T17:00:00.1Z true',
    '/ft-gateway-1-1 2 2026-11-09T17:01:00.2Z true',
    'garbage',
    '/ft-job-1 x 2026-11-09T17:00:00Z false',
    '',
  ].join('\n'));
  assert.deepEqual(out, [
    { name: 'ft-gateway-1-1', restartCount: 2, startedAt: '2026-11-09T17:01:00.2Z', running: true },
    { name: 'ft-student-1-1', restartCount: 0, startedAt: '2026-11-09T17:00:00.1Z', running: true },
  ]);
});

test('restartedBetween flags a restart, a re-created/started container, a stop and a disappearance', () => {
  const c = (name: string, restartCount = 0, startedAt = 'T0', running = true): ContainerState => ({ name, restartCount, startedAt, running });
  const before = [c('a'), c('b'), c('c'), c('d'), c('e'), c('job', 0, 'T0', false)];
  const after = [
    c('a'),                     // unchanged
    c('b', 1, 'T1'),            // restarted by the restart policy
    c('c', 0, 'T2'),            // stopped and started again (RestartCount unchanged, StartedAt moved)
    c('d', 0, 'T0', false),     // went down and stayed down
    // e: gone
    c('job', 0, 'T0', false),   // a finished one-shot that stayed finished
  ];
  assert.deepEqual(restartedBetween(before, after), ['b', 'c', 'd', 'e']);
  assert.deepEqual(restartedBetween(before, before), []);
});
