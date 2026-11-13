# Application crash -- BASELINE

Run window: 2026-09-22 13:32:38.245 to 2026-09-22 13:33:48.754 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

student-1 kills its own process (exit 1) from inside the container, simulating an unhandled fatal error rather than an operator stop.

**Expected behaviour of the fault-tolerance mechanisms:** Health checks detect the dead instance within one poll interval, the gateway routes to student-2, the restart policy brings the instance back, and in-flight requests are saved by retry.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | student-1 kills its own process (exit 1) from inside the container, simulating an unhandled fatal error rather than an operator stop. |
| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | 11982 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 11982 |
| Successful | 10782 |
| **Failed** | **1200** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 3 |
| Availability, request-based | 89.98 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 57 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 6 / 14 / 21 / 89 ms |

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
| Payment requests sent | 2690 | of which 445 were client resends |
| Distinct payment intents | 2245 | |
| Requests answered "already processed" (HTTP 200) | 0 | no request was recognised as a duplicate |
| **Duplicate charges** | 445 | FAIL -- money taken twice for the same intent |
| Intents with no charge confirmed to the client | 2 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back by recovery | 0 | |
| Completed rows in the database | 2690 | +445 against the number of intents sent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/app-crash__baseline/workload.jsonl.gz` -- one line per client request (11982 lines)
* `logs/app-crash__baseline/events.jsonl.gz` -- one line per service-side event in this window (33566 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
