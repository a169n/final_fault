// Writes the .env that docker compose reads, without starting anything.
//   npm run env -- <baseline|midterm|endterm>
// up.ts uses it before `docker compose up`; CI uses it before `docker compose config`, because
// docker-compose.yml requires the secrets (${VAR:?}) and fails to render without a .env.
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildEnv, formatEnv, isMode, parseEnv, type Mode } from './env.ts';

export const ENV_PATH = fileURLToPath(new URL('../.env', import.meta.url));

export function writeEnvFile(mode: Mode, path: string = ENV_PATH): Record<string, string> {
  const existing = existsSync(path) ? parseEnv(readFileSync(path, 'utf8')) : {};
  const env = buildEnv(mode, existing);
  writeFileSync(path, formatEnv(env), { mode: 0o600 });  // mode applies only when the file is created
  try { chmodSync(path, 0o600); } catch { /* not supported on every filesystem (Windows) */ }
  return env;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const arg = process.argv[2] === 'ft' ? 'midterm' : process.argv[2];  // ft is the midterm name
  if (!arg || !isMode(arg)) {
    console.log('usage: npm run env -- baseline | midterm | endterm');
    process.exit(1);
  }
  writeEnvFile(arg);
  console.log(`.env written for mode: ${arg}`);
}
