import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_ORDER, DEMOS, EXPECT, auditFor, bySecond, describeAlerts, distinctAbuse, ejectedTargets, formatAudit,
  grafanaLink, histogram, latencySummary, modeOf, onePerCategory, parseGauge, resolveDemo, unauthorizedVerdict,
} from './demo.ts';
import { ATTACK_CATEGORIES, REJECTION_SEEDS, abuseSet, attackSet } from './attacks.ts';
import { dashboardUrl } from './snapshot.ts';
import type { PromAlert } from './alerts.ts';

test('the default demo order is the plan order, and every demo has an expectation for all three modes', () => {
  assert.deepEqual(DEFAULT_ORDER, ['app-crash', 'db-failure', 'gateway-failure', 'unauthorized', 'abuse']);
  for (const name of ['outlier', 'alerts', 'node-failure', 'timetable']) assert.ok(DEMOS.includes(name), name);
  for (const name of DEMOS) {
    assert.deepEqual(Object.keys(EXPECT[name] ?? {}).sort(), ['baseline', 'endterm', 'midterm'], name);
    for (const text of Object.values(EXPECT[name])) assert.ok(text.length > 10, `${name}: empty expectation`);
  }
  // the spec minimum: at least 3 scenarios, including a service failure and a security test
  assert.ok(DEFAULT_ORDER.length >= 3);
  assert.ok(DEFAULT_ORDER.includes('gateway-failure') && DEFAULT_ORDER.includes('unauthorized'));
});

test('resolveDemo: all -> default order, full -> every demo, a name -> itself, anything else -> null', () => {
  assert.deepEqual(resolveDemo(undefined), DEFAULT_ORDER);
  assert.deepEqual(resolveDemo('all'), DEFAULT_ORDER);
  assert.deepEqual(resolveDemo('full'), DEMOS);
  assert.deepEqual(resolveDemo('outlier'), ['outlier']);
  assert.equal(resolveDemo('rm -rf'), null);
  assert.equal(resolveDemo('toString'), null);  // not an inherited property
});

test('modeOf: the gateway reports mode; older gateways only ft; anything else is not running', () => {
  assert.equal(modeOf({ mode: 'endterm', ft: true }), 'endterm');
  assert.equal(modeOf({ ft: true }), 'midterm');
  assert.equal(modeOf({ ft: false }), 'baseline');
  assert.equal(modeOf({}), null);
  assert.equal(modeOf({ mode: 'bogus', ft: true }), 'midterm');
  assert.equal(modeOf(null), null);
});

test('histogram: counts per status in ascending order, 0 shown as 000 (no answer)', () => {
  assert.equal(histogram([200, 503, 200, 0, 200]), '000 x1  200 x3  503 x1');
  assert.equal(histogram([]), '(no requests)');
});

test('latencySummary: average and nearest-rank p95, rounded to ms', () => {
  assert.deepEqual(latencySummary([]), { n: 0, avgMs: 0, p95Ms: 0 });
  const ms = Array.from({ length: 100 }, (_, i) => i + 1);  // 1..100
  assert.deepEqual(latencySummary(ms), { n: 100, avgMs: 51, p95Ms: 95 });
  assert.deepEqual(latencySummary([10.4]), { n: 1, avgMs: 10, p95Ms: 10 });
});

test('bySecond: requests grouped by whole seconds since t0, every second present', () => {
  const t0 = 10_000;
  const recs = [
    { ts: 10_100, status: 200, ms: 5 }, { ts: 10_900, status: 200, ms: 7 },
    { ts: 12_050, status: 502, ms: 1 }, { ts: 9_000, status: 200, ms: 1 },  // before t0: dropped
  ];
  const out = bySecond(recs, t0, 3);
  assert.deepEqual(out.map((b) => b.second), [0, 1, 2]);
  assert.deepEqual(out[0].recs.map((r) => r.status), [200, 200]);
  assert.deepEqual(out[1].recs, []);
  assert.deepEqual(out[2].recs.map((r) => r.status), [502]);
});

test('parseGauge / ejectedTargets: reads the instance_ejected series from a /metrics page', () => {
  const text = [
    '# HELP instance_ejected Outlier ejection state per instance (1 ejected).',
    '# TYPE instance_ejected gauge',
    'instance_ejected{target="http://student-1:3000"} 1.0',
    'instance_ejected{target="http://student-2:3000"} 0.0',
    'instance_ejected_other{target="x"} 1.0',
    'instance_up{target="http://student-1:3000"} 1.0',
  ].join('\n');
  assert.deepEqual(parseGauge(text, 'instance_ejected'), [
    { labels: { target: 'http://student-1:3000' }, value: 1 },
    { labels: { target: 'http://student-2:3000' }, value: 0 },
  ]);
  assert.deepEqual(ejectedTargets(text), ['http://student-1:3000']);
  assert.deepEqual(parseGauge('', 'instance_ejected'), []);
});

test('auditFor / formatAudit: only audit lines of the given rids; secrets never printed', () => {
  const lines = [
    { kind: 'audit', rid: 'attack-d-1', outcome: 'deny', reason: 'missing_token', status: 401, action: 'POST /api/payments', sub: null, svc: 'gateway-2' },
    { kind: 'request', rid: 'attack-d-1', status: 401 },
    { kind: 'audit', rid: 'someone-else', outcome: 'deny', reason: 'expired' },
    { kind: 'audit', rid: 'attack-d-2', outcome: 'deny', reason: 'not_owner', status: 403, action: 'POST /api/payments', sub: 's7', role: 'student', svc: 'gateway-1' },
  ].map((l) => JSON.stringify(l)).join('\n') + '\n{"kind":"audit","rid":"attack-d-3"';  // a partial last line
  const got = auditFor(lines, new Set(['attack-d-1', 'attack-d-2', 'attack-d-3']));
  assert.deepEqual(got.map((e) => e.rid), ['attack-d-1', 'attack-d-2']);
  assert.equal(formatAudit(got[0]), 'gateway-2  rid=attack-d-1  deny 401 missing_token  POST /api/payments  sub=-');
  assert.equal(formatAudit(got[1]), 'gateway-1  rid=attack-d-2  deny 403 not_owner  POST /api/payments  sub=s7 (student)');
});

test('describeAlerts: one line per alert name, firing before pending, inactive ignored', () => {
  const alerts: PromAlert[] = [
    { labels: { alertname: 'HighErrorRate' }, state: 'pending' },
    { labels: { alertname: 'DatabaseDown', job: 'postgres' }, state: 'firing' },
    { labels: { alertname: 'InstanceDown', target: 'a' }, state: 'pending' },
    { labels: { alertname: 'InstanceDown', target: 'b' }, state: 'firing' },
    { labels: { alertname: 'Old' }, state: 'inactive' },
  ];
  assert.deepEqual(describeAlerts(alerts), ['firing   DatabaseDown', 'firing   InstanceDown', 'pending  HighErrorRate']);
  assert.deepEqual(describeAlerts([]), []);
});

test('onePerCategory: the first request of each listed category, in the listed order', () => {
  const set = attackSet({ tag: 'demo', s7Token: 'S7', jwtSecret: 'k', nowS: 1_800_000_000 });
  const cats = ['no-token', 'forged-signature', 'pay-for-other-student'] as const;
  const picked = onePerCategory(set, cats);
  assert.deepEqual(picked.map((r) => r.category), [...cats]);
  assert.ok(picked.every((r) => ATTACK_CATEGORIES.includes(r.category as never)));
  assert.equal(picked[0].path, '/api/payments');  // no-token round 0 is the payment, not the student creation
  assert.equal(picked[0].headers.authorization, undefined);
});

test('distinctAbuse: each rejection seed once, plus the invalid-JSON, oversized and bad-path requests', () => {
  const picked = distinctAbuse(abuseSet({ tag: 'demo' }));
  assert.equal(picked.length, REJECTION_SEEDS.length + 3);
  assert.deepEqual(picked.filter((r) => r.category === 'malformed-payment').map((r) => r.body), REJECTION_SEEDS);
  assert.deepEqual(picked.slice(-3).map((r) => r.category), ['invalid-json', 'oversized-1MiB', 'bad-path-segment']);
});

test('unauthorizedVerdict: denied and DB unchanged is a pass; anything accepted or written is called out', () => {
  assert.match(unauthorizedVerdict([{ status: 401 }, { status: 403 }], 0), /^PASS/);
  assert.match(unauthorizedVerdict([{ status: 401 }, { status: 201 }], 1), /^ACCEPTED: 1 of 2 .* 1 attacker payment/);
  assert.match(unauthorizedVerdict([{ status: 401 }, { status: 0 }], 0), /^INCONCLUSIVE/);
  assert.match(unauthorizedVerdict([{ status: 401 }], null), /DB not checked/);
});

test('grafanaLink: the university dashboard over the step window, padded, not in kiosk mode', () => {
  assert.equal(grafanaLink('http://localhost:3000', 100_000, 160_000, 15_000), 'http://localhost:3000/d/university?from=85000&to=175000');
  assert.equal(dashboardUrl('http://localhost:3000', 1, 2), 'http://localhost:3000/d/university?from=1&to=2&kiosk');  // snapshots unchanged
});
