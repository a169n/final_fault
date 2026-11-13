# Hardware / node failure -- FT

Run window: 2026-09-22 13:28:27.670 to 2026-09-22 13:29:38.175 (71 s observation)
Version under test: `FT_ENABLED=1`

## What was done to the system

student-1 and payment-1 are SIGKILLed together, modelling the loss of one physical node that hosted both. A SIGKILL from the operator does not trip the restart policy, so the node stays down until it is repaired.

**Expected behaviour of the fault-tolerance mechanisms:** The surviving node (student-2, payment-2) absorbs the full load; the platform degrades in capacity, not in availability.

## Timeline

| Offset | Event | Detail |
|---|---|---|
| T+0.0s | workload starts | 10 concurrent clients, 60 % student reads / 20 % transcript reads / 20 % payments |
| T+20.0s | **fault injected** | student-1 and payment-1 are SIGKILLed together, modelling the loss of one physical node that hosted both. |
| T+20.6s | health probe | payment-1:3000 -> UNHEALTHY |
| T+20.6s | health probe | student-1:3000 -> UNHEALTHY |
| T+45.0s | operator repair issued | usually a no-op: the system had already healed itself |
| T+46.8s | health probe | payment-1:3000 -> healthy |
| T+46.8s | health probe | student-1:3000 -> healthy |
| T+70.5s | workload ends | 12645 requests issued |

## Measured results

| Metric | Value |
|---|---|
| Total requests | 12645 |
| Successful | 12645 |
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
| **Detection time** | 359 ms (via failed call attempt) |
| Fault actively absorbed for | 555 ms (last internal failure after injection) |
| Fault masked from clients entirely | yes -- detected and absorbed before any client saw a failure |
| **Recovery time** (client-visible outage ends) | no client-visible outage occurred |
| Latency p50 / p95 / p99 / max | 6 / 13 / 18 / 122 ms |

## Fault-tolerance mechanisms that fired

| Mechanism | Count |
|---|---|
| Failed call attempts absorbed internally | 15 |
| Requests rescued by retry | 15 |
| Circuit breaker openings | 0 |
| Degraded (stale-data) responses | 0 |
| Reads failed over to the standby | 0 |
| Duplicate payments suppressed | 497 |
| Orphaned checkpoints rolled back | 0 |

## Data consistency

| Check | Value | Verdict |
|---|---|---|
| Payment requests sent | 2992 | of which 497 were client resends |
| Distinct payment intents | 2495 | |
| Requests answered "already processed" (HTTP 200) | 497 | the idempotency key did its job |
| **Duplicate charges** | 0 | PASS -- no intent was charged more than once |
| Intents with no charge confirmed to the client | 0 | upper bound on lost transactions; no money moved that the client can see |
| **Orphaned pending checkpoints** | 0 | PASS -- no half-finished transaction left behind |
| Checkpoints rolled back by recovery | 0 | |
| Completed rows in the database | 2495 | exactly one per intent |
| Ledger balanced (payments = balances) | true | PASS |

A duplicate charge and a lost transaction are different failures and are counted
separately: the first takes money twice, the second takes none and is safe to
retry. Collapsing them into one number hides which of the two actually happened.

## Raw data

* `logs/node-failure__ft/workload.jsonl.gz` -- one line per client request (12645 lines)
* `logs/node-failure__ft/events.jsonl.gz` -- one line per service-side event in this window (51111 lines)
* `metrics.json` (next to this report) -- the computed metrics above, machine-readable

Metric definitions are in `experiments/metrics.ts`; every value here is derived from
the two raw files and can be recomputed from them.
