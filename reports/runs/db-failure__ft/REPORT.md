# Database failure -- FT

Run window: 2026-09-22 13:25:58.518 to 2026-09-22 13:27:09.027 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

The PostgreSQL primary is stopped. The hot standby stays up.

**Expected behaviour of the fault-tolerance mechanisms:** Reads fail over to the standby, the transcript service serves stale cached data flagged as degraded, writes fail fast instead of hanging, and the circuit breaker prevents a retry storm.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | The PostgreSQL primary is stopped. |
| T+21.1s | health probe | payment-1:3000 -> UNHEALTHY |
| T+21.5s | health probe | payment-2:3000 -> UNHEALTHY |
| T+21.5s | health probe | student-1:3000 -> UNHEALTHY |
| T+21.5s | health probe | student-2:3000 -> UNHEALTHY |
| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+48.8s | health probe | student-2:3000 -> healthy |
| T+48.8s | health probe | student-1:3000 -> healthy |
| T+50.1s | health probe | payment-2:3000 -> healthy |
| T+52.7s | health probe | payment-1:3000 -> healthy |
| T+70.5s | workload ends | 8704 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 8704 |
| Successful | 8172 |
| **Failed** | **532** |
| Served degraded (HTTP 203, stale data) | 1422 |
| Client timeouts (10 s patience exceeded) | 0 |
| Availability, request-based | 93.89 % |
| Availability, time-based | 100.00 % |
| Observed failures (outages) | 0 |
| MTTF | > 70.5 s (right-censored: no outage occurred) |
| MTBF | n/a  |
| MTTR | n/a |
| Observed failure rate | 0.0 outages/hour |
| **Detection time** | 367 ms (via client-visible failure) |
| Fault actively absorbed for | 33922 ms (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | n/a |
| Latency p50 / p95 / p99 / max | 7 / 20 / 63 / 2566 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 236 |
| Requests rescued by retry | 7 |
| Circuit breaker openings | 3 |
| Degraded (stale-data) responses | 1591 |
| Reads failed over to the standby | 169 |
| Duplicate payments suppressed | 230 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests sent | 1970 | of which 324 were client resends |
| Distinct payment intents | 1646 | |
| Requests answered "already processed" (HTTP 200) | 230 | the idempotency key did its job |
| **Duplicate charges** | 0 | PASS -- no intent was charged more than once |
| Intents with no charge confirmed to the client | 437 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back by recovery | 0 | |
| Completed rows in the database | 1209 | -437 against the number of intents sent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/db-failure__ft/workload.jsonl.gz` -- one line per client request (8704 lines)
* `logs/db-failure__ft/events.jsonl.gz` -- one line per service-side event in this window (33229 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
