// One experiment run: known-state restore, workload + fault injection, alert and resource capture,
// key-level integrity, acceptance criteria. Usage: npm run exp <scenario> -- --rep N
//   raw data -> logs/final/<scenario>__<mode>__r<N>/
//   results  -> reports/final/runs/<scenario>__<mode>__r<N>/metrics.json (a RunResult, acceptance.ts)
import { fileURLToPath } from 'node:url';
import { existsSync, mkdirSync, writeFileSync, statSync, openSync, readSync, closeSync } from 'node:fs';
import { gzipSync } from 'node:zlib';
import { login, runWorkload } from './workload.ts';
import { CHAOS_PORTS, CHAOS_RESET, SCENARIOS, chaos, dc, dotEnv, psql } from './scenarios.ts';
import { computeMetrics, consistencyFrom, parseLedger, type DbPaymentRow } from './metrics.ts';
import { firingNow, pollAlerts } from './alerts.ts';
import { sampleResources } from './resources.ts';
import { alertCorrectness, evaluate, type Restore, type RunResult } from './acceptance.ts';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

const writeJsonlGz = (path: string, rows: unknown[]): void =>
  writeFileSync(`${path}.gz`, gzipSync(Buffer.from(rows.map((r) => JSON.stringify(r)).join('\n') + '\n')));
const ms = (v: number | null | undefined) => (v == null ? 'n/a' : `${v} ms`);
const pctStr = (v: number | null) => (v == null ? 'n/a' : `${(v * 100).toFixed(2)} %`);
const GATEWAY = 'http://localhost:8080';   // nginx: the entry point clients use
const PROMETHEUS = 'http://localhost:9090';
const INSTANCES = [8081, 8082, 3011, 3012, 3021, 3022, 3031, 3041, 3042, 3051, 3061];  // both gateways (direct) + every service replica + auth-1 + db-controller
const HEALTH_WAIT_S = 90;
const ALERTS_CLEAR_WAIT_MS = 120_000;      // DatabaseFailover looks back one minute
const WORKLOAD_USER = 'bursar';            // endterm: staff, may read any student and pay for any student

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function readFrom(path: string, offset: number): string {
  if (!existsSync(path)) return '';
  const size = statSync(path).size;
  if (size <= offset) return '';
  const fd = openSync(path, 'r');
  const buf = Buffer.alloc(size - offset);
  readSync(fd, buf, 0, buf.length, offset);
  closeSync(fd);
  return buf.toString('utf8');
}

function parseArgs(argv: string[]): { name: string; rep: number } {
  const name = argv[0];
  let rep = 1;
  for (let i = 1; i < argv.length; i++) {
    const a = argv[i];
    const v = a.startsWith('--rep=') ? a.slice(6) : a === '--rep' ? argv[++i] : null;
    if (v != null) rep = Number(v);
  }
  if (!Number.isInteger(rep) || rep < 0) throw new Error(`--rep must be a non-negative integer, got ${rep}`);
  return { name, rep };
}

async function waitHealthy(): Promise<{ healthy: boolean; replicationStreaming: boolean }> {
  let last = { healthy: false, replicationStreaming: false };
  for (let i = 0; i < HEALTH_WAIT_S; i++) {
    const checks = await Promise.all(
      INSTANCES.map((p) =>
        fetch(`http://localhost:${p}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false),
      ),
    );
    const gw = await fetch(`${GATEWAY}/health`, { signal: AbortSignal.timeout(1000) }).then((r) => r.ok).catch(() => false);
    const repl = await psql('select count(*) from pg_stat_replication;').catch(() => '0');
    last = { healthy: checks.every(Boolean) && gw, replicationStreaming: repl.trim() === '1' };
    if (last.healthy && last.replicationStreaming) return last;
    process.stdout.write('.');
    await sleep(1000);
  }
  return last;
}

// Known-state restore, before every run (Task 14): every container started, chaos reset on every
// instance, the DB back to the seeded state, health and replication up, and no alert firing.
async function restore(): Promise<Restore> {
  const started = Date.now();
  process.stdout.write('  restoring known state ');
  await dc('start');
  const { healthy, replicationStreaming } = await waitHealthy();
  if (!healthy || !replicationStreaming) {
    console.log(' FAILED');
    return {
      ok: false, durationMs: Date.now() - started, healthy, replicationStreaming, chaosReset: {}, dbReset: false,
      alertsClear: null, firingAtStart: [], error: `platform not healthy within ${HEALTH_WAIT_S} s`,
    };
  }

  const chaosReset: Record<string, boolean> = {};
  for (const port of CHAOS_PORTS) chaosReset[port] = await chaos(port, CHAOS_RESET);

  const dbReset = await psql(
    "TRUNCATE payments; UPDATE students SET balance = 0; DELETE FROM students WHERE id !~ '^s[0-9]+$';",
  ).then(() => true).catch((e) => { console.error(`\n  ! DB reset failed: ${(e as Error).message.split('\n')[0]}`); return false; });

  // The reset removes completed payments, which is exactly what PaymentRecordsLost watches for. Wait
  // until Prometheus has seen the empty table, so that the alert fires (and clears) here, before the
  // run, and not inside it.
  const emptyDeadline = Date.now() + 20_000;
  while (dbReset && Date.now() < emptyDeadline) {
    const seen = await fetch(`${PROMETHEUS}/api/v1/query?query=${encodeURIComponent('max(payments_completed_rows)')}`,
      { signal: AbortSignal.timeout(2000) }).then((r) => r.json()).then((j) => j?.data?.result?.[0]?.value?.[1]).catch(() => undefined);
    if (seen === '0') break;
    process.stdout.write('p');
    await sleep(1000);
  }
  await sleep(3000);  // one scrape + one rule evaluation, so a drop seen just now is already pending/firing

  // Wait until Prometheus has no firing alert, so every alert seen in the run belongs to this run.
  let firing: string[] | null = null;
  const alertsDeadline = Date.now() + ALERTS_CLEAR_WAIT_MS;
  while (Date.now() < alertsDeadline) {
    firing = await firingNow(PROMETHEUS).catch(() => null);
    if (firing != null && firing.length === 0) break;
    process.stdout.write('a');
    await sleep(2000);
  }
  const alertsClear = firing == null ? null : firing.length === 0;
  const ok = Object.values(chaosReset).every(Boolean) && dbReset && alertsClear === true;
  console.log(ok ? ' ok (all instances up, standby streaming, chaos reset, DB reset, no alert firing)'
    : ` partial: chaos ${JSON.stringify(chaosReset)}, db ${dbReset}, alerts clear ${alertsClear} ${JSON.stringify(firing ?? [])}`);
  return {
    ok, durationMs: Date.now() - started, healthy, replicationStreaming, chaosReset, dbReset,
    alertsClear, firingAtStart: firing ?? [],
  };
}

async function main(): Promise<void> {
  const { name, rep } = parseArgs(process.argv.slice(2));
  const scenario = SCENARIOS[name];
  if (!scenario) {
    console.log(`usage: npm run exp <${Object.keys(SCENARIOS).join('|')}> -- --rep N`);
    process.exit(1);
  }

  console.log(`\n=== ${scenario.title} (${name}), repetition ${rep} ===`);
  const restored = await restore();
  if (!restored.healthy || !restored.replicationStreaming) {
    throw new Error(`restore failed (${restored.error}); not running ${name} from an unknown state`);
  }

  const health = await (await fetch(`${GATEWAY}/health`)).json();
  const mode: string = health.mode ?? (health.ft ? 'midterm' : 'baseline');  // pre-endterm gateways only report ft
  console.log(`  mode: ${mode.toUpperCase()}`);

  let token: string | undefined;
  if (mode === 'endterm' || mode === 'final') {
    token = await login(GATEWAY, WORKLOAD_USER, dotEnv().DEMO_PASSWORD ?? '');
    console.log(`  logged in as ${WORKLOAD_USER} (Authorization on every request)`);
  }

  const tag = `${name}__${mode}__r${rep}`;
  const runId = `${name}-${mode}-r${rep}-${Date.now()}`;
  const eventsPath = `${ROOT}logs/events.jsonl`;
  const eventsOffset = existsSync(eventsPath) ? statSync(eventsPath).size : 0;

  const capture = new AbortController();
  const alertStats = { polls: 0, pollErrors: 0 };
  const alertsP = pollAlerts(PROMETHEUS, capture.signal, alertStats);
  const resourcesP = sampleResources(capture.signal);

  const t0 = Date.now();
  let injectTs = 0;
  let repairTs = 0;
  const step = async (label: string, fn: () => Promise<unknown>): Promise<void> => {
    try { await fn(); } catch (e) { console.error(`  ! ${label}: ${(e as Error).message}`); }
  };

  setTimeout(() => {
    injectTs = Date.now();
    console.log(`  T+${((injectTs - t0) / 1000).toFixed(1)}s  INJECT`);
    void step('inject', scenario.inject);
  }, scenario.injectAtMs);

  setTimeout(() => {
    repairTs = Date.now();
    console.log(`  T+${((repairTs - t0) / 1000).toFixed(1)}s  REPAIR`);
    void step('repair', scenario.repair);
  }, scenario.repairAtMs);

  console.log(`  running workload for ${scenario.durationMs / 1000}s ...`);
  const allRecs = await runWorkload({
    gateway: GATEWAY,
    durationMs: scenario.durationMs,
    concurrency: scenario.concurrency ?? 10,
    rampAtMs: scenario.rampAtMs,
    rampConcurrency: scenario.rampConcurrency,
    runId,
    token,
  });
  const t1 = Date.now();
  // Requests still in flight when the window closed were cut off by the harness, not failed by the
  // system. The endterm campaign counted them as failures, which produced a false outage in the last
  // second of many runs (endterm report §8.4 item 1); here they are left out and only counted.
  const recs = allRecs.filter((r) => !r.abandoned);
  const abandonedAtClose = allRecs.length - recs.length;
  capture.abort();
  const [alertObs, resources] = await Promise.all([alertsP, resourcesP]);

  const events = readFrom(eventsPath, eventsOffset)
    .split('\n')
    .filter(Boolean)
    .flatMap((l) => { try { return [JSON.parse(l)]; } catch { return []; } })
    .filter((e) => e.ts >= t0 - 2000 && e.ts <= t1 + 2000);

  // The DB may still be coming back (e.g. right after a db-failure repair): retry, and if it never
  // answers, record the ledger and the rows as unmeasured (null), never as zeros.
  const queryWithRetry = async (sql: string, what: string): Promise<string | null> => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      try {
        return await psql(sql);
      } catch (e) {
        console.error(`  ! ${what} query failed (attempt ${attempt}/5): ${(e as Error).message.split('\n')[0]}`);
        if (attempt < 5) await new Promise((r) => setTimeout(r, 2_000));
      }
    }
    return null;
  };

  const ledger = parseLedger(await queryWithRetry(
    `select
       (select count(*) from payments where state='completed'),
       (select count(*) from payments where state='pending'),
       (select count(*) from payments where state='rolled_back'),
       (select count(*) from payments where state='failed'),
       (select coalesce(sum(amount),0) from payments where state='completed'),
       (select coalesce(sum(balance),0) from students);`,
    'ledger',
  ));
  if (!ledger) console.error('  ! ledger not measured: ledger fields are null and the criteria that read them fail');

  // Key-level integrity: one row per payment (the state never contains '|', so split on the last one).
  const rowsOut = await queryWithRetry('select idempotency_key, state from payments;', 'payment rows');
  const dbRows: DbPaymentRow[] | null = rowsOut == null ? null
    : rowsOut.split('\n').filter(Boolean).map((line) => {
      const i = line.lastIndexOf('|');
      return { key: line.slice(0, i), state: line.slice(i + 1) };
    });

  const consistency = consistencyFrom(recs, ledger, dbRows);
  const effectiveInject = injectTs || t0 + scenario.injectAtMs;
  const metrics = computeMetrics(recs, events, t0, t1, effectiveInject, { repairTs: repairTs || undefined, alerts: alertObs, resources });
  const verify = scenario.verify
    ? await scenario.verify({ recs, t0, t1 }).catch((e) => ({ error: (e as Error).message }))
    : null;

  const fired = metrics.alerts.filter((a) => a.fired).map((a) => a.name);
  const result: RunResult = {
    scenario: name, title: scenario.title, kind: scenario.kind, mode, rep, runId,
    t0, t1, injectTs, repairTs,
    restore: restored,
    abandonedAtClose,
    expectedAlerts: scenario.expectedAlerts,
    alertCorrectness: alertCorrectness(scenario.expectedAlerts, fired),
    metrics,
    consistency,
    verify,
    acceptance: [],
  };
  result.acceptance = evaluate(scenario, result);

  const logDir = `${ROOT}logs/final/${tag}`;
  const dir = `${ROOT}reports/final/runs/${tag}`;
  mkdirSync(logDir, { recursive: true });
  mkdirSync(dir, { recursive: true });
  writeJsonlGz(`${logDir}/workload.jsonl`, allRecs);
  writeJsonlGz(`${logDir}/events.jsonl`, events);
  writeJsonlGz(`${logDir}/resources.jsonl`, resources);
  writeFileSync(`${logDir}/alerts.json`, JSON.stringify({ promUrl: PROMETHEUS, ...alertStats, observations: alertObs }, null, 2));
  writeFileSync(`${dir}/metrics.json`, JSON.stringify(result, null, 2));

  const passed = result.acceptance.filter((a) => a.pass).length;
  console.log(`  availability ${pctStr(metrics.availability.requestBased)} req / ${pctStr(metrics.availability.timeBased)} time / ${pctStr(metrics.availability.writeRequestBased)} writes` +
    ` | failed ${metrics.requests.failed}/${metrics.requests.total} (429: ${metrics.requests.rateLimited})` +
    ` | detect ${ms(metrics.response.detectionMs)} | recover ${ms(metrics.response.recoveryMs)}`);
  console.log(`  alerts fired [${fired.join(', ') || 'none'}] ${result.alertCorrectness.correct ? 'correct' : 'INCORRECT'}` +
    ` | lost ${consistency.lostRecords ?? 'n/a'} dup ${consistency.duplicateCharges} orphaned ${consistency.orphanedPending ?? 'n/a'}` +
    ` | acceptance ${passed}/${result.acceptance.length}`);
  console.log(`  -> ${dir.replace(ROOT, '')}/metrics.json, raw data in ${logDir.replace(ROOT, '')}/`);
}

await main();
