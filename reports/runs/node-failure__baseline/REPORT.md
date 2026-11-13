# Hardware / node failure -- BASELINE

Run window: 2026-09-22 13:36:21.654 to 2026-09-22 13:37:32.163 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

student-1 and payment-1 are SIGKILLed together, modelling the loss of one physical node that hosted both. A SIGKILL from the operator does not trip the restart policy, so the node stays down until it is repaired.

**Expected behaviour of the fault-tolerance mechanisms:** The surviving node (student-2, payment-2) absorbs the full load; the platform degrades in capacity, not in availability.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | student-1 and payment-1 are SIGKILLed together, modelling the loss of one physical node that hosted both. |
| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | 12469 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12469 |
| Successful | 10624 |
| **Failed** | **1845** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 1 |
| Availability, request-based | 85.20 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 99 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 6 / 13 / 17 / 29 ms |

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
| Payment requests sent | 2880 | of which 468 were client resends |
| Distinct payment intents | 2412 | |
| Requests answered "already processed" (HTTP 200) | 0 | no request was recognised as a duplicate |
| **Duplicate charges** | 305 | FAIL -- money taken twice for the same intent |
| Intents with no charge confirmed to the client | 374 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back by recovery | 0 | |
| Completed rows in the database | 2344 | -68 against the number of intents sent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/node-failure__baseline/workload.jsonl.gz` -- one line per client request (12469 lines)
* `logs/node-failure__baseline/events.jsonl.gz` -- one line per service-side event in this window (33719 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
