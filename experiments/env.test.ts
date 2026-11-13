import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildEnv, chaosHeaders, formatEnv, parseEnv, SECRET_KEYS } from './env.ts';

test('baseline: FT off, ENDTERM off, no restart, single nginx', () => {
  const e = buildEnv('baseline', {});
  assert.equal(e.FT_ENABLED, '0');
  assert.equal(e.ENDTERM_ENABLED, '0');
  assert.equal(e.RESTART_POLICY, 'no');
  assert.equal(e.NGINX_PROFILE, 'single');
});

test('midterm: FT on, ENDTERM off, self-healing, single nginx', () => {
  const e = buildEnv('midterm', {});
  assert.equal(e.FT_ENABLED, '1');
  assert.equal(e.ENDTERM_ENABLED, '0');
  assert.equal(e.RESTART_POLICY, 'unless-stopped');
  assert.equal(e.NGINX_PROFILE, 'single');
});

test('endterm: FT on, ENDTERM on, self-healing, redundant nginx', () => {
  const e = buildEnv('endterm', {});
  assert.equal(e.FT_ENABLED, '1');
  assert.equal(e.ENDTERM_ENABLED, '1');
  assert.equal(e.RESTART_POLICY, 'unless-stopped');
  assert.equal(e.NGINX_PROFILE, 'redundant');
});

test('existing secrets are kept', () => {
  assert.equal(buildEnv('endterm', { JWT_SECRET: 'x' }).JWT_SECRET, 'x');
});

test('missing secrets are generated: non-empty, at least 24 characters', () => {
  const e = buildEnv('baseline', {});
  assert.equal(SECRET_KEYS.length, 10);
  for (const k of SECRET_KEYS) {
    assert.ok(e[k], `${k} missing`);
    assert.ok(e[k].length >= 24, `${k} too short: ${e[k].length}`);
  }
});

test('generated secrets are distinct', () => {
  const e = buildEnv('midterm', {});
  assert.equal(new Set(SECRET_KEYS.map((k) => e[k])).size, SECRET_KEYS.length);
});

test('mode keys overwrite stale values from an earlier mode', () => {
  const e = buildEnv('baseline', { FT_ENABLED: '1', ENDTERM_ENABLED: '1', RESTART_POLICY: 'unless-stopped' });
  assert.equal(e.FT_ENABLED, '0');
  assert.equal(e.ENDTERM_ENABLED, '0');
  assert.equal(e.RESTART_POLICY, 'no');
});

test('unknown mode is rejected', () => {
  assert.throws(() => buildEnv('chaos' as never, {}));
});

test('parseEnv reads KEY=VALUE, ignores comments and blank lines, strips trailing comments', () => {
  const text = '# header\n\nFT_ENABLED=1                    # 1 = fault-tolerant\nJWT_SECRET=ab=cd\n';
  assert.deepEqual(parseEnv(text), { FT_ENABLED: '1', JWT_SECRET: 'ab=cd' });
});

test('formatEnv and parseEnv round-trip', () => {
  const e = buildEnv('endterm', {});
  assert.deepEqual(parseEnv(formatEnv(e)), e);
});

test('chaosHeaders sends CHAOS_TOKEN as x-chaos-token (the endterm /chaos lockdown)', () => {
  assert.deepEqual(chaosHeaders({ CHAOS_TOKEN: 'tok-123', JWT_SECRET: 'x' }), { 'x-chaos-token': 'tok-123' });
});

test('chaosHeaders sends no header without a token (baseline/midterm stacks keep /chaos open)', () => {
  assert.deepEqual(chaosHeaders({}), {});
  assert.deepEqual(chaosHeaders({ CHAOS_TOKEN: '' }), {});
});
