# Network / service timeout -- BASELINE

Run window: 2026-09-22 13:35:07.174 to 2026-09-22 13:36:17.680 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

3000 ms of artificial latency is injected into student-1 only. Its health endpoint stays fast, so the instance is alive-but-slow -- the case a liveness probe cannot catch.

**Expected behaviour of the fault-tolerance mechanisms:** The per-attempt timeout (800 ms) fires, the retry lands on student-2 via ring rotation, and the client sees a normal response time instead of a 3 s stall.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | 3000 ms of artificial latency is injected into student-1 only. |
| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | 8261 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 8261 |
| Successful | 8261 |
| **Failed** | **0** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 100.00 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | n/a |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 7 / 14 / 24 / 3021 ms |

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
| Payment requests sent | 1941 | of which 334 were client resends |
| Distinct payment intents | 1607 | |
| Requests answered "already processed" (HTTP 200) | 0 | no request was recognised as a duplicate |
| **Duplicate charges** | 334 | FAIL -- money taken twice for the same intent |
| Intents with no charge confirmed to the client | 0 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back by recovery | 0 | |
| Completed rows in the database | 1941 | +334 against the number of intents sent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/net-timeout__baseline/workload.jsonl.gz` -- one line per client request (8261 lines)
* `logs/net-timeout__baseline/events.jsonl.gz` -- one line per service-side event in this window (24787 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
