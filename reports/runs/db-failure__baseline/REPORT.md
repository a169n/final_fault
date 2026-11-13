# Database failure -- BASELINE

Run window: 2026-09-22 13:33:52.717 to 2026-09-22 13:35:03.223 (71 s observation)
Version under test: `FT_ENABLED=0`

## What was done to the system

The PostgreSQL primary is stopped. The hot standby stays up.

**Expected behaviour of the fault-tolerance mechanisms:** Reads fail over to the standby, the transcript service serves stale cached data flagged as degraded, writes fail fast instead of hanging, and the circuit breaker prevents a retry storm.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | The PostgreSQL primary is stopped. |
| T+30.4s | first failed request | client-visible outage begins |
| T+40.4s | first success after outage | outage ends after 10.0 s |
| T+45.0s | operator repair issued | the only thing that can restore service in the baseline |
| T+70.5s | workload ends | 7175 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 7175 |
| Successful | 7140 |
| **Failed** | **35** |
| Served degraded (HTTP 203, stale data) | 0 |
| Client timeouts (10 s patience exceeded) | 20 |
| Availability, request-based | 99.51 % |
| Availability, time-based | 97.78 % |
| Observed failures (outages) | 1 |
| MTTF | 30.4 s |
| MTBF | 40.4 s (MTTF + MTTR (fewer than two outages)) |
| MTTR | 10.0 s |
| Observed failure rate | 51.1 outages/hour |
| **Detection time** | 284 ms (via client-visible failure) |
| Fault actively absorbed for | n/a (last internal failure after injection) |
| Fault masked from clients entirely | no |
| **Recovery time** (client-visible outage ends) | 20358 ms |
| Latency p50 / p95 / p99 / max | 7 / 15 / 22 / 9571 ms |

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
| Payment requests sent | 1583 | of which 260 were client resends |
| Distinct payment intents | 1323 | |
| Requests answered "already processed" (HTTP 200) | 0 | no request was recognised as a duplicate |
| **Duplicate charges** | 258 | FAIL -- money taken twice for the same intent |
| Intents with no charge confirmed to the client | 6 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back by recovery | 0 | |
| Completed rows in the database | 1578 | +255 against the number of intents sent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/db-failure__baseline/workload.jsonl.gz` -- one line per client request (7175 lines)
* `logs/db-failure__baseline/events.jsonl.gz` -- one line per service-side event in this window (21511 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
