// Request generators and verdicts for the two security scenarios (Task 15):
//   E9 unauthorized-access: tokens that must not work, and a real student token used beyond its rights
//   E10 abuse: malformed input, a request burst and a login brute force
// The generators are pure (unit-tested in attacks.test.ts); `send`/`sendPaced` do the HTTP.
// Synthetic data only, and only ever against the local stack (http://localhost:8080).
import { createHmac } from 'node:crypto';

export const ATTACK_PREFIX = 'attack-';
export const ABUSE_PREFIX = 'abuse-';

export const ATTACK_CATEGORIES = [
  'no-token',               // POST /api/payments and POST /api/students without Authorization
  'forged-signature',       // an admin token signed with a key that is not JWT_SECRET
  'expired-token',          // a genuinely signed token whose exp has passed
  'alg-none',               // an unsigned admin token (alg: none)
  'pay-for-other-student',  // student s7 paying for s8
  'create-student',         // student s7 creating student evil-N
  'list-all-students',      // student s7 listing every student
] as const;
export type AttackCategory = (typeof ATTACK_CATEGORIES)[number];

// The gateway's quotas (app/security/rate_limit.py DEFAULTS). They are per gateway, and endterm runs
// two gateways behind nginx (redundant.conf), so the cluster admits up to GATEWAYS x the quota.
export const QUOTAS = {
  student: { ratePerS: 10, burst: 20 },
  login: { ratePerS: 1, burst: 5 },
};
export const GATEWAYS = 2;

export type HttpReq = {
  category: string;
  method: 'GET' | 'POST';
  path: string;
  headers: Record<string, string>;
  body?: string;
  key: string;   // the Idempotency-Key (attack-/abuse- prefix), sent on every request so the DB check can find it
  rid: string;   // x-request-id, the same string: the audit line of each attempt is found by it
};

export type SentResult = {
  category: string;
  rid: string;
  key: string;
  status: number;        // 0: transport error or client timeout
  ms: number;
  retryAfter: string | null;
  sentAt: number;
  err?: string;
};

// ---- JWTs (HS256 as app/security/tokens.py issues them) ----

const b64url = (v: unknown) => Buffer.from(typeof v === 'string' ? v : JSON.stringify(v)).toString('base64url');

export function hs256(claims: Record<string, unknown>, secret: string): string {
  const signing = `${b64url({ alg: 'HS256', typ: 'JWT' })}.${b64url(claims)}`;
  return `${signing}.${createHmac('sha256', secret).update(signing).digest('base64url')}`;
}

export function algNoneToken(claims: Record<string, unknown>): string {
  return `${b64url({ alg: 'none', typ: 'JWT' })}.${b64url(claims)}.`;
}

const adminClaims = (iat: number, exp: number) =>
  ({ sub: 'admin', role: 'admin', student_id: null, iss: 'ftu-auth', aud: 'ftu-api', iat, exp });

// ---- E9: the attack set ----

// Every attacker payment uses this amount, which no legitimate traffic uses (the workload and the demo
// pay 100). verify() counts payments by it, so an attacker payment is found even when the mode stores
// a fresh UUID instead of the Idempotency-Key (baseline: idempotency.payment_key ignores the header).
export const ATTACK_AMOUNT = 13.37;
const payS8Body = JSON.stringify({ studentId: 's8', amount: ATTACK_AMOUNT });
const evilBody = (n: number) => JSON.stringify({ id: `evil-${n}`, name: 'Mallory' });

export type AttackOpts = {
  tag: string;               // per run, keeps keys and rids unique across runs
  s7Token?: string;          // a real token of student s7 (undefined: sent without Authorization)
  jwtSecret?: string;        // JWT_SECRET from .env, used only to make a token that does NOT verify
  nowS?: number;             // the clock, in seconds, for iat/exp (defaults to now)
};

type Target = { method: 'GET' | 'POST'; path: string; body?: string };

// One reusable builder per category: given the loop index, it returns the request's target and auth.
function builders(opts: Required<Pick<AttackOpts, 'nowS'>> & AttackOpts): Record<AttackCategory, (i: number) => { target: Target; auth?: string }> {
  const { s7Token, nowS } = opts;
  const secret = opts.jwtSecret ?? 'unknown-signing-key';
  // forged: a well-formed admin token signed with a DIFFERENT key, so the signature check rejects it.
  const forged = hs256(adminClaims(nowS - 60, nowS + 900), secret + '-forged');
  const expired = hs256(adminClaims(nowS - 2_000, nowS - 1_000), secret);  // genuine signature, exp in the past
  const none = algNoneToken(adminClaims(nowS - 60, nowS + 900));
  const payTargets: Target[] = [
    { method: 'POST', path: '/api/payments', body: payS8Body },
    { method: 'POST', path: '/api/students', body: evilBody(0) },
  ];
  return {
    'no-token': (i) => ({ target: payTargets[i % 2] }),
    'forged-signature': () => ({ target: { method: 'POST', path: '/api/payments', body: payS8Body }, auth: forged }),
    'expired-token': () => ({ target: { method: 'POST', path: '/api/payments', body: payS8Body }, auth: expired }),
    'alg-none': () => ({ target: { method: 'POST', path: '/api/payments', body: payS8Body }, auth: none }),
    'pay-for-other-student': () => ({ target: { method: 'POST', path: '/api/payments', body: payS8Body }, auth: s7Token }),
    'create-student': (i) => ({ target: { method: 'POST', path: '/api/students', body: evilBody(i) }, auth: s7Token }),
    'list-all-students': () => ({ target: { method: 'GET', path: '/api/students' }, auth: s7Token }),
  };
}

// 60 attempts: the AuthFailureSpike threshold is > 2/s over 30 s, i.e. > 60 denials in one window,
// so the attack runs a little above that (ALERTS.md). Categories are interleaved round by round, so
// the denials accumulate evenly rather than one category at a time.
const ROUNDS = 9;  // 9 x 7 = 63 attempts (> 60)

export function attackSet(opts: AttackOpts): HttpReq[] {
  const nowS = opts.nowS ?? Math.floor(Date.now() / 1000);
  const make = builders({ ...opts, nowS });
  const out: HttpReq[] = [];
  let n = 0;
  for (let round = 0; round < ROUNDS; round++) {
    for (const category of ATTACK_CATEGORIES) {
      const { target, auth } = make[category](round);
      const key = `${ATTACK_PREFIX}${opts.tag}-${n}`;
      const rid = key;  // attack-<tag>-<n>: matches app/core/context.py (8..64 of [A-Za-z0-9._-])
      const headers: Record<string, string> = { 'x-request-id': rid, 'idempotency-key': key };
      if (target.body !== undefined) headers['content-type'] = 'application/json';
      if (auth) headers.authorization = `Bearer ${auth}`;
      out.push({ category, method: target.method, path: target.path, headers, body: target.body, key, rid });
      n++;
    }
  }
  return out;
}

// ---- E10: the abuse sets ----

// The Task 10 rejection list. Each is a JSON string the gateway/service must answer with a 4xx
// (422/400/413), never a 5xx. `amount: 1e9` overflows NUMERIC(10,2) in baseline. Each seed is invalid
// for exactly the reason its line names: only the two seeds about extra fields carry a field beyond
// studentId/amount, so a missing bound (e.g. `le=10_000`) shows up as a non-4xx for its own seed.
export const EXTRA_FIELD_SEEDS = 2;  // the `admin` and `note` seeds below
export const REJECTION_SEEDS: string[] = [
  JSON.stringify({ studentId: 's7', amount: -1 }),
  JSON.stringify({ studentId: 's7', amount: 0 }),
  JSON.stringify({ studentId: 's7', amount: 10000.01 }),
  JSON.stringify({ studentId: 's7', amount: 1e9 }),
  JSON.stringify({ studentId: 's7', amount: 'abc' }),
  JSON.stringify({ studentId: 's7', amount: 1.001 }),
  JSON.stringify({ studentId: 's7', amount: null }),
  JSON.stringify({ studentId: 's7', amount: true }),
  JSON.stringify({ studentId: "s1'; DROP TABLE students;--", amount: 100 }),
  JSON.stringify({ studentId: '', amount: 100 }),
  JSON.stringify({ studentId: 'S1', amount: 100 }),
  JSON.stringify({ studentId: 's1234567', amount: 100 }),
  JSON.stringify({ studentId: 's7\n', amount: 100 }),
  JSON.stringify({ studentId: 7, amount: 100 }),
  JSON.stringify({ studentId: 's7', amount: 100, admin: true }),  // extra field: extra='forbid'
  JSON.stringify({ studentId: 's7' }),                            // missing amount
  JSON.stringify({ amount: 100 }),                                // missing studentId
  JSON.stringify({}),                                            // empty object
  JSON.stringify({ studentId: 's7', amount: 100, note: 'x'.repeat(200) }),  // extra field, long value
  JSON.stringify({ studentId: 's7', amount: { $gt: 0 } }),        // object where a number is required
];

// 200 sends cycling over the seeds, each body exactly as written above (10 sends per seed). The
// bodies repeat on purpose: nothing is added to make them distinct (an extra field would make every
// body a 422 for that field alone and hide the seed under test); the per-request Idempotency-Key and
// x-request-id already make each request distinct.
export const MALFORMED_PAYMENT_BODIES: string[] = Array.from({ length: 200 }, (_, i) => REJECTION_SEEDS[i % REJECTION_SEEDS.length]);

export const INVALID_JSON = '{"studentId": "s7", "amount": 100';   // truncated: not parseable
export const BAD_PATH_SEGMENT = '/api/students/..%2f..%2fetc';     // a path segment outside [A-Za-z0-9._-]{1,64}

export type AbuseOpts = { tag: string; staffToken?: string };

export function abuseSet(opts: AbuseOpts): HttpReq[] {
  const { tag, staffToken } = opts;
  const auth: Record<string, string> = staffToken ? { authorization: `Bearer ${staffToken}` } : {};
  const out: HttpReq[] = [];
  let n = 0;
  const push = (category: string, method: 'GET' | 'POST', path: string, body: string | undefined, json = true) => {
    const key = `${ABUSE_PREFIX}${tag}-${n}`;
    const headers: Record<string, string> = { 'x-request-id': key, 'idempotency-key': key, ...auth };
    if (json && body !== undefined) headers['content-type'] = 'application/json';
    out.push({ category, method, path, headers, body, key, rid: key });
    n++;
  };
  for (const body of MALFORMED_PAYMENT_BODIES) push('malformed-payment', 'POST', '/api/payments', body);
  push('invalid-json', 'POST', '/api/payments', INVALID_JSON);
  // A 1 MiB body: over the 16 KiB gateway limit, must be a 413 before any upstream call.
  push('oversized-1MiB', 'POST', '/api/payments', JSON.stringify({ studentId: 's7', amount: 100, pad: 'A'.repeat(1024 * 1024) }));
  push('bad-path-segment', 'GET', BAD_PATH_SEGMENT, undefined);
  return out;
}

// A burst of 1000 GETs with the s7 student token: the student quota (10/s burst 20 per gateway) must
// turn most into 429. Reads of s7's own record, so only the rate limit (not the policy) rejects them.
export function burstSet(opts: { tag: string; token?: string }): HttpReq[] {
  const auth: Record<string, string> = opts.token ? { authorization: `Bearer ${opts.token}` } : {};
  return Array.from({ length: 1000 }, (_, i) => {
    const key = `${ABUSE_PREFIX}${opts.tag}-burst-${i}`;
    return { category: 'burst', method: 'GET' as const, path: '/api/students/s7',
      headers: { 'x-request-id': key, ...auth }, key, rid: key };
  });
}

// 50 logins with a wrong password: the login quota (1/s burst 5 per IP) must turn the later ones into
// 429. The first few get 401 (invalid credentials); after the burst, 429.
export function bruteForceSet(opts: { tag: string }): HttpReq[] {
  return Array.from({ length: 50 }, (_, i) => {
    const key = `${ABUSE_PREFIX}${opts.tag}-login-${i}`;
    return { category: 'bruteforce', method: 'POST' as const, path: '/auth/token',
      headers: { 'content-type': 'application/json', 'x-request-id': key },
      body: JSON.stringify({ username: 's7', password: `wrong-${i}` }), key, rid: key };
  });
}

// ---- verdicts over the observed results (used by verify() and unit-tested) ----

export type BurstSummary = {
  sent: number;
  ok: number;                   // 2xx
  limited: number;              // 429
  limitedWithRetryAfter: number;
  other: number;                // anything else, incl. 5xx and transport errors
  firstLimitedAt: number | null;  // informational only: the waves are concurrent, so this is not processing order
  elapsedMs: number;
};

export function summarizeBurst(results: SentResult[], elapsedMs: number): BurstSummary {
  let ok = 0, limited = 0, limitedWithRetryAfter = 0, other = 0;
  let firstLimitedAt: number | null = null;
  const sorted = results.slice().sort((a, b) => a.sentAt - b.sentAt);
  sorted.forEach((r, idx) => {
    if (r.status >= 200 && r.status < 300) ok++;
    else if (r.status === 429) {
      limited++;
      if (r.retryAfter != null) limitedWithRetryAfter++;
      if (firstLimitedAt === null) firstLimitedAt = idx;
    } else other++;
  });
  return { sent: results.length, ok, limited, limitedWithRetryAfter, other, firstLimitedAt, elapsedMs };
}

// The burst must: be limited at all; show Retry-After on every 429; produce no non-429 non-2xx
// (no 5xx); admit at least one gateway's burst (a limiter that refuses earlier is over-eager); and let
// through no more than the cluster can admit (GATEWAYS x (burst + rate x window)). The checks are on
// counts only: sendBurst sends concurrent waves of 50, so the position of a 429 among results sorted
// by send time says nothing about when a gateway processed it (two gateways each limit part of the
// first wave, and those 429s land anywhere in it).
export function burstVerdict(s: BurstSummary): boolean {
  if (s.limited === 0) return false;
  if (s.other > 0) return false;
  if (s.limited !== s.limitedWithRetryAfter) return false;
  if (s.ok < QUOTAS.student.burst) return false;  // not even one gateway's burst admitted
  const windowS = s.elapsedMs / 1000;
  const clusterCeiling = GATEWAYS * (QUOTAS.student.burst + QUOTAS.student.ratePerS * windowS);
  return s.ok <= clusterCeiling + GATEWAYS;  // small slack for timing of the refill
}

export type BruteForce = { statuses: number[]; elapsedMs: number };

// The brute force must: be limited at all; let through no more 401s than the cluster login quota;
// not start limiting before the per-gateway burst of 5; and never 5xx.
export function bruteForceVerdict(bf: BruteForce): boolean {
  const unauthorized = bf.statuses.filter((s) => s === 401).length;
  const limited = bf.statuses.filter((s) => s === 429).length;
  const serverErrors = bf.statuses.filter((s) => s >= 500 || s === 0).length;
  if (limited === 0 || serverErrors > 0) return false;
  const windowS = bf.elapsedMs / 1000;
  const clusterCeiling = GATEWAYS * (QUOTAS.login.burst + QUOTAS.login.ratePerS * windowS);
  if (unauthorized > clusterCeiling + GATEWAYS) return false;
  // the first 429 must come no earlier than one gateway's burst of 5 (fewer would be over-eager)
  const firstLimited = bf.statuses.findIndex((s) => s === 429);
  return firstLimited === -1 ? false : firstLimited >= QUOTAS.login.burst;
}

// ---- HTTP senders (not pure; used by verify()) ----

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function sendOne(gateway: string, req: HttpReq, timeoutMs = 5_000): Promise<SentResult> {
  const sentAt = Date.now();
  try {
    const res = await fetch(gateway + req.path, {
      method: req.method, headers: req.headers, body: req.body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    await res.text().catch(() => '');
    return { category: req.category, rid: req.rid, key: req.key, status: res.status,
      ms: Date.now() - sentAt, retryAfter: res.headers.get('retry-after'), sentAt };
  } catch (e) {
    return { category: req.category, rid: req.rid, key: req.key, status: 0,
      ms: Date.now() - sentAt, retryAfter: null, sentAt, err: (e as Error).message };
  }
}

// Send sequentially (keeps the rids ordered and the denial rate steady for the alert). Returns in
// order. `paceMs` spaces the requests so a per-principal quota is not tripped by the attack's own rate.
export async function send(gateway: string, reqs: HttpReq[], timeoutMs?: number, paceMs = 0): Promise<SentResult[]> {
  const out: SentResult[] = [];
  for (const req of reqs) {
    out.push(await sendOne(gateway, req, timeoutMs));
    if (paceMs > 0) await sleep(paceMs);
  }
  return out;
}

// Send a burst as fast as possible within a budget, in small waves, so it actually overruns the quota.
export async function sendBurst(gateway: string, reqs: HttpReq[], budgetMs: number): Promise<{ results: SentResult[]; elapsedMs: number }> {
  const started = Date.now();
  const results: SentResult[] = [];
  const wave = 50;
  for (let i = 0; i < reqs.length; i += wave) {
    const batch = reqs.slice(i, i + wave);
    results.push(...await Promise.all(batch.map((r) => sendOne(gateway, r, 4_000))));
    if (Date.now() - started > budgetMs) {  // stop sending once the budget is spent; keep what we have
      break;
    }
    await sleep(5);
  }
  return { results, elapsedMs: Date.now() - started };
}
