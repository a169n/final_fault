# Corrupted / lost transaction -- BASELINE

Run window: 2026-09-22 13:37:36.162 to 2026-09-22 13:38:46.670 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

Both payment instances are armed to exit(1) immediately after writing the durable checkpoint but before committing the charge, leaving an orphaned pending payment.

**Expected behaviour of the fault-tolerance mechanisms:** The recovery sweep rolls the orphaned checkpoint back so no money is half-moved, and the idempotency key ensures the client retry does not become a second charge.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Both payment instances are armed to exit(1) immediately after writing the durable checkpoint but before committing the charge, leaving an orphaned pending payment. |
| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | 12531 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12531 |
| Successful | 11447 |
| **Failed** | **1084** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 91.35 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 12 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 7 / 13 / 19 / 1018 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 0 |
| Requests rescued by retry | 0 |
| Circuit breaker openings | 0 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 0 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests sent | 2896 | of which 492 were client resends |
| Distinct payment intents | 2404 | |
| Requests answered "already processed" (HTTP 200) | 0 | no request was recognised as a duplicate |
| **Duplicate charges** | 307 | FAIL -- money taken twice for the same intent |
| Intents with no charge confirmed to the client | 899 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 2 | FAIL -- money neither charged nor released, with nothing to reconcile it |
| Checkpoints rolled back by recovery | 0 | |
| Completed rows in the database | 1812 | -592 against the number of intents sent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/txn-interrupt__baseline/workload.jsonl.gz` -- one line per client request (12531 lines)
* `logs/txn-interrupt__baseline/events.jsonl.gz` -- one line per service-side event in this window (35431 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
