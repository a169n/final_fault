// Every scenario (or --only a,b) x --reps N against the deployed mode. Repetition-major order
// (all scenarios once, then again), so a slow drift of the host does not land on one scenario.
// Usage: npm run campaign -- --reps 3 [--only app-crash,db-failure]
import { spawnSync } from 'node:child_process';
import { SCENARIOS } from './scenarios.ts';

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  if (i >= 0) return argv[i + 1];
  return argv.find((a) => a.startsWith(`--${name}=`))?.slice(name.length + 3);
}

const reps = Number(arg('reps') ?? 1);
const only = arg('only')?.split(',').map((s) => s.trim()).filter(Boolean);
const names = only ?? Object.keys(SCENARIOS);
const unknown = names.filter((n) => !SCENARIOS[n]);
if (!Number.isInteger(reps) || reps < 1 || unknown.length) {
  console.log(`usage: npm run campaign -- --reps N [--only ${Object.keys(SCENARIOS).join(',')}]`);
  if (unknown.length) console.log(`unknown scenario(s): ${unknown.join(', ')}`);
  process.exit(1);
}

const failed: string[] = [];
for (let rep = 1; rep <= reps; rep++) {
  for (const s of names) {
    const r = spawnSync(process.execPath, ['--experimental-strip-types', 'experiments/run.ts', s, '--rep', String(rep)], {
      stdio: 'inherit',
      cwd: new URL('..', import.meta.url),
    });
    if (r.status !== 0) {
      failed.push(`${s} r${rep}`);
      console.log(`!! ${s} r${rep} failed, continuing`);
    }
  }
}
console.log(`\ncampaign finished: ${names.length} scenario(s) x ${reps} repetition(s), ${failed.length} failed` +
  `${failed.length ? ` (${failed.join(', ')})` : ''} -- see reports/final/runs/`);
process.exit(failed.length ? 1 : 0);
