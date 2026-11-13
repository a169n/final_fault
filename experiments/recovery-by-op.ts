// Per-operation outage and recovery, derived from the committed raw workload logs.
//
// experiments/metrics.ts measures recovery on 1 s bins over ALL requests: a bin is down only if no
// request at all succeeded in it. A fault that takes down one operation (payment writes) while the
// others keep succeeding (reads) is therefore invisible to `recoveryMs`. This script looks at each
// operation separately, from logs/endterm/<run>/workload.jsonl.gz and the run's injectTs/repairTs
// in reports/endterm/runs/<run>/metrics.json. It reads the campaign files and never changes them.
//
// Per run and operation (times relative to the injection, by request send time `ts`):
//   firstFailMs  first failed request at or after the injection
//   lastFailMs   last failed request at or after the injection
//   recoveredMs  first successful request sent after lastFailMs (every later request of that
//                operation succeeded, so this is the first *sustained* success); null if none
// Requests recorded as `abandoned_at_window_close` (still in flight when the workload stopped) are
// not failures caused by the fault and are left out, as in REPORT.md §8.4 item 1.
//
// It also summarises the fault window [injectTs, repairTs) per operation: requests, failures and the
// latency distribution (nearest-rank percentiles, as in metrics.ts).
//
// Usage: node --experimental-strip-types experiments/recovery-by-op.ts [--logs <dir>] [--runs <dir>] [--out <dir>]
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { pct } from './metrics.ts';
import { MODES, stat, type Stat } from './aggregate.ts';
import { SCENARIOS } from './scenarios.ts';
import type { Rec } from './workload.ts';

export const OPS = ['students', 'transcripts', 'payments'];
const ABANDONED = 'abandoned_at_window_close';
export const SLOW_MS = 2_000;

export type OpRecovery = {
  op: string;
  failures: number;            // failed requests at or after the injection (abandoned excluded)
  firstFailMs: number | null;
  lastFailMs: number | null;
  recoveredMs: number | null;  // first success sent after the last failure
};

export type WindowStats = {
  op: string;          // an operation, 'reads' (students + transcripts) or 'all'
  requests: number;    // sent in [injectTs, repairTs)
  failed: number;      // of those, failed (abandoned excluded)
  latencies: number[]; // ms of every request in the window
};

const isFault = (r: Rec): boolean => !r.ok && r.err !== ABANDONED;

export function recoveryByOp(recs: Rec[], injectTs: number, ops: string[] = OPS): OpRecovery[] {
  return ops.map((op) => {
    const mine = recs.filter((r) => r.op === op && r.ts >= injectTs).sort((a, b) => a.ts - b.ts);
    const fails = mine.filter(isFault);
    if (fails.length === 0) return { op, failures: 0, firstFailMs: null, lastFailMs: null, recoveredMs: null };
    const first = fails[0].ts;
    const last = fails[fails.length - 1].ts;
    const back = mine.find((r) => r.ok && r.ts > last);
    return {
      op,
      failures: fails.length,
      firstFailMs: first - injectTs,
      lastFailMs: last - injectTs,
      recoveredMs: back ? back.ts - injectTs : null,
    };
  });
}

export function faultWindow(recs: Rec[], injectTs: number, repairTs: number): WindowStats[] {
  const inWin = recs.filter((r) => r.ts >= injectTs && r.ts < repairTs);
  const groups: [string, (r: Rec) => boolean][] = [
    ...OPS.map((op): [string, (r: Rec) => boolean] => [op, (r) => r.op === op]),
    ['reads', (r) => r.op === 'students' || r.op === 'transcripts'],
    ['all', () => true],
  ];
  return groups.map(([op, keep]) => {
    const g = inWin.filter(keep);
    return { op, requests: g.length, failed: g.filter(isFault).length, latencies: g.map((r) => r.ms) };
  });
}

export type RunInput = { scenario: string; mode: string; rep: number; injectTs: number; repairTs: number; recs: Rec[] };
export type RunAnalysis = { scenario: string; mode: string; rep: number; repairMs: number; ops: OpRecovery[]; window: WindowStats[] };

export function analyse(run: RunInput): RunAnalysis {
  return {
    scenario: run.scenario,
    mode: run.mode,
    rep: run.rep,
    repairMs: run.repairTs - run.injectTs,
    ops: recoveryByOp(run.recs, run.injectTs),
    window: faultWindow(run.recs, run.injectTs, run.repairTs),
  };
}

const s = (ms: number | null): string => (ms == null ? '–' : (ms / 1000).toFixed(2));
const fmtStat = (st: Stat, unit = 's'): string => {
  if (st.mean == null) return '–';
  const v = unit === 's' ? (x: number) => (x / 1000).toFixed(2) : (x: number) => x.toFixed(0);
  return `${v(st.mean)}${st.sd != null ? ` ± ${v(st.sd)}` : ''} ${unit}${st.n < 3 ? ` [${st.n}/3]` : ''}`;
};
const pctStr = (a: number, b: number): string => (b ? `${((100 * a) / b).toFixed(1)} %` : '–');

const SCENARIO_ORDER = Object.keys(SCENARIOS);
const order = (a: RunAnalysis, b: RunAnalysis): number =>
  SCENARIO_ORDER.indexOf(a.scenario) - SCENARIO_ORDER.indexOf(b.scenario) ||
  MODES.indexOf(a.mode) - MODES.indexOf(b.mode) || a.rep - b.rep;

export function renderCsv(runs: RunAnalysis[]): string {
  const head = 'scenario,mode,rep,op,repair_s,failures,first_fail_s,last_fail_s,recovered_s,recovered_after_repair_s,'
    + 'window_requests,window_failed,window_p50_ms,window_p95_ms,window_slow_share';
  const lines = [head];
  for (const r of runs.slice().sort(order)) {
    for (const w of r.window) {
      const o = r.ops.find((x) => x.op === w.op);
      const after = o?.recoveredMs != null ? o.recoveredMs - r.repairMs : null;
      const slow = w.latencies.filter((ms) => ms >= SLOW_MS).length;
      lines.push([
        r.scenario, r.mode, r.rep, w.op, s(r.repairMs),
        o ? o.failures : '', o ? s(o.firstFailMs) : '', o ? s(o.lastFailMs) : '', o ? s(o.recoveredMs) : '',
        o ? s(after) : '',
        w.requests, w.failed,
        w.latencies.length ? pct(w.latencies, 50) : '', w.latencies.length ? pct(w.latencies, 95) : '',
        w.requests ? (slow / w.requests).toFixed(4) : '',
      ].join(','));
    }
  }
  return lines.join('\n') + '\n';
}

export function renderMarkdown(runs: RunAnalysis[], source: string): string {
  const sorted = runs.slice().sort(order);
  const groups = new Map<string, RunAnalysis[]>();
  for (const r of sorted) {
    const k = `${r.scenario}|${r.mode}`;
    groups.set(k, [...(groups.get(k) ?? []), r]);
  }
  const out: string[] = [];
  out.push('# Per-operation outage and recovery (derived from the raw logs)');
  out.push('');
  out.push(`Generated by \`experiments/recovery-by-op.ts\` from ${source}.`);
  out.push('It reads the committed campaign files and does not change them. Times are seconds after the injection, by request send time; the');
  out.push('repair is at +25.00 s in every scenario that has one. Requests recorded as');
  out.push('`abandoned_at_window_close` are excluded (REPORT.md §8.4 item 1). Values are mean ± sample standard');
  out.push('deviation over the runs that had at least one failure of that operation; "[k/3]" means only k runs did.');
  out.push('');
  out.push('## 1. Outage and recovery per operation');
  out.push('');
  out.push('"Recovered" is the first successful request sent after the last failed one: from then on every request');
  out.push('of that operation succeeded. Only (scenario, mode, operation) cells with at least one failure are listed.');
  out.push('');
  out.push('| Scenario | Mode | Operation | Failures per run | First failure | Last failure | Recovered | Recovered − repair |');
  out.push('|---|---|---|---|---|---|---|---|');
  for (const rs of groups.values()) {
    for (const op of OPS) {
      const os = rs.map((r) => ({ r, o: r.ops.find((x) => x.op === op)! })).filter(({ o }) => o.failures > 0);
      if (os.length === 0) continue;
      const fails = rs.map((r) => r.ops.find((x) => x.op === op)!.failures).join(' / ');
      const after = os.map(({ r, o }) => (o.recoveredMs != null ? o.recoveredMs - r.repairMs : null));
      out.push(`| ${rs[0].scenario} | ${rs[0].mode} | ${op} | ${fails} | ${fmtStat(stat(os.map(({ o }) => o.firstFailMs)))} | `
        + `${fmtStat(stat(os.map(({ o }) => o.lastFailMs)))} | ${fmtStat(stat(os.map(({ o }) => o.recoveredMs)))} | `
        + `${fmtStat(stat(after))} |`);
    }
  }
  out.push('');
  out.push('Per run:');
  out.push('');
  out.push('| Run | Operation | Failures | First failure | Last failure | Recovered | Recovered − repair |');
  out.push('|---|---|---|---|---|---|---|');
  for (const r of sorted) {
    for (const o of r.ops) {
      if (o.failures === 0) continue;
      const after = o.recoveredMs != null ? o.recoveredMs - r.repairMs : null;
      out.push(`| ${r.scenario}__${r.mode}__r${r.rep} | ${o.op} | ${o.failures} | ${s(o.firstFailMs)} s | ${s(o.lastFailMs)} s | `
        + `${o.recoveredMs == null ? 'not within the window' : `${s(o.recoveredMs)} s`} | ${after == null ? '–' : `${s(after)} s`} |`);
    }
  }
  out.push('');
  out.push('## 2. The fault window [injection, repair) per operation');
  out.push('');
  out.push(`Pooled over the 3 runs. "reads" is students + transcripts. Latency percentiles are nearest-rank, as in`);
  out.push(`\`experiments/metrics.ts\`; "≥ ${SLOW_MS / 1000} s" is the share of requests that took ${SLOW_MS} ms or more.`);
  out.push('');
  out.push('| Scenario | Mode | Operation | Requests | Failed | Failed share | Failed per run | p50 | p95 | ≥ 2 s |');
  out.push('|---|---|---|---|---|---|---|---|---|---|');
  for (const rs of groups.values()) {
    for (const op of [...OPS, 'reads', 'all']) {
      const ws = rs.map((r) => r.window.find((w) => w.op === op)!);
      const req = ws.reduce((a, w) => a + w.requests, 0);
      const failed = ws.reduce((a, w) => a + w.failed, 0);
      const lat = ws.flatMap((w) => w.latencies);
      const slow = lat.filter((ms) => ms >= SLOW_MS).length;
      const perRun = ws.map((w) => `${w.failed}/${w.requests}`).join(', ');
      out.push(`| ${rs[0].scenario} | ${rs[0].mode} | ${op} | ${req} | ${failed} | ${pctStr(failed, req)} | ${perRun} | `
        + `${lat.length ? `${pct(lat, 50)} ms` : '–'} | ${lat.length ? `${pct(lat, 95)} ms` : '–'} | ${pctStr(slow, lat.length)} |`);
    }
  }
  out.push('');
  return out.join('\n');
}

export function loadRun(logsDir: string, runsDir: string, name: string): RunInput | null {
  const m = /^(.+)__(baseline|midterm|endterm)__r(\d+)$/.exec(name);
  const metricsPath = join(runsDir, name, 'metrics.json');
  const logPath = join(logsDir, name, 'workload.jsonl.gz');
  if (!m || Number(m[3]) === 0 || !existsSync(metricsPath) || !existsSync(logPath)) return null;
  const metrics = JSON.parse(readFileSync(metricsPath, 'utf8'));
  const recs = gunzipSync(readFileSync(logPath)).toString('utf8').split('\n').filter(Boolean)
    .map((line) => JSON.parse(line) as Rec);
  return { scenario: m[1], mode: m[2], rep: Number(m[3]), injectTs: metrics.injectTs, repairTs: metrics.repairTs, recs };
}

function arg(name: string): string | undefined {
  const argv = process.argv.slice(2);
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ROOT = fileURLToPath(new URL('..', import.meta.url));
  const logsDir = resolve(arg('logs') ?? join(ROOT, 'logs/endterm'));
  const runsDir = resolve(arg('runs') ?? join(ROOT, 'reports/endterm/runs'));
  const outDir = resolve(arg('out') ?? join(ROOT, 'reports/endterm/analysis'));
  const runs = readdirSync(runsDir).sort()
    .map((name) => loadRun(logsDir, runsDir, name))
    .filter((r): r is RunInput => r !== null)
    .map(analyse);
  if (runs.length === 0) {
    console.log(`no runs found under ${runsDir}`);
    process.exit(1);
  }
  mkdirSync(outDir, { recursive: true });
  const rel = (p: string) => (p.startsWith(ROOT) ? p.slice(ROOT.length) : p);
  const source = `\`${rel(logsDir)}/*/workload.jsonl.gz\` and \`${rel(runsDir)}/*/metrics.json\``;
  writeFileSync(join(outDir, 'recovery-by-op.md'), renderMarkdown(runs, source));
  writeFileSync(join(outDir, 'recovery-by-op.csv'), renderCsv(runs));
  console.log(`${runs.length} run(s) -> ${join(outDir, 'recovery-by-op.md')}, ${join(outDir, 'recovery-by-op.csv')}`);
}
