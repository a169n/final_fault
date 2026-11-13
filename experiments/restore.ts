// Restore from the newest backup (H9). An operator action, run as the superuser over docker exec.
//   npm run db:restore                 verify + merge the newest backup into the live database
//   npm run db:restore -- --verify     verify only: checksum, restore into a scratch database, check it
//   npm run db:restore -- --before 2026-11-13T10:26:20Z   the newest backup taken before that time
//   npm run db:restore -- --file backups/university-....dump
// After a data-loss incident use --before with the time of the incident (the PaymentRecordsLost
// alert gives it): a backup taken after the damage contains the damage.
//
// Steps:
//   1. checksum   the SHA-256 written next to the dump must match
//   2. restore    pg_restore into a scratch database `restore_check` (proves the archive restores)
//   3. check      row counts and the ledger invariant inside the scratch database
//   4. merge      payments missing from the live database are inserted by idempotency key, missing
//                 students are re-created and every balance is recomputed from the completed
//                 payments. Rows written after the backup are kept: the merge only adds.
//   5. cleanup    drop the scratch database
// Step 4 holds a lock on students and payments, so no payment commits half-way through it.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const BACKUP_DIR = join(ROOT, 'backups');
const CONTROLLER = 'http://localhost:3061';
const SCRATCH = 'restore_check';

export type RestoreReport = {
  ok: boolean;
  file: string | null;
  backupFinishedMs: number | null;   // when the backup was taken (from its file name)
  checksumOk: boolean;
  scratch: { payments: number; completed: number; students: number; ledgerBalanced: boolean } | null;
  merged: { paymentsInserted: number; studentsInserted: number } | null;
  durationMs: number;
  writer: string | null;
  error?: string;
};

// The node that accepts writes right now, from the database controller; postgres-primary if it cannot say.
export async function dbWriter(): Promise<string> {
  try {
    const res = await fetch(`${CONTROLLER}/health`, { signal: AbortSignal.timeout(2000) });
    const body = (await res.json()) as { writer?: string | null };
    if (typeof body.writer === 'string') return body.writer;
  } catch { /* controller unreachable */ }
  return 'postgres-primary';
}

function run(cmd: string, args: string[], input?: Buffer): Promise<string> {
  return new Promise((ok, fail) => {
    const child = spawn(cmd, args, { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', fail);
    child.on('close', (code) => (code === 0 ? ok(out.trim()) : fail(new Error(`${cmd} ${args.slice(0, 4).join(' ')}: ${err.trim().split('\n').pop()}`))));
    child.stdin.end(input);
  });
}

const inNode = (node: string, script: string, input?: Buffer) =>
  run('docker', ['compose', 'exec', '-T', node, 'bash', '-c', `set -euo pipefail; ${script}`], input);

// The newest backup, or with `beforeMs` the newest one whose snapshot was taken before that time.
export function newestBackup(dir: string = BACKUP_DIR, beforeMs?: number): string | null {
  if (!existsSync(dir)) return null;
  const dumps = readdirSync(dir).filter((f) => /^university-.*\.dump$/.test(f)).sort()
    .filter((f) => beforeMs == null || (backupTakenMs(f) ?? Infinity) < beforeMs);
  return dumps.length ? join(dir, dumps[dumps.length - 1]) : null;
}

// university-<UTC date>-<epoch ms>.dump: the epoch is when pg_dump started (its snapshot).
export const backupTakenMs = (file: string): number | null => {
  const m = /-(\d{13})\.dump$/.exec(file);
  return m ? Number(m[1]) : null;
};

export function checksumOk(file: string): boolean {
  if (!existsSync(`${file}.sha256`)) return false;
  const expected = readFileSync(`${file}.sha256`, 'utf8').trim().split(/\s+/)[0];
  return createHash('sha256').update(readFileSync(file)).digest('hex') === expected;
}

const PSQL = 'psql -U postgres -v ON_ERROR_STOP=1 -q -t -A -F "|"';

const MERGE_SQL = `
BEGIN;
LOCK TABLE students, payments IN SHARE ROW EXCLUSIVE MODE;
WITH ins AS (
  INSERT INTO students (id, name, credits) SELECT id, name, credits FROM _restore_students
  ON CONFLICT (id) DO NOTHING RETURNING 1)
SELECT 'students=' || count(*) FROM ins;
WITH ins AS (
  INSERT INTO payments (idempotency_key, student_id, amount, state, created_at, updated_at)
  SELECT idempotency_key, student_id, amount, state, created_at, updated_at FROM _restore_payments
  ON CONFLICT (idempotency_key) DO NOTHING RETURNING 1)
SELECT 'payments=' || count(*) FROM ins;
UPDATE students s SET balance = coalesce(
  (SELECT sum(p.amount) FROM payments p WHERE p.student_id = s.id AND p.state = 'completed'), 0);
DROP TABLE _restore_students, _restore_payments;
COMMIT;`;

export async function restoreFromBackup(opts: { file?: string; merge?: boolean; beforeMs?: number } = {}): Promise<RestoreReport> {
  const started = Date.now();
  const report: RestoreReport = {
    ok: false, file: null, backupFinishedMs: null, checksumOk: false, scratch: null, merged: null,
    durationMs: 0, writer: null,
  };
  try {
    const file = opts.file ? resolve(opts.file) : newestBackup(BACKUP_DIR, opts.beforeMs);
    if (!file || !existsSync(file)) throw new Error(`no backup found in backups/${opts.beforeMs ? ' from before the given time' : ''} (backups run only in final mode)`);
    report.file = basename(file);
    report.backupFinishedMs = backupTakenMs(file);
    report.checksumOk = checksumOk(file);
    if (!report.checksumOk) throw new Error(`checksum mismatch for ${report.file}`);

    const node = await dbWriter();
    report.writer = node;
    await inNode(node,
      `dropdb -U postgres --if-exists ${SCRATCH}; createdb -U postgres ${SCRATCH}; ` +
      `pg_restore -U postgres -d ${SCRATCH} --no-owner --no-privileges`, readFileSync(file));

    const check = await inNode(node, `${PSQL} -d ${SCRATCH} -c "select (select count(*) from payments), ` +
      `(select count(*) from payments where state='completed'), (select count(*) from students), ` +
      `(select coalesce(sum(amount),0) from payments where state='completed') = (select coalesce(sum(balance),0) from students)"`);
    const [payments, completed, students, balanced] = check.split('|');
    report.scratch = { payments: Number(payments), completed: Number(completed), students: Number(students), ledgerBalanced: balanced === 't' };
    if (!report.scratch.ledgerBalanced) throw new Error('the backup itself is not ledger-balanced; not merging it');

    if (opts.merge !== false) {
      const out = await inNode(node,
        `${PSQL} -d university -c "CREATE TABLE _restore_students (LIKE students); CREATE TABLE _restore_payments (LIKE payments)"; ` +
        `${PSQL} -d ${SCRATCH} -c "COPY students TO STDOUT" | ${PSQL} -d university -c "COPY _restore_students FROM STDIN"; ` +
        `${PSQL} -d ${SCRATCH} -c "COPY payments TO STDOUT" | ${PSQL} -d university -c "COPY _restore_payments FROM STDIN"; ` +
        `${PSQL} -d university <<'SQL'\n${MERGE_SQL}\nSQL`);
      const count = (what: string) => Number(new RegExp(`${what}=(\\d+)`).exec(out)?.[1] ?? NaN);
      report.merged = { paymentsInserted: count('payments'), studentsInserted: count('students') };
    }
    await inNode(node, `dropdb -U postgres --if-exists ${SCRATCH}`);
    report.ok = true;
  } catch (e) {
    report.error = (e as Error).message;
  }
  report.durationMs = Date.now() - started;
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const argv = process.argv.slice(2);
  const fileIdx = argv.indexOf('--file');
  const beforeIdx = argv.indexOf('--before');
  const beforeMs = beforeIdx >= 0 ? Date.parse(argv[beforeIdx + 1]) : undefined;
  if (beforeIdx >= 0 && !Number.isFinite(beforeMs)) {
    console.log('--before needs a time, e.g. 2026-11-13T10:26:20Z');
    process.exit(1);
  }
  const report = await restoreFromBackup({
    beforeMs,
    file: fileIdx >= 0 ? argv[fileIdx + 1] : undefined,
    merge: !argv.includes('--verify'),
  });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}
