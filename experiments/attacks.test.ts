import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import {
  ABUSE_PREFIX, ATTACK_AMOUNT, ATTACK_CATEGORIES, ATTACK_PREFIX, EXTRA_FIELD_SEEDS, MALFORMED_PAYMENT_BODIES, QUOTAS,
  REJECTION_SEEDS,
  abuseSet, algNoneToken, attackSet, bruteForceSet, bruteForceVerdict, burstSet, burstVerdict, hs256, summarizeBurst,
  type SentResult,
} from './attacks.ts';

const SECRET = 'test-secret-not-used-anywhere';
const NOW = 1_800_000_000;
const decode = (part: string) => JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
const bearer = (h: Record<string, string>) => h.authorization?.replace(/^Bearer /, '');

test('test attack set covers 7 categories', () => {
  const set = attackSet({ tag: 't1', s7Token: 'S7TOKEN', jwtSecret: SECRET, nowS: NOW });
  assert.equal(ATTACK_CATEGORIES.length, 7);
  assert.deepEqual([...new Set(set.map((a) => a.category))].sort(), [...ATTACK_CATEGORIES].sort());
  // no token: both a payment and a student creation
  const noToken = set.filter((a) => a.category === 'no-token');
  assert.ok(noToken.every((a) => a.headers.authorization === undefined));
  assert.deepEqual([...new Set(noToken.map((a) => `${a.method} ${a.path}`))].sort(), ['POST /api/payments', 'POST /api/students']);
  // the student-token attacks use s7's real token and target what s7 may not do
  const byCat = (c: string) => set.filter((a) => a.category === c);
  assert.ok(byCat('pay-for-other-student').every((a) => bearer(a.headers) === 'S7TOKEN' && JSON.parse(a.body!).studentId === 's8'));
  assert.ok(byCat('create-student').every((a) => a.method === 'POST' && a.path === '/api/students' && /^evil-\d+$/.test(JSON.parse(a.body!).id)));
  assert.ok(byCat('list-all-students').every((a) => a.method === 'GET' && a.path === '/api/students' && bearer(a.headers) === 'S7TOKEN'));
  // categories are interleaved (round-major), so the denials accumulate evenly over the attack
  assert.deepEqual(new Set(set.slice(0, 8).map((a) => a.category)).size, 7);
});

test('every attack request carries an attack- idempotency key', () => {
  const set = attackSet({ tag: 't1', s7Token: 'S7TOKEN', jwtSecret: SECRET, nowS: NOW });
  for (const a of set) {
    assert.ok(a.headers['idempotency-key'].startsWith(ATTACK_PREFIX), a.headers['idempotency-key']);
    assert.equal(a.key, a.headers['idempotency-key']);
    assert.match(a.rid, /^[A-Za-z0-9._-]{8,64}$/);      // accepted verbatim by app/core/context.py
    assert.equal(a.headers['x-request-id'], a.rid);
  }
  assert.equal(new Set(set.map((a) => a.key)).size, set.length);  // one key per attempt
});

test('attack volume clears the AuthFailureSpike threshold (more than 60 denials in 30 s)', () => {
  const set = attackSet({ tag: 't', s7Token: 'x', jwtSecret: SECRET, nowS: NOW });
  assert.ok(set.length > 60, `only ${set.length} attempts`);
});

test('forged, expired and alg:none tokens are what their category says', () => {
  const set = attackSet({ tag: 't', s7Token: 'x', jwtSecret: SECRET, nowS: NOW });
  const tok = (c: string) => bearer(set.find((a) => a.category === c)!.headers)!;
  const verifies = (t: string) => {
    const [h, p, s] = t.split('.');
    return createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url') === s;
  };

  const forged = tok('forged-signature');
  assert.equal(decode(forged.split('.')[0]).alg, 'HS256');
  assert.equal(verifies(forged), false);                 // signed with another key
  assert.equal(decode(forged.split('.')[1]).exp > NOW, true);

  const expired = tok('expired-token');
  assert.equal(verifies(expired), true);                 // a genuine signature: rejected only for exp
  assert.ok(decode(expired.split('.')[1]).exp <= NOW);

  const none = tok('alg-none');
  const [h, p, s] = none.split('.');
  assert.equal(decode(h).alg, 'none');
  assert.equal(s, '');
  assert.equal(decode(p).aud, 'ftu-api');
});

test('hs256 matches a reference HMAC-SHA256 JWT and algNoneToken has no signature', () => {
  const t = hs256({ sub: 'a' }, SECRET);
  const [h, p, s] = t.split('.');
  assert.deepEqual(decode(h), { alg: 'HS256', typ: 'JWT' });
  assert.equal(s, createHmac('sha256', SECRET).update(`${h}.${p}`).digest('base64url'));
  assert.ok(algNoneToken({ sub: 'a' }).endsWith('.'));
});

test('abuse set: 200 malformed payments from the rejection list, plus invalid JSON, oversized bodies and a bad path', () => {
  const set = abuseSet({ tag: 't', staffToken: 'STAFF' });
  const malformed = set.filter((a) => a.category === 'malformed-payment');
  assert.equal(malformed.length, 200);
  assert.ok(malformed.every((a) => MALFORMED_PAYMENT_BODIES.includes(a.body!)));
  assert.equal(new Set(malformed.map((a) => a.body)).size, REJECTION_SEEDS.length);  // every seed is used
  assert.equal(new Set(malformed.map((a) => a.key)).size, 200);                      // each request is distinct by its key
  for (const c of ['invalid-json', 'oversized-1MiB', 'bad-path-segment']) assert.ok(set.some((a) => a.category === c), c);
  assert.ok(set.find((a) => a.category === 'oversized-1MiB')!.body!.length > 1024 * 1024);
  for (const a of set) {
    assert.ok(a.key.startsWith(ABUSE_PREFIX));
    assert.equal(bearer(a.headers), 'STAFF');            // staff may pay for anyone: the body, not the policy, is wrong
  }
});

test('malformed bodies are the rejection seeds exactly as written: nothing added, so each is rejected for its own reason', () => {
  assert.equal(MALFORMED_PAYMENT_BODIES.length, 200);
  // every body is one of the seeds verbatim, and every seed is sent equally often
  for (const seed of REJECTION_SEEDS) {
    assert.equal(MALFORMED_PAYMENT_BODIES.filter((b) => b === seed).length, 200 / REJECTION_SEEDS.length, seed);
  }
  assert.ok(MALFORMED_PAYMENT_BODIES.every((b) => REJECTION_SEEDS.includes(b)));
  // only the deliberate extra-field seeds carry a field beyond studentId/amount (a closed model would
  // otherwise reject every body for that field alone, and the bound under test would go untested)
  const extra = (b: string) => Object.keys(JSON.parse(b)).filter((k) => k !== 'studentId' && k !== 'amount');
  assert.ok(MALFORMED_PAYMENT_BODIES.every((b) => !/__n/.test(b)));
  const withExtra = REJECTION_SEEDS.filter((b) => extra(b).length > 0);
  assert.equal(withExtra.length, EXTRA_FIELD_SEEDS);
  assert.deepEqual(withExtra.map(extra).flat().sort(), ['admin', 'note']);
  // the bounds are each covered by a seed on its own: e.g. 1e9 (NUMERIC overflow) with no other defect
  assert.ok(REJECTION_SEEDS.includes(JSON.stringify({ studentId: 's7', amount: 1e9 })));
  assert.ok(REJECTION_SEEDS.includes(JSON.stringify({ studentId: 's7', amount: 10000.01 })));
});

test('every attacker payment uses the distinctive attack amount, which legitimate traffic never pays', () => {
  const set = attackSet({ tag: 't', s7Token: 'x', jwtSecret: SECRET, nowS: NOW });
  const payments = set.filter((a) => a.path === '/api/payments');
  assert.ok(payments.length > 0);
  assert.ok(payments.every((a) => JSON.parse(a.body!).amount === ATTACK_AMOUNT));
  assert.notEqual(ATTACK_AMOUNT, 100);  // the workload and the demo pay 100 (workload.ts, demo.ts)
});

test('burst set: 1000 requests with the student token; brute-force set: 50 wrong-password logins', () => {
  const burst = burstSet({ tag: 't', token: 'S7' });
  assert.equal(burst.length, 1000);
  assert.ok(burst.every((a) => bearer(a.headers) === 'S7' && a.method === 'GET' && a.path === '/api/students/s7'));
  const bf = bruteForceSet({ tag: 't' });
  assert.equal(bf.length, 50);
  assert.ok(bf.every((a) => a.path === '/auth/token' && a.headers.authorization === undefined));
  assert.equal(new Set(bf.map((a) => JSON.parse(a.body!).password)).size, 50);
});

const res = (status: number, i: number, retryAfter: string | null = status === 429 ? '1' : null): SentResult =>
  ({ category: 'x', rid: `r-${i}`, key: `k-${i}`, status, ms: 1, retryAfter, sentAt: i });

test('burstVerdict: at least one burst admitted, Retry-After on every 429, never more than the cluster quota', () => {
  const statuses = (ok: number, limited: number) => [...Array(ok).fill(200), ...Array(limited).fill(429)].map(res);
  assert.equal(burstVerdict(summarizeBurst(statuses(60, 940), 2_000)), true);
  assert.equal(burstVerdict(summarizeBurst(statuses(1000, 0), 2_000)), false);          // never limited
  assert.equal(burstVerdict(summarizeBurst(statuses(5, 995), 2_000)), false);           // too few successes: not even one burst
  assert.equal(burstVerdict(summarizeBurst(statuses(QUOTAS.student.burst, 980), 2_000)), true);  // exactly one gateway's burst
  assert.equal(burstVerdict(summarizeBurst(statuses(400, 600), 2_000)), false);         // far over 2 gateways x quota
  const noRetryAfter = statuses(60, 940);
  noRetryAfter[500] = res(429, 500, null);
  assert.equal(burstVerdict(summarizeBurst(noRetryAfter, 2_000)), false);
  const with5xx = statuses(60, 940);
  with5xx[700] = res(503, 700);
  assert.equal(burstVerdict(summarizeBurst(with5xx, 2_000)), false);
  assert.equal(QUOTAS.student.burst, 20);
});

test('burstVerdict does not depend on where the 429s fall in send order (concurrent waves)', () => {
  // The observed run: 66 ok in 1363 ms, the first 429 at index 13 of the first concurrent wave (two
  // gateways each limit part of it). 66 is under 2 x (20 + 10 x 1.363) + 2, so the limiter was right.
  const observed = Array.from({ length: 1000 }, (_, i) => res(i === 13 || i >= 66 ? 429 : 200, Math.floor(i / 50)));
  // keep 66 successes: move the one at index 13 to the end of the successes
  observed[66] = res(200, 1);
  const s = summarizeBurst(observed, 1_363);
  assert.equal(s.ok, 66);
  assert.equal(s.firstLimitedAt, 13);
  assert.equal(burstVerdict(s), true);
  // and shuffling the order of the same results never changes the verdict
  const shuffled = observed.slice().reverse();
  assert.equal(burstVerdict(summarizeBurst(shuffled, 1_363)), true);
});

test('bruteForceVerdict: the first 5 attempts are 401, then 429s; never more 401s than the cluster quota allows', () => {
  const run = (s: number[]) => ({ statuses: s, elapsedMs: 1_500 });
  assert.equal(bruteForceVerdict(run([...Array(10).fill(401), ...Array(40).fill(429)])), true);
  assert.equal(bruteForceVerdict(run(Array(50).fill(401))), false);                     // never limited
  assert.equal(bruteForceVerdict(run([401, 401, 429, ...Array(47).fill(429)])), false);  // limited before 5
  assert.equal(bruteForceVerdict(run([...Array(40).fill(401), ...Array(10).fill(429)])), false);
  assert.equal(bruteForceVerdict(run([...Array(5).fill(401), 500, ...Array(44).fill(429)])), false);
});
