import type { Rec } from './workload.ts';
import type { AlertObs } from './alerts.ts';
import { summarizeResources, type ResSample } from './resources.ts';

export type Event = Record<string, any>;

// Nearest-rank percentile: the smallest value with at least p % of the values at or below it.
export const pct = (xs: number[], p: number): number => {
  if (xs.length === 0) return 0;
  const sorted = xs.slice().sort((a, b) => a - b);
  return sorted[Math.min(xs.length - 1, Math.max(0, Math.ceil((p / 100) * xs.length) - 1))];
};

const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);

export type Outage = { startTs: number; endTs: number | null; durationMs: number; open: boolean };

export function outages(recs: Rec[], t0: number, t1: number): { outages: Outage[]; upBins: number; downBins: number; idleBins: number } {
  const bins = new Map<number, { total: number; ok: number }>();
  for (const r of recs) {
    const b = Math.floor((r.ts - t0) / 1000);  // 1 s bins; a bin with no success = down
    const cur = bins.get(b) ?? { total: 0, ok: 0 };
    cur.total++;
    if (r.ok) cur.ok++;
    bins.set(b, cur);
  }

  const n = Math.ceil((t1 - t0) / 1000);
  const state: ('up' | 'down' | 'idle')[] = [];
  for (let b = 0; b < n; b++) {
    const v = bins.get(b);
    state.push(!v || v.total === 0 ? 'idle' : v.ok > 0 ? 'up' : 'down');
  }

  const out: Outage[] = [];
  let runStart: number | null = null;
  for (let b = 0; b <= n; b++) {
    const s = b < n ? state[b] : 'up';
    if (s === 'down' && runStart === null) runStart = b;
    if (s === 'up' && runStart !== null) {
      const startTs = recs.find((r) => !r.ok && r.ts >= t0 + runStart! * 1000)?.ts ?? t0 + runStart * 1000;
      const endTs = recs.find((r) => r.ok && r.ts >= t0 + b * 1000)?.ts ?? t0 + b * 1000;
      out.push({ startTs, endTs, durationMs: endTs - startTs, open: false });
      runStart = null;
    }
  }
  if (runStart !== null) {
    const startTs = recs.find((r) => !r.ok && r.ts >= t0 + runStart! * 1000)?.ts ?? t0 + runStart * 1000;
    out.push({ startTs, endTs: null, durationMs: t1 - startTs, open: true });
  }

  return {
    outages: out,
    upBins: state.filter((s) => s === 'up').length,
    downBins: state.filter((s) => s === 'down').length,
    idleBins: state.filter((s) => s === 'idle').length,
  };
}

// Successful responses per second (goodput) before the fault, between inject and repair, and after the repair.
export function throughput(recs: Rec[], t0: number, injectTs: number, repairTs: number, t1: number) {
  const rps = (from: number, to: number): number | null => {
    if (to <= from) return null;
    const n = recs.filter((r) => r.ok && r.ts >= from && r.ts < to).length;
    return n / ((to - from) / 1000);
  };
  return {
    preFaultRps: rps(t0, injectTs),
    duringFaultRps: rps(injectTs, repairTs),
    postRepairRps: rps(repairTs, t1),
  };
}

export type AlertMetric = {
  name: string;
  fired: boolean;
  detectionMs: number | null;             // firstFiringTs - injectTs
  resolvedAfterRepairMs: number | null;   // resolvedTs - repairTs
  firstPendingTs: number | null;
  firstFiringTs: number | null;
  resolvedTs: number | null;
};

export function alertMetrics(obs: AlertObs[], injectTs: number, repairTs: number | null): AlertMetric[] {
  return obs.map((a) => ({
    name: a.name,
    fired: a.firstFiringTs != null,
    detectionMs: a.firstFiringTs != null ? a.firstFiringTs - injectTs : null,
    resolvedAfterRepairMs: a.resolvedTs != null && repairTs ? a.resolvedTs - repairTs : null,
    firstPendingTs: a.firstPendingTs,
    firstFiringTs: a.firstFiringTs,
    resolvedTs: a.resolvedTs,
  }));
}

export type MetricsExtra = { repairTs?: number; alerts?: AlertObs[]; resources?: ResSample[] };

export function computeMetrics(recs: Rec[], events: Event[], t0: number, t1: number, injectTs: number, extra: MetricsExtra = {}) {
  const observationMs = t1 - t0;
  const repairTs = extra.repairTs || t1;
  const { outages: outs, upBins, downBins, idleBins } = outages(recs, t0, t1);

  const ttfs: number[] = [];
  let cursor = t0;
  for (const o of outs) {
    ttfs.push(o.startTs - cursor);
    if (o.endTs) cursor = o.endTs;
  }

  const mttr = mean(outs.filter((o) => !o.open).map((o) => o.durationMs));  // MTTR: mean outage length
  const mttf = mean(ttfs);  // MTTF: mean uptime before an outage
  const onsets = outs.map((o) => o.startTs);
  const mtbfDirect = onsets.length >= 2 ? mean(onsets.slice(1).map((t, i) => t - onsets[i])) : null;
  const mtbf = mtbfDirect ?? (mttf != null && mttr != null ? mttf + mttr : null);  // MTBF = MTTF + MTTR

  const firstFailAfter = recs.find((r) => !r.ok && r.ts >= injectTs)?.ts ?? null;
  const firstHealthAfter = events.find((e) => e.kind === 'health' && e.ok === false && e.ts >= injectTs)?.ts ?? null;
  const firstAttemptFail = events.find((e) => e.kind === 'attempt' && e.ok === false && e.ts >= injectTs)?.ts ?? null;
  const firstUpstreamFail = events.find((e) => e.kind === 'upstream' && e.ok === false && e.ts >= injectTs)?.ts ?? null;
  const detectionCandidates = [firstFailAfter, firstHealthAfter, firstAttemptFail, firstUpstreamFail]
    .filter((x): x is number => x != null);
  const detectionMs = detectionCandidates.length ? detectionCandidates.reduce((a, b) => (b < a ? b : a)) - injectTs : null;  // earliest evidence of the fault
  const outageAfterInject = outs.find((o) => o.startTs >= injectTs);
  const internalFailures = events.filter((e) => (e.kind === 'attempt' || e.kind === 'upstream') && e.ok === false && e.ts >= injectTs);
  const absorptionMs = internalFailures.length ? internalFailures[internalFailures.length - 1].ts - injectTs : null;
  const recoveryMs = outageAfterInject?.endTs != null ? outageAfterInject.endTs - injectTs : null;

  const ok = recs.filter((r) => r.ok);
  const latencies = ok.map((r) => r.ms);
  const count = (pred: (e: Event) => boolean) => events.filter(pred).length;
  // Read availability: GETs only (students, transcripts). It survives a primary outage because reads
  // fail over to the hot standby (H2), so db-failure is judged on reads, not on the writes that fail fast.
  const reads = recs.filter((r) => r.op === 'students' || r.op === 'transcripts');
  const readOk = reads.filter((r) => r.ok).length;
  // Write path (payments) on its own: the critical workflow. Its outages are invisible in the
  // all-request bins while reads still succeed, so they are computed separately (final).
  const writes = recs.filter((r) => r.op === 'payments');
  const writeOk = writes.filter((r) => r.ok).length;
  const writeOut = outages(writes, t0, t1);
  const writeOutageAfterInject = writeOut.outages.find((o) => o.startTs >= injectTs - 1000);
  // SLO seconds: 1 s bins in which fewer than 99 % of the requests succeeded (SLO-1 burn).
  const sloBins = new Map<number, { total: number; ok: number }>();
  for (const r of recs) {
    const b = Math.floor((r.ts - t0) / 1000);
    const cur = sloBins.get(b) ?? { total: 0, ok: 0 };
    cur.total++;
    if (r.ok) cur.ok++;
    sloBins.set(b, cur);
  }
  const badSeconds = [...sloBins.values()].filter((v) => v.total > 0 && v.ok / v.total < 0.99).length;

  return {
    observationMs,
    requests: {
      total: recs.length,
      successful: ok.length,
      failed: recs.length - ok.length,
      degraded: recs.filter((r) => r.degraded).length,
      clientTimeouts: recs.filter((r) => r.err === 'client_timeout').length,
      rateLimited: recs.filter((r) => r.status === 429).length,
      errorRate: recs.length === 0 ? null : (recs.length - ok.length) / recs.length,
    },
    throughput: throughput(recs, t0, injectTs, repairTs, t1),
    availability: {
      timeBased: upBins + downBins === 0 ? null : upBins / (upBins + downBins),
      requestBased: recs.length === 0 ? null : ok.length / recs.length,
      readRequestBased: reads.length === 0 ? null : readOk / reads.length,
      writeRequestBased: writes.length === 0 ? null : writeOk / writes.length,
      upBins, downBins, idleBins,
      badSeconds,                              // seconds with < 99 % of requests successful
      measuredSeconds: sloBins.size,
    },
    writePath: {
      requests: writes.length,
      failed: writes.length - writeOk,
      outages: writeOut.outages,
      downtimeMs: writeOut.outages.reduce((a, o) => a + o.durationMs, 0),
      // inject -> first successful payment after the write outage that the fault caused; null when
      // the write path never went down (fault masked) or never came back inside the window
      recoveryMs: writeOutageAfterInject?.endTs != null ? writeOutageAfterInject.endTs - injectTs : null,
      wentDown: writeOutageAfterInject != null,
    },
    reliability: {
      observedFailures: outs.length,
      mttfMs: mttf,
      mttfCensored: outs.length === 0,          // no failure observed: MTTF > observation window
      mtbfMs: mtbf,
      mtbfSource: mtbfDirect != null ? 'observed onset intervals' : 'MTTF + MTTR (fewer than two outages)',
      mttrMs: mttr,
      failureRatePerHour: outs.length / (observationMs / 3_600_000),
      outages: outs,
    },
    response: {
      detectionMs,
      recoveryMs,
      absorptionMs,
      faultMasked: detectionCandidates.length > 0 && firstFailAfter == null,
      detectionSource: firstAttemptFail != null && firstAttemptFail === detectionCandidates.reduce((a, b) => (b < a ? b : a)) ? 'failed call attempt'
        : firstHealthAfter != null && firstHealthAfter === detectionCandidates.reduce((a, b) => (b < a ? b : a)) ? 'failed health probe'
        : firstFailAfter != null ? 'client-visible failure' : 'none',
      avgMs: mean(latencies),
      p50Ms: pct(latencies, 50),
      p95Ms: pct(latencies, 95),
      p99Ms: pct(latencies, 99),
      maxMs: latencies.reduce((a, b) => (b > a ? b : a), 0),
    },
    mechanisms: {
      failedCallAttempts: count((e) => e.kind === 'attempt' && e.ok === false),
      retriesThatSucceeded: count((e) => e.kind === 'recovery' && e.action === 'retry_succeeded'),
      breakerOpened: count((e) => e.kind === 'breaker' && e.state === 'open'),
      degradedResponses: count((e) => e.kind === 'degraded'),
      replicaReads: count((e) => e.kind === 'degraded' && e.reason === 'read_from_replica'),
      duplicatesSuppressed: count((e) => e.kind === 'recovery' && e.action === 'duplicate_suppressed'),
      checkpointsRolledBack: count((e) => e.kind === 'recovery' && e.action === 'checkpoint_rolled_back'),
      dbPromotions: count((e) => e.kind === 'failover' && e.action === 'promote'),
      dbWriterSwitches: count((e) => e.kind === 'failover' && e.action === 'writer_changed'),
      dbFenced: count((e) => e.kind === 'failover' && e.action === 'fence'),
      dbSyncOff: count((e) => e.kind === 'failover' && e.action === 'sync_off'),
      healthTransitions: events.filter((e) => e.kind === 'health').map((e) => ({ ts: e.ts, target: e.target, ok: e.ok })),
    },
    alerts: alertMetrics(extra.alerts ?? [], injectTs, extra.repairTs ?? null),
    resources: summarizeResources(extra.resources ?? []),
  };
}

export type Metrics = ReturnType<typeof computeMetrics>;

export type Ledger = {
  completed: number; pending: number; rolledBack: number; failedPay: number;
  charged: number; balances: number;
};

export type DbPaymentRow = { key: string; state: string };

// The ledger totals query's output: six '|'-separated numbers. Anything else (an empty or partial
// answer) is null: unmeasured, never zeros.
export function parseLedger(out: string | null | undefined): Ledger | null {
  if (out == null) return null;
  const parts = out.trim().split('|');
  if (parts.length !== 6 || parts.some((p) => p.trim() === '')) return null;
  const n = parts.map(Number);
  if (n.some((x) => !Number.isFinite(x))) return null;
  const [completed, pending, rolledBack, failedPay, charged, balances] = n;
  return { completed, pending, rolledBack, failedPay, charged, balances };
}

// A payment is acknowledged when the client was told it completed: 201 (a fresh charge) or 200 with
// state 'completed' (a resend answered with the stored result). A resend of a payment whose first
// attempt crashed after the checkpoint gets 200 with the stored row, state 'pending' (or 'rolled_back'):
// that is not a completion, so it is not an acknowledgement; it is reported as ackedNotCompleted.
const ACKED = (r: Rec) => r.status === 201 || (r.status === 200 && r.payState === 'completed');
const ACKED_NOT_COMPLETED = (r: Rec) => r.status === 200 && r.payState !== 'completed';

// Payment integrity from the client's view (recs) and the DB's (ledger totals and, when available,
// one row per payment: idempotency key and state).
// `ledger` is null when the totals query failed: the ledger fields are then null (not zeros), so the
// criteria that read them fail instead of passing on data that was never measured.
//   lostRecords    intents acknowledged (201, or 200 + state 'completed') but not `completed` in the DB
//   phantomRecords `completed` in the DB with no 2xx acknowledgement (allowed: the ack was lost; reported)
//   duplicateCharges  DB: completed rows per key beyond the first (the UNIQUE constraint makes this 0,
//                  so the check proves it) + client: 201 answers per intent beyond the first
// Baseline stores a fresh UUID per request and ignores Idempotency-Key, so no DB key matches a client
// intent; the key-level checks then fall back to counts (integrityBasis: 'count').
export function consistencyFrom(recs: Rec[], ledger: Ledger | null, dbRows?: DbPaymentRow[] | null) {
  const payments = recs.filter((r) => r.op === 'payments');
  const chargesPerIntent = new Map<string, number>();
  const intents = new Set<string>();
  const acked = new Set<string>();
  const ackedNotCompletedByState: Record<string, number> = {};
  const ackedNotCompletedIntents = new Set<string>();
  for (const r of payments) {
    const intent = String(r.intent);
    intents.add(intent);
    if (ACKED(r)) acked.add(intent);
    if (ACKED_NOT_COMPLETED(r)) {
      const st = r.payState ?? 'unknown';
      ackedNotCompletedByState[st] = (ackedNotCompletedByState[st] ?? 0) + 1;
      ackedNotCompletedIntents.add(intent);
    }
    if (r.status === 201) chargesPerIntent.set(intent, (chargesPerIntent.get(intent) ?? 0) + 1);
  }
  for (const k of acked) ackedNotCompletedIntents.delete(k);  // a later real ack supersedes the misleading 200
  let duplicatesClient = 0;
  for (const n of chargesPerIntent.values()) duplicatesClient += Math.max(0, n - 1);

  let integrityBasis: 'idempotency-key' | 'count' | null = null;
  let lostIntents: string[] = [];
  let lostRecords: number | null = null;
  let phantomRecords: number | null = null;
  let duplicatesDb: number | null = null;
  if (dbRows) {
    const completedPerKey = new Map<string, number>();
    for (const row of dbRows) {
      if (row.state === 'completed') completedPerKey.set(row.key, (completedPerKey.get(row.key) ?? 0) + 1);
    }
    duplicatesDb = 0;
    for (const n of completedPerKey.values()) duplicatesDb += Math.max(0, n - 1);

    const keyLevel = dbRows.length === 0 || dbRows.some((row) => intents.has(row.key));
    if (keyLevel) {
      integrityBasis = 'idempotency-key';
      lostIntents = [...acked].filter((k) => !completedPerKey.has(k)).sort();
      lostRecords = lostIntents.length;
      phantomRecords = [...completedPerKey.keys()].filter((k) => !acked.has(k)).length;
    } else {
      integrityBasis = 'count';
      const ackedResponses = payments.filter(ACKED).length;
      const completedRows = dbRows.filter((row) => row.state === 'completed').length;
      lostRecords = Math.max(0, ackedResponses - completedRows);
      phantomRecords = Math.max(0, completedRows - ackedResponses);
    }
  }

  return {
    paymentRequestsSent: payments.length,
    paymentRequestsAccepted: payments.filter((r) => r.ok).length,
    paymentRequestsRateLimited: payments.filter((r) => r.status === 429).length,
    distinctPaymentIntents: intents.size,
    acknowledgedIntents: acked.size,
    deduplicatedResponses: payments.filter((r) => r.status === 200).length,
    // HTTP 200 whose body state is not 'completed' (e.g. a resend of a crashed payment: pending).
    // Not counted as acknowledged; reported so the misleading 200 stays visible.
    ackedNotCompleted: payments.filter(ACKED_NOT_COMPLETED).length,
    ackedNotCompletedByState,
    ackedNotCompletedIntents: ackedNotCompletedIntents.size,  // intents whose only 200s were not completed
    duplicateCharges: duplicatesClient + (duplicatesDb ?? 0),
    duplicateChargesClient: duplicatesClient,
    duplicateChargesDb: duplicatesDb,
    unacknowledgedIntents: intents.size - acked.size,
    integrityBasis,
    lostRecords,
    lostIntents: lostIntents.slice(0, 50),  // the first 50, for diagnosis; lostRecords is the full count
    phantomRecords,
    dbRows: dbRows ? dbRows.length : null,
    ledgerMeasured: ledger != null,
    completedInDb: ledger ? ledger.completed : null,
    dbVsIntents: ledger ? ledger.completed - intents.size : null,
    orphanedPending: ledger ? ledger.pending : null,
    rolledBack: ledger ? ledger.rolledBack : null,
    failedPay: ledger ? ledger.failedPay : null,
    totalCharged: ledger ? ledger.charged : null,
    ledgerBalanced: ledger ? ledger.charged === ledger.balances : null,
  };
}

export type Consistency = ReturnType<typeof consistencyFrom>;
