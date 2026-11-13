import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseEnv, SECRET_KEYS } from './env.ts';
import { writeEnvFile } from './env-file.ts';

const tmpEnv = () => join(mkdtempSync(join(tmpdir(), 'ft-env-')), '.env');

test('writeEnvFile creates .env with the mode flags and every secret', () => {
  const path = tmpEnv();
  writeEnvFile('endterm', path);
  const env = parseEnv(readFileSync(path, 'utf8'));
  assert.equal(env.FT_ENABLED, '1');
  assert.equal(env.ENDTERM_ENABLED, '1');
  assert.equal(env.NGINX_PROFILE, 'redundant');
  for (const k of SECRET_KEYS) assert.ok(env[k] && env[k].length >= 32, `${k} generated`);
});

test('writeEnvFile keeps existing secrets and switches the mode', () => {
  const path = tmpEnv();
  writeFileSync(path, 'FT_ENABLED=1\nENDTERM_ENABLED=1\nJWT_SECRET=keep-me\n');
  writeEnvFile('baseline', path);
  const env = parseEnv(readFileSync(path, 'utf8'));
  assert.equal(env.JWT_SECRET, 'keep-me');
  assert.equal(env.FT_ENABLED, '0');
  assert.equal(env.ENDTERM_ENABLED, '0');
});

test('writeEnvFile makes .env readable by its owner only', { skip: process.platform === 'win32' }, () => {
  const path = tmpEnv();
  writeEnvFile('midterm', path);
  assert.equal(statSync(path).mode & 0o777, 0o600);
});
