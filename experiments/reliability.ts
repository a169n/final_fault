// Reliability engineering from the raw workload logs (work package B).
//   npm run reliability            -> reports/final/RELIABILITY.md, reports/final/reliability.csv
//
// Everything in sections 1 to 3 of the output is computed from logs/final/<run>/workload.jsonl.gz and
// the run's metrics.json: measured values. Section 4 is a model; its inputs are labelled.
//
// Definitions (the same in every mode):
//   second     a 1 s bin of the observation window that holds at least one request
//   failed second  a second in which fewer than 99 % of the requests succeeded (SLO-1)
//   failure    a maximal run of failed seconds; two runs separated by a single good second are one failure
//   downtime   number of failed seconds x 1 s
//   MTTR = downtime / failures           mean time to restore service
//   MTTF = (T - downtime) / failures     mean up time before a failure
//   MTBF = T / failures = MTTF + MTTR    mean time between the starts of two failures
//   A    = MTTF / (MTTF + MTTR) = 1 - downtime / T
//   lambda = failures / (T - downtime)   observed failure rate, per hour of up time
// With no failure in T the MTTF is censored (MTTF > T) and the rate is bounded from above:
// lambda <= 3 / T at 95 % confidence (the "rule of three" for zero events).
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import type { Rec } from './workload.ts';

export const SLO_RATIO = 0.99;
export type Bin = { total: number; ok: number };

export type Episode = { startS: number; endS: number; failedSeconds: number };  // offsets from t0, end exclusive

export type RunReliability = {
  seconds: number;         // T: seconds that hold at least one request
  requests: number;
  failedRequests: number;
  failedSeconds: number;   // downtime, s
  failures: number;
  episodes: Episode[];
};

export function binRecs(recs: Rec[], t0: number, filter: (r: Rec) => boolean = () => true): Map<number, Bin> {
  const bins = new Map<number, Bin>();
  for (const r of recs) {
    if (r.abandoned || !filter(r)) continue;
    const b = Math.floor((r.ts - t0) / 1000);
    const cur = bins.get(b) ?? { total: 0, ok: 0 };
    cur.total++;
    if (r.ok) cur.ok++;
    bins.set(b, cur);
  }
  return bins;
}

export function reliabilityOf(bins: Map<number, Bin>): RunReliability {
  const keys = [...bins.keys()].sort((a, b) => a - b);
  const bad = keys.filter((k) => { const v = bins.get(k)!; return v.ok / v.total < SLO_RATIO; });
  const episodes: Episode[] = [];
  for (const k of bad) {
    const last = episodes[episodes.length - 1];
    if (last && k - last.endS <= 1) { last.endS = k + 1; last.failedSeconds++; }  // at most one good second between
    else episodes.push({ startS: k, endS: k + 1, failedSeconds: 1 });
  }
  let requests = 0;
  let ok = 0;
  for (const v of bins.values()) { requests += v.total; ok += v.ok; }
  return { seconds: keys.length, requests, failedRequests: requests - ok, failedSeconds: bad.length, failures: episodes.length, episodes };
}

export type Pooled = {
  runs: number; T: number; requests: number; failedRequests: number; downtime: number; failures: number;
  mttr: number | null; mttf: number | null; mtbf: number | null; availability: number;
  lambdaPerHour: number | null; lambdaUpper95PerHour: number | null; censored: boolean;
};

// Pool several runs of one (scenario, mode): the windows are added up as one long observation.
export function pool(runs: RunReliability[]): Pooled {
  const T = runs.reduce((a, r) => a + r.seconds, 0);
  const downtime = runs.reduce((a, r) => a + r.failedSeconds, 0);
  const failures = runs.reduce((a, r) => a + r.failures, 0);
  const up = T - downtime;
  return {
    runs: runs.length, T,
    requests: runs.reduce((a, r) => a + r.requests, 0),
    failedRequests: runs.reduce((a, r) => a + r.failedRequests, 0),
    downtime, failures,
    mttr: failures ? downtime / failures : null,
    mttf: failures ? up / failures : null,
    mtbf: failures ? T / failures : null,
    availability: T ? up / T : NaN,
    lambdaPerHour: failures && up > 0 ? failures / (up / 3600) : failures ? null : 0,
    lambdaUpper95PerHour: failures === 0 && T > 0 ? 3 / (T / 3600) : null,
    censored: failures === 0,
  };
}

// ---- section 4: series/parallel availability model ----
export const series = (...a: number[]) => a.reduce((x, y) => x * y, 1);
export const parallel = (...a: number[]) => 1 - a.reduce((x, y) => x * (1 - y), 1);
export const componentA = (mttfS: number, mttrS: number) => mttfS / (mttfS + mttrS);

// ------------------------------------------------------------------ CLI
const f = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? '–' : x.toFixed(d));
const pct = (x: number, d = 3) => `${(x * 100).toFixed(d)} %`;
const md = (cells: (string | number)[]) => `| ${cells.join(' | ')} |`;
const table = (head: string[], body: (string | number)[][]) => [md(head), md(head.map(() => '---')), ...body.map(md)].join('\n');

type RunFile = {
  scenario: string; mode: string; rep: number; t0: number; injectTs: number; repairTs: number;
  verify: { faults?: { name: string; injectTs: number; repairTs: number }[] } | null;
};

function loadRecs(logDir: string): Rec[] {
  const file = join(logDir, 'workload.jsonl.gz');
  if (!existsSync(file)) return [];
  return gunzipSync(readFileSync(file)).toString('utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l) as Rec);
}

const WRITES = (r: Rec) => r.op === 'payments';
const MODE_ORDER = ['baseline', 'midterm', 'endterm', 'final'];

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const runsDir = join(ROOT, 'reports/final/runs');
  const logsDir = join(ROOT, 'logs/final');
  const tags = existsSync(runsDir) ? readdirSync(runsDir).filter((t) => !/__r0$/.test(t)).sort() : [];
  if (tags.length === 0) { console.log(`no runs under ${runsDir}`); process.exit(1); }

  type Loaded = { run: RunFile; all: RunReliability; writes: RunReliability; recs: Rec[] };
  const loaded: Loaded[] = [];
  for (const tag of tags) {
    const run = JSON.parse(readFileSync(join(runsDir, tag, 'metrics.json'), 'utf8')) as RunFile;
    const recs = loadRecs(join(logsDir, tag));
    if (recs.length === 0) { console.error(`! ${tag}: no workload log, skipped`); continue; }
    loaded.push({ run, recs, all: reliabilityOf(binRecs(recs, run.t0)), writes: reliabilityOf(binRecs(recs, run.t0, WRITES)) });
  }
  const scenarios = [...new Set(loaded.map((l) => l.run.scenario))];
  const modes = [...new Set(loaded.map((l) => l.run.mode))].sort((a, b) => MODE_ORDER.indexOf(a) - MODE_ORDER.indexOf(b));
  const of = (s: string, m: string) => loaded.filter((l) => l.run.scenario === s && l.run.mode === m);

  const out: string[] = [];
  const csv: string[] = ['scenario,mode,scope,runs,T_s,requests,failed_requests,failures,downtime_s,MTTR_s,MTTF_s,MTBF_s,availability,lambda_per_h,lambda_upper95_per_h'];
  out.push('# Reliability calculations', '');
  out.push(`Generated by \`experiments/reliability.ts\` on ${new Date().toISOString()} from the raw workload logs ` +
    '(`logs/final/<run>/workload.jsonl.gz`). Do not edit by hand; re-run `npm run reliability`.', '');
  out.push('## 1. Definitions, formulas and units', '');
  out.push('All quantities are **measured** from the per-request log of the load generator, at the client side of nginx.', '');
  out.push(table(['Quantity', 'Definition', 'Unit'], [
    ['second', 'a 1 s bin of the observation window that holds at least one request', 's'],
    ['failed second', `a second in which fewer than ${SLO_RATIO * 100} % of the requests succeeded (SLO-1)`, 's'],
    ['failure', 'a maximal run of failed seconds (runs one good second apart are merged)', 'count'],
    ['T', 'observation window: the seconds of all repetitions of the scenario, added up', 's'],
    ['downtime D', 'number of failed seconds', 's'],
    ['MTTR', 'D / failures', 's'],
    ['MTTF', '(T − D) / failures', 's'],
    ['MTBF', 'T / failures = MTTF + MTTR', 's'],
    ['availability A', 'MTTF / (MTTF + MTTR) = 1 − D / T', '%'],
    ['failure rate λ', 'failures / (T − D)', '1/h'],
    ['request failure ratio', 'failed requests / requests', '%'],
  ]), '');
  out.push('With no failure in T, MTTF is censored (MTTF > T) and only an upper bound on the rate can be stated: ' +
    'λ ≤ 3 / T at 95 % confidence (rule of three). ', '');
  out.push('**The fault rate is not a property of the system.** Every scenario injects its fault on purpose, one per ' +
    '70 to 90 s run and nine per 600 s soak run. MTTF, MTBF and λ below therefore describe the system *under this injected ' +
    'fault load*, which is many orders of magnitude harsher than real operation. What transfers to real operation is ' +
    '(a) MTTR, (b) the share of injected faults that become failures at all, and (c) the ratio between the modes.', '');

  out.push('## 2. Per scenario: all requests', '');
  for (const scope of ['all', 'writes'] as const) {
    if (scope === 'writes') out.push('## 3. Per scenario: the payment path only (the critical workflow)', '');
    out.push(table(['Scenario', 'Mode', 'Runs', 'T (s)', 'Requests', 'Failed req.', 'Failures', 'Downtime (s)', 'MTTR (s)', 'MTTF (s)', 'MTBF (s)', 'A', 'λ (1/h)'],
      scenarios.flatMap((s) => modes.filter((m) => of(s, m).length).map((m) => {
        const p = pool(of(s, m).map((l) => l[scope]));
        csv.push([s, m, scope, p.runs, p.T, p.requests, p.failedRequests, p.failures, p.downtime, f(p.mttr, 2), f(p.mttf, 2), f(p.mtbf, 2),
          p.availability.toFixed(6), f(p.lambdaPerHour, 2), f(p.lambdaUpper95PerHour, 2)].join(','));
        return [s, m, p.runs, p.T, p.requests, p.failedRequests, p.failures, p.downtime, f(p.mttr),
          p.censored ? `> ${p.T}` : f(p.mttf), p.censored ? `> ${p.T}` : f(p.mtbf), pct(p.availability),
          p.censored ? `0 observed (≤ ${f(p.lambdaUpper95PerHour)})` : f(p.lambdaPerHour)];
      }))), '');
  }

  // ---- soak: fault by fault ----
  const soakModes = modes.filter((m) => of('soak', m).length);
  if (soakModes.length) {
    out.push('## 4. Soak: which injected faults became failures', '');
    out.push('One soak run injects nine component faults, 60 s apart, each repaired 25 s after its injection ' +
      '(the repair delay is a parameter of the experiment: it stands for an operator who reacts in 25 s). ' +
      'A fault "became a failure" if at least one failed second lies between its injection and the next injection. ' +
      'Coverage = 1 − failures-causing faults / injected faults.', '');
    const perFault = new Map<string, Map<string, { visible: number; n: number; failedSeconds: number; failedRequests: number }>>();
    const coverage: (string | number)[][] = [];
    for (const m of soakModes) {
      let injected = 0;
      let visible = 0;
      for (const l of of('soak', m)) {
        const faults = l.run.verify?.faults ?? [];
        const bins = binRecs(l.recs, l.run.t0);
        faults.forEach((flt, i) => {
          const from = Math.floor((flt.injectTs - l.run.t0) / 1000);
          const to = i + 1 < faults.length ? Math.floor((faults[i + 1].injectTs - l.run.t0) / 1000) : from + 60;
          let failedSeconds = 0;
          let failedRequests = 0;
          for (let b = from; b < to; b++) {
            const v = bins.get(b);
            if (!v) continue;
            failedRequests += v.total - v.ok;
            if (v.ok / v.total < SLO_RATIO) failedSeconds++;
          }
          injected++;
          if (failedSeconds > 0) visible++;
          const row = perFault.get(flt.name) ?? new Map();
          const cell = row.get(m) ?? { visible: 0, n: 0, failedSeconds: 0, failedRequests: 0 };
          cell.n++; cell.failedSeconds += failedSeconds; cell.failedRequests += failedRequests;
          if (failedSeconds > 0) cell.visible++;
          row.set(m, cell);
          perFault.set(flt.name, row);
        });
      }
      const p = pool(of('soak', m).map((l) => l.all));
      coverage.push([m, injected, visible, injected ? pct(1 - visible / injected, 1) : '–', p.failures, p.downtime, f(p.mttr), f(p.mttf), f(p.mtbf), pct(p.availability)]);
    }
    out.push(table(['Fault (in injection order)', ...soakModes.flatMap((m) => [`${m}: became a failure`, `${m}: failed s (mean)`, `${m}: failed req. (mean)`])],
      [...perFault.entries()].map(([name, row]) => [name, ...soakModes.flatMap((m) => {
        const c = row.get(m);
        return c ? [`${c.visible}/${c.n}`, f(c.failedSeconds / c.n), f(c.failedRequests / c.n)] : ['–', '–', '–'];
      })])), '');
    out.push(table(['Mode', 'Faults injected', 'Became failures', 'Coverage', 'Failures (episodes)', 'Downtime (s)', 'MTTR (s)', 'MTTF (s)', 'MTBF (s)', 'A'], coverage), '');
  }

  // ---- model ----
  out.push('## 5. Series/parallel model (illustrative inputs)', '');
  out.push('This section is **not a measurement**. It shows what the redundancy structure is worth under an assumed, ' +
    'explicitly illustrative component failure behaviour, and uses measured restore times where the campaign provides them.', '');
  const MTTF_C = 30 * 24 * 3600;  // illustrative: one failure per component per 30 days
  const soakMttr = (m: string) => { const p = of('soak', m).length ? pool(of('soak', m).map((l) => l.all)) : null; return p?.mttr ?? null; };
  const mttrBase = soakMttr('baseline') ?? 25;
  const mttrFinal = soakMttr('final') ?? 5;
  const aB = componentA(MTTF_C, mttrBase);
  const aF = componentA(MTTF_C, mttrFinal);
  // Baseline: no health checks, no retry, no failover: every component a request touches is in series.
  // 11 = nginx, gateway, 2 student, 2 payment, transcript, db primary (replicas are in rotation without
  // health checks, so a dead replica fails its share: counted in series), auth excluded (no login in baseline).
  const baseSeries = series(...Array(8).fill(aB));
  // Final: nginx (single) in series with parallel pairs (gateways, students, payments, db nodes) and transcript (single, masked by cache for reads).
  const finalStruct = series(aF, parallel(aF, aF), parallel(aF, aF), parallel(aF, aF), parallel(aF, aF), aF);
  const year = 365 * 24 * 3600;
  out.push(table(['Input', 'Value', 'Source'], [
    ['component MTTF', '30 days', '**illustrative assumption**, the same for every component and mode'],
    ['component MTTR, baseline', `${f(mttrBase)} s`, 'measured: soak MTTR in baseline (the operator repairs after 25 s)'],
    ['component MTTR, final', `${f(mttrFinal)} s`, 'measured: soak MTTR in final (service restored by the mechanisms)'],
  ]), '');
  out.push(table(['Configuration', 'Structure', 'Availability (model)', 'Downtime per year (model)'], [
    ['baseline', 'series of 8: nginx, gateway, student ×2, payment ×2, transcript, database', pct(baseSeries, 5), `${f((1 - baseSeries) * year / 60)} min`],
    ['final', 'nginx · (gateway ∥ gateway) · (student ∥ student) · (payment ∥ payment) · (db ∥ db) · transcript', pct(finalStruct, 5), `${f((1 - finalStruct) * year / 60)} min`],
  ]), '');
  out.push('Formulas: A_component = MTTF / (MTTF + MTTR); series A = Π A_i; parallel A = 1 − Π (1 − A_i). ' +
    'The model assumes independent failures, which one Docker host does not give (a host failure is common-mode), ' +
    'and it treats a parallel pair as perfect, while the measurements in section 4 show that some faults still cost a few seconds. ' +
    'In the final structure the two single components (nginx, transcript) carry almost all of the modelled downtime.', '');

  writeFileSync(join(ROOT, 'reports/final/RELIABILITY.md'), out.join('\n') + '\n');
  writeFileSync(join(ROOT, 'reports/final/reliability.csv'), csv.join('\n') + '\n');
  console.log(`${loaded.length} run(s) -> reports/final/RELIABILITY.md, reports/final/reliability.csv`);
}
