# Corrupted / lost transaction -- FT

Run window: 2026-09-22 13:29:42.223 to 2026-09-22 13:30:52.728 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

Both payment instances are armed to exit(1) immediately after writing the durable checkpoint but before committing the charge, leaving an orphaned pending payment.

**Expected behaviour of the fault-tolerance mechanisms:** The recovery sweep rolls the orphaned checkpoint back so no money is half-moved, and the idempotency key ensures the client retry does not become a second charge.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | Both payment instances are armed to exit(1) immediately after writing the durable checkpoint but before committing the charge, leaving an orphaned pending payment. |
| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+70.5s | workload ends | 12567 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12567 |
| Successful | 12377 |
| **Failed** | **190** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 98.49 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 6 ms (via client-visible failure) |
| Fault actively absorbed for | 5087 ms (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 6 / 14 / 20 / 67 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 6 |
| Requests rescued by retry | 0 |
| Circuit breaker openings | 1 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 455 |
| Orphaned checkpoints rolled back | 2 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests sent | 2879 | of which 478 were client resends |
| Distinct payment intents | 2401 | |
| Requests answered "already processed" (HTTP 200) | 455 | the idempotency key did its job |
| **Duplicate charges** | 0 | PASS -- no intent was charged more than once |
| Intents with no charge confirmed to the client | 162 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back by recovery | 2 | |
| Completed rows in the database | 2241 | -160 against the number of intents sent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/txn-interrupt__ft/workload.jsonl.gz` -- one line per client request (12567 lines)
* `logs/txn-interrupt__ft/events.jsonl.gz` -- one line per service-side event in this window (50373 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
