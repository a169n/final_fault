// Aggregates the stored runs (reports/endterm/runs/<scenario>__<mode>__r<N>/metrics.json) per
// (scenario, mode) and writes reports/endterm/RESULTS.md and reports/endterm/results.csv.
// Every number comes from a metrics.json; nothing is re-measured or estimated here.
// Usage: node --experimental-strip-types experiments/aggregate.ts [--runs <dir>] [--out <dir>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { RunResult } from './acceptance.ts';
import { SCENARIOS } from './scenarios.ts';

export const MODES = ['baseline', 'midterm', 'endterm'];

// mean and sample standard deviation over the finite values; n = how many values were usable
export type Stat = { n: number; mean: number | null; sd: number | null };

export function stat(xs: (number | null | undefined)[]): Stat {
  const v = xs.filter((x): x is number => typeof x === 'number' && Number.isFinite(x));
  if (v.length === 0) return { n: 0, mean: null, sd: null };
  const mean = v.reduce((a, b) => a + b, 0) / v.length;
  if (v.length === 1) return { n: 1, mean, sd: null };
  const sd = Math.sqrt(v.reduce((a, b) => a + (b - mean) ** 2, 0) / (v.length - 1));
  return { n: v.length, mean, sd };
}

export type AlertRow = { name: string; fired: number; detectionMs: Stat; resolvedAfterRepairMs: Stat };
export type CriterionRow = { id: string; describe: string; passed: number; n: number };

export type Row = {
  scenario: string;
  title: string;
  kind: string;
  mode: string;
  n: number;
  reps: number[];
  restoreOk: number;
  requestsTotal: Stat;
  requestsSuccessful: Stat;
  requestsFailed: Stat;
  rateLimited: Stat;
  errorRate: Stat;
  availabilityRequest: Stat;
  availabilityTime: Stat;
  availabilityRead: Stat;
  avgMs: Stat;
  p95Ms: Stat;
  detectionMs: Stat;
  recoveryMs: Stat;
  mttrMs: Stat;
  preFaultRps: Stat;
  duringFaultRps: Stat;
  postRepairRps: Stat;
  expectedAlerts: { mustFire: string[]; mayFire: string[] };
  alerts: AlertRow[];
  alertCorrect: number;
  alertsMissing: string[];      // union over the repetitions
  alertsUnexpected: string[];   // union over the repetitions
  integrity: {
    lost: number;
    duplicates: number;          // consistency.duplicateCharges (DB + client side), summed
    duplicatesDb: number;
    duplicatesClient: number;
    orphanedPending: number;
    phantom: number;
    ledgerBalanced: number;      // repetitions with a balanced ledger
  };
  criteria: CriterionRow[];
  repsAllPassed: number;
  verdict: string;               // PASS, or FAIL (k/n) with k = repetitions in which every criterion passed
};

const num = (x: unknown): number | null => (typeof x === 'number' && Number.isFinite(x) ? x : null);
const sum = (xs: unknown[]) => xs.reduce<number>((a, x) => a + (num(x) ?? 0), 0);
// safe nested read: a run recorded before a field existed yields undefined, not a crash
const get = (o: unknown, ...path: string[]): unknown =>
  path.reduce<unknown>((x, k) => (x != null && typeof x === 'object' ? (x as Record<string, unknown>)[k] : undefined), o);

const SCENARIO_ORDER = Object.keys(SCENARIOS);
const orderOf = (list: string[], x: string) => {
  const i = list.indexOf(x);
  return i < 0 ? list.length : i;
};
const byOrder = (list: string[]) => (a: string, b: string) => orderOf(list, a) - orderOf(list, b) || a.localeCompare(b);
const sortScenarios = byOrder(SCENARIO_ORDER);
const sortModes = byOrder(MODES);

export function aggregate(runs: RunResult[]): Row[] {
  const groups = new Map<string, RunResult[]>();
  for (const r of runs) {
    const k = `${r.scenario}\u0000${r.mode}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const rows = [...groups.values()].map(group);
  return rows.sort((a, b) => sortScenarios(a.scenario, b.scenario) || sortModes(a.mode, b.mode));
}

function group(rs: RunResult[]): Row {
  rs = [...rs].sort((a, b) => a.rep - b.rep);
  const first = rs[0];
  const m = (...path: string[]) => stat(rs.map((r) => num(get(r.metrics, ...path))));
  const c = (...path: string[]) => rs.map((r) => get(r.consistency, ...path));

  // alerts: every name seen in any run's metrics.alerts or expectations, in first-seen order
  const names: string[] = [];
  const addName = (n: string) => { if (!names.includes(n)) names.push(n); };
  for (const n of [...(first.expectedAlerts?.mustFire ?? []), ...(first.expectedAlerts?.mayFire ?? [])]) addName(n);
  for (const r of rs) for (const a of r.metrics?.alerts ?? []) if (a.fired) addName(a.name);
  const alerts: AlertRow[] = names.map((name) => {
    const fired = rs.map((r) => (r.metrics?.alerts ?? []).find((a) => a.name === name && a.fired));
    return {
      name,
      fired: fired.filter(Boolean).length,
      detectionMs: stat(fired.map((a) => num(a?.detectionMs))),
      resolvedAfterRepairMs: stat(fired.map((a) => num(a?.resolvedAfterRepairMs))),
    };
  });

  // acceptance criteria, as stored by the run (acceptance.evaluate), in first-seen order
  const criteria: CriterionRow[] = [];
  for (const r of rs) {
    for (const cr of r.acceptance ?? []) {
      let row = criteria.find((x) => x.id === cr.id);
      if (!row) criteria.push((row = { id: cr.id, describe: cr.describe, passed: 0, n: 0 }));
      row.n += 1;
      if (cr.pass === true) row.passed += 1;
    }
  }
  const allPassed = (r: RunResult) => (r.acceptance ?? []).length > 0 && r.acceptance.every((x) => x.pass === true);
  const repsAllPassed = rs.filter(allPassed).length;
  // a criterion missing from a run counts as not passed in that run (cr.n < rs.length)
  const pass = criteria.length > 0 && repsAllPassed === rs.length && criteria.every((x) => x.passed === rs.length);
  const verdict = criteria.length === 0 ? 'NO CRITERIA' : pass ? 'PASS' : `FAIL (${repsAllPassed}/${rs.length})`;

  const union = (pick: (r: RunResult) => string[] | undefined) => [...new Set(rs.flatMap((r) => pick(r) ?? []))].sort();

  return {
    scenario: first.scenario,
    title: first.title ?? SCENARIOS[first.scenario]?.title ?? first.scenario,
    kind: first.kind ?? SCENARIOS[first.scenario]?.kind ?? '',
    mode: first.mode,
    n: rs.length,
    reps: rs.map((r) => r.rep),
    restoreOk: rs.filter((r) => r.restore?.ok === true).length,
    requestsTotal: m('requests', 'total'),
    requestsSuccessful: m('requests', 'successful'),
    requestsFailed: m('requests', 'failed'),
    rateLimited: m('requests', 'rateLimited'),
    errorRate: m('requests', 'errorRate'),
    availabilityRequest: m('availability', 'requestBased'),
    availabilityTime: m('availability', 'timeBased'),
    availabilityRead: m('availability', 'readRequestBased'),
    avgMs: m('response', 'avgMs'),
    p95Ms: m('response', 'p95Ms'),
    detectionMs: m('response', 'detectionMs'),
    recoveryMs: m('response', 'recoveryMs'),
    mttrMs: m('reliability', 'mttrMs'),
    preFaultRps: m('throughput', 'preFaultRps'),
    duringFaultRps: m('throughput', 'duringFaultRps'),
    postRepairRps: m('throughput', 'postRepairRps'),
    expectedAlerts: { mustFire: first.expectedAlerts?.mustFire ?? [], mayFire: first.expectedAlerts?.mayFire ?? [] },
    alerts,
    alertCorrect: rs.filter((r) => r.alertCorrectness?.correct === true).length,
    alertsMissing: union((r) => r.alertCorrectness?.missing),
    alertsUnexpected: union((r) => r.alertCorrectness?.unexpected),
    integrity: {
      lost: sum(c('lostRecords')),
      duplicates: sum(c('duplicateCharges')),
      duplicatesDb: sum(c('duplicateChargesDb')),
      duplicatesClient: sum(c('duplicateChargesClient')),
      orphanedPending: sum(c('orphanedPending')),
      phantom: sum(c('phantomRecords')),
      ledgerBalanced: c('ledgerBalanced').filter((x) => x === true).length,
    },
    criteria,
    repsAllPassed,
    verdict,
  };
}

// ---------------------------------------------------------------- rendering

const fix = (x: number, d: number) => x.toFixed(d);
// "mean ± sd", with "[k/n]" when only k of the group's n runs had a value
function fmt(s: Stat, n: number, f: (x: number) => string): string {
  if (s.mean == null) return '–';
  const body = s.sd == null ? f(s.mean) : `${f(s.mean)} ± ${f(s.sd)}`;
  return s.n < n ? `${body} [${s.n}/${n}]` : body;
}
const pct = (x: number) => `${fix(x * 100, 3)} %`;
const ms = (x: number) => `${fix(x, 0)} ms`;
const secs = (x: number) => `${fix(x / 1000, 2)} s`;
const rps = (x: number) => fix(x, 1);
const count = (x: number) => fix(x, 0);

const md = (cells: string[]) => `| ${cells.map((c) => c.replace(/\|/g, '\\|')).join(' | ')} |`;
const table = (head: string[], body: string[][]) =>
  [md(head), md(head.map(() => '---')), ...body.map(md)].join('\n');

const eNumber = (scenario: string) => {
  const i = SCENARIO_ORDER.indexOf(scenario);
  return i < 0 ? scenario : `E${i + 1} ${scenario}`;
};

function scenariosOf(rows: Row[]): string[] {
  return [...new Set([...SCENARIO_ORDER, ...rows.map((r) => r.scenario)])]
    .filter((s) => rows.some((r) => r.scenario === s))
    .sort(sortScenarios);
}
function modesOf(rows: Row[]): string[] {
  return [...new Set([...MODES, ...rows.map((r) => r.mode)])].sort(sortModes);
}
const find = (rows: Row[], scenario: string, mode: string) => rows.find((r) => r.scenario === scenario && r.mode === mode);
const NO_RUNS = 'no runs';

export function renderResults(rows: Row[], meta: { generatedAt?: string; source?: string } = {}): string {
  const scenarios = scenariosOf(rows);
  const modes = modesOf(rows);
  const runsPerMode = modes.map((mode) => `${mode}: ${rows.filter((r) => r.mode === mode).reduce((a, r) => a + r.n, 0)}`);
  const out: string[] = [];

  out.push('# Endterm results');
  out.push('');
  out.push(`Generated by \`experiments/aggregate.ts\`${meta.generatedAt ? ` on ${meta.generatedAt}` : ''} from ` +
    `\`${meta.source ?? 'reports/endterm/runs/*/metrics.json'}\`. Do not edit by hand; re-run the script.`);
  out.push('');
  out.push(`Runs per mode: ${runsPerMode.join(', ')}. A mode with no runs is shown as "${NO_RUNS}".`);
  out.push('');
  out.push('Notation: values are mean ± sample standard deviation over the repetitions (n). ' +
    '"[k/n]" means only k of the n runs produced that value (for example, no client-visible failure, so no detection time). ' +
    '"k/n" counts repetitions. A is availability; "request" is the share of successful requests, ' +
    '"time" the share of 1 s bins with at least one success (metrics.ts).');
  out.push('');

  // (a) verdicts
  out.push('## (a) Acceptance: pass/fail per scenario and mode');
  out.push('');
  out.push('PASS only if every acceptance criterion passed in every repetition. FAIL (k/n): k of n repetitions passed every criterion. ' +
    'The acceptance targets are the endterm targets (TEST-PLAN.md), applied unchanged to every mode.');
  out.push('');
  out.push(table(['Scenario', 'Kind', ...modes], scenarios.map((s) => [
    eNumber(s), find(rows, s, modes.find((m) => find(rows, s, m)) ?? '')?.kind ?? '',
    ...modes.map((mode) => {
      const r = find(rows, s, mode);
      return r ? (r.verdict === 'PASS' ? `PASS (n=${r.n})` : r.verdict) : NO_RUNS;
    }),
  ])));
  out.push('');
  out.push('### Per criterion (repetitions passed / n)');
  out.push('');
  for (const s of scenarios) {
    const ids: { id: string; describe: string }[] = [];
    for (const mode of modes) for (const c of find(rows, s, mode)?.criteria ?? []) if (!ids.some((x) => x.id === c.id)) ids.push(c);
    out.push(`**${eNumber(s)}**`);
    out.push('');
    out.push(table(['Criterion', ...modes], ids.map((c) => [
      c.describe,
      ...modes.map((mode) => {
        const r = find(rows, s, mode);
        if (!r) return NO_RUNS;
        const cr = r.criteria.find((x) => x.id === c.id);
        return cr ? `${cr.passed}/${r.n}` : 'not evaluated';
      }),
    ])));
    out.push('');
  }

  // (b) comparison
  out.push('## (b) Baseline vs midterm vs endterm (spec §7 measurements)');
  out.push('');
  const measures: [string, (r: Row) => string][] = [
    ['n (repetitions)', (r) => String(r.n)],
    ['Requests (total)', (r) => fmt(r.requestsTotal, r.n, count)],
    ['Successful requests', (r) => fmt(r.requestsSuccessful, r.n, count)],
    ['Failed requests', (r) => fmt(r.requestsFailed, r.n, count)],
    ['Rate-limited (429)', (r) => fmt(r.rateLimited, r.n, count)],
    ['Error rate', (r) => fmt(r.errorRate, r.n, pct)],
    ['A (request)', (r) => fmt(r.availabilityRequest, r.n, pct)],
    ['A (time)', (r) => fmt(r.availabilityTime, r.n, pct)],
    ['A (reads only)', (r) => fmt(r.availabilityRead, r.n, pct)],
    ['Avg latency', (r) => fmt(r.avgMs, r.n, ms)],
    ['p95 latency', (r) => fmt(r.p95Ms, r.n, ms)],
    ['Detection time (client-visible)', (r) => fmt(r.detectionMs, r.n, secs)],
    ['Recovery time', (r) => fmt(r.recoveryMs, r.n, secs)],
    ['MTTR', (r) => fmt(r.mttrMs, r.n, secs)],
    ['Throughput before fault (req/s)', (r) => fmt(r.preFaultRps, r.n, rps)],
    ['Throughput during fault (req/s)', (r) => fmt(r.duringFaultRps, r.n, rps)],
    ['Throughput after repair (req/s)', (r) => fmt(r.postRepairRps, r.n, rps)],
    ['Alerts fired (k/n)', (r) => r.alerts.filter((a) => a.fired > 0).map((a) => `${a.name} ${a.fired}/${r.n}`).join('; ') || 'none'],
    ['Alerts correct', (r) => `${r.alertCorrect}/${r.n}`],
    ['Lost / duplicate records (total)', (r) => `${r.integrity.lost} / ${r.integrity.duplicates}`],
  ];
  for (const s of scenarios) {
    out.push(`### ${eNumber(s)}`);
    out.push('');
    out.push(table(['Measurement', ...modes], measures.map(([label, f]) => [
      label, ...modes.map((mode) => {
        const r = find(rows, s, mode);
        return r ? f(r) : NO_RUNS;
      }),
    ])));
    out.push('');
  }

  // (c) alerts
  out.push('## (c) Alerts: fired, correct, detection delay');
  out.push('');
  out.push('Fired k/n: repetitions in which the alert reached `firing`. Detection: firing time minus injection time, over the repetitions ' +
    'in which it fired. Correct: every mustFire alert fired and nothing outside mustFire/mayFire fired (acceptance.ts alertCorrectness).');
  out.push('');
  const alertRows: string[][] = [];
  for (const s of scenarios) {
    for (const mode of modes) {
      const r = find(rows, s, mode);
      if (!r) {
        alertRows.push([eNumber(s), mode, NO_RUNS, '–', '–', '–', '–', '–']);
        continue;
      }
      const expected = `must: ${r.expectedAlerts.mustFire.join(', ') || '—'}; may: ${r.expectedAlerts.mayFire.join(', ') || '—'}`;
      const fired = r.alerts.filter((a) => a.fired > 0);
      alertRows.push([
        eNumber(s), mode, String(r.n), expected,
        fired.length ? fired.map((a) => `${a.name} ${a.fired}/${r.n}`).join('; ') : 'none',
        fired.length ? fired.map((a) => `${a.name} ${fmt(a.detectionMs, a.fired, secs)}`).join('; ') : '–',
        `${r.alertCorrect}/${r.n}`,
        [r.alertsMissing.length ? `missing: ${r.alertsMissing.join(', ')}` : '', r.alertsUnexpected.length ? `unexpected: ${r.alertsUnexpected.join(', ')}` : '']
          .filter(Boolean).join('; ') || '–',
      ]);
    }
  }
  out.push(table(['Scenario', 'Mode', 'n', 'Expected', 'Fired (k/n)', 'Detection delay', 'Correct', 'Missing / unexpected'], alertRows));
  out.push('');

  // (d) integrity
  out.push('## (d) Data integrity: lost, duplicate and orphaned records');
  out.push('');
  out.push('Totals over the repetitions. Lost: acknowledged (2xx) payment intents not completed in the DB. Duplicates: ' +
    'consistency.duplicateCharges, i.e. DB-side duplicate completed rows per intent plus client-side duplicates; both parts are shown. ' +
    'Orphaned: payments left pending at the end. Phantom: completed in the DB without a 2xx (allowed, reported).');
  out.push('');
  const integrityRows: string[][] = [];
  for (const s of scenarios) {
    for (const mode of modes) {
      const r = find(rows, s, mode);
      if (!r) {
        integrityRows.push([eNumber(s), mode, NO_RUNS, '–', '–', '–', '–', '–', '–', '–']);
        continue;
      }
      const i = r.integrity;
      integrityRows.push([eNumber(s), mode, String(r.n), String(i.lost), String(i.duplicates), String(i.duplicatesDb),
        String(i.duplicatesClient), String(i.orphanedPending), String(i.phantom), `${i.ledgerBalanced}/${r.n}`]);
    }
  }
  out.push(table(['Scenario', 'Mode', 'n', 'Lost', 'Duplicates', 'of which DB', 'of which client', 'Orphaned pending', 'Phantom', 'Ledger balanced'],
    integrityRows));
  out.push('');

  // restore
  out.push('## Known-state restore');
  out.push('');
  out.push(table(['Scenario', ...modes], scenarios.map((s) => [
    eNumber(s), ...modes.map((mode) => {
      const r = find(rows, s, mode);
      return r ? `${r.restoreOk}/${r.n} ok` : NO_RUNS;
    }),
  ])));
  out.push('');
  return out.join('\n');
}

const CSV_STATS: [string, (r: Row) => Stat][] = [
  ['requests_total', (r) => r.requestsTotal],
  ['requests_successful', (r) => r.requestsSuccessful],
  ['requests_failed', (r) => r.requestsFailed],
  ['rate_limited', (r) => r.rateLimited],
  ['error_rate', (r) => r.errorRate],
  ['availability_request', (r) => r.availabilityRequest],
  ['availability_time', (r) => r.availabilityTime],
  ['availability_read', (r) => r.availabilityRead],
  ['avg_ms', (r) => r.avgMs],
  ['p95_ms', (r) => r.p95Ms],
  ['detection_ms', (r) => r.detectionMs],
  ['recovery_ms', (r) => r.recoveryMs],
  ['mttr_ms', (r) => r.mttrMs],
  ['pre_fault_rps', (r) => r.preFaultRps],
  ['during_fault_rps', (r) => r.duringFaultRps],
  ['post_repair_rps', (r) => r.postRepairRps],
];

const csvCell = (x: unknown): string => {
  const s = x == null ? '' : String(x);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// One line per (scenario, mode). List-valued cells use ';' so the file stays one value per comma.
export function renderCsv(rows: Row[]): string {
  const head = ['scenario', 'mode', 'n', 'verdict', 'reps_all_passed', 'restore_ok',
    ...CSV_STATS.flatMap(([k]) => [`${k}_mean`, `${k}_sd`, `${k}_n`]),
    'alerts_correct', 'alerts_fired', 'alerts_detection_mean_ms', 'alerts_missing', 'alerts_unexpected',
    'lost', 'duplicates', 'duplicates_db', 'duplicates_client', 'orphaned_pending', 'phantom', 'ledger_balanced',
    'criteria'];
  const lines = rows.map((r) => {
    const fired = r.alerts.filter((a) => a.fired > 0);
    return [
      r.scenario, r.mode, r.n, r.verdict, r.repsAllPassed, r.restoreOk,
      ...CSV_STATS.flatMap(([, f]) => {
        const s = f(r);
        return [s.mean ?? '', s.sd ?? '', s.n];
      }),
      r.alertCorrect,
      fired.map((a) => `${a.name}:${a.fired}/${r.n}`).join(';'),
      fired.map((a) => `${a.name}:${a.detectionMs.mean == null ? '' : Math.round(a.detectionMs.mean)}`).join(';'),
      r.alertsMissing.join(';'), r.alertsUnexpected.join(';'),
      r.integrity.lost, r.integrity.duplicates, r.integrity.duplicatesDb, r.integrity.duplicatesClient,
      r.integrity.orphanedPending, r.integrity.phantom, r.integrity.ledgerBalanced,
      r.criteria.map((c) => `${c.id}:${c.passed}/${r.n}`).join(';'),
    ].map(csvCell).join(',');
  });
  return [head.join(','), ...lines].join('\n') + '\n';
}

// ---------------------------------------------------------------- CLI

// Repetition 0 is the smoke-test slot (npm run exp <s> -- --rep 0), never part of the campaign,
// so it is skipped unless explicitly requested.
export function loadRuns(dir: string, includeSmoke = false): RunResult[] {
  if (!existsSync(dir)) return [];
  const runs: RunResult[] = [];
  for (const d of readdirSync(dir).sort()) {
    if (!includeSmoke && /__r0$/.test(d)) continue;
    const f = join(dir, d, 'metrics.json');
    if (!existsSync(f)) continue;
    try {
      runs.push(JSON.parse(readFileSync(f, 'utf8')) as RunResult);
    } catch (e) {
      throw new Error(`cannot parse ${f}: ${(e as Error).message}`);
    }
  }
  return runs;
}

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const runsDir = resolve(arg('runs') ?? join(ROOT, 'reports/endterm/runs'));
  const outDir = resolve(arg('out') ?? join(ROOT, 'reports/endterm'));
  const runs = loadRuns(runsDir);
  if (runs.length === 0) {
    console.log(`no runs found under ${runsDir}`);
    process.exit(1);
  }
  const rows = aggregate(runs);
  mkdirSync(outDir, { recursive: true });
  const source = `${runsDir.startsWith(ROOT) ? runsDir.slice(ROOT.length) : runsDir}/*/metrics.json`;
  writeFileSync(join(outDir, 'RESULTS.md'), renderResults(rows, { generatedAt: new Date().toISOString(), source }));
  writeFileSync(join(outDir, 'results.csv'), renderCsv(rows));
  console.log(`${runs.length} run(s), ${rows.length} (scenario, mode) group(s) -> ${join(outDir, 'RESULTS.md')}, ${join(outDir, 'results.csv')}`);
}
