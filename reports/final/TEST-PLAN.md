# Test plan and experimental methodology

This plan fixes the objectives, the configurations, the scenarios, the hypotheses and the pass/fail
criteria of the final campaign. It was committed before the baseline campaign started and while the
first repetition of the final campaign was running; before that, three smoke runs (`--rep 0`,
`db-failure`, `data-loss` twice) had been used to debug the harness, and they are not part of the
results. The criteria were not changed after the campaign; where a criterion turned out to be weak
or wrong, the report says so (REPORT.md §10.4) instead of adjusting it.

## 1. Service-level objectives

The objectives are stated for the critical functions of the system (REPORT.md §3.1) and are the
source of every acceptance criterion below.

| ID | Objective | Target | Measured by |
|---|---|---|---|
| SLO-1 | Availability under a single component fault | ≥ 99.5 % of requests succeed over the experiment window (99.9 % where the fault is expected to be fully masked) | workload log: successful / total |
| SLO-2 | Payment-path recovery without an operator | payments succeed again ≤ 10 s after a single component or database-node failure | workload log: first successful payment after the write outage |
| SLO-3 | Latency | p95 ≤ 1 s for successful requests | workload log |
| SLO-4 | Integrity of payments | 0 duplicate charges, 0 acknowledged payments lost, ledger balanced (Σ completed payments = Σ balances) after any single component failure | key-level comparison of the client log with the database |
| SLO-5 | Recovery from destroyed data | recovery point ≤ 20 s (backup interval 15 s + 5 s), restore ≤ 60 s once started | `data-loss` scenario |
| SLO-6 | Detection | the matching alert fires ≤ 10 s after an instance or database failure, ≤ 15 s after an error spike, ≤ 20 s after records are destroyed | Prometheus alert state, polled every second |
| SLO-7 | Access control | 100 % of unauthorized requests denied and audited; malformed input never causes a 5xx | attack sets, audit log, database |
| SLO-8 | Redundancy restored | after the repair a standby streams from the primary again, with no manual rebuild | database controller state at the end of the run |

## 2. Configurations

One code base and one image; the mode is a set of environment switches written by
`npm run up:<mode>` (`experiments/env.ts`).

| | **baseline** | **final** (improved) |
|---|---|---|
| Switches | `FT_ENABLED=0 ENDTERM_ENABLED=0 FINAL_ENABLED=0` | all three `=1` |
| Restart policy (H3) | `no` | `unless-stopped` |
| nginx | `single.conf`: gateway-1 only | `redundant.conf`: both gateways, failover |
| Gateway: health checks, retry + backoff, timeouts, circuit breaker, stale-cache degradation, outlier ejection | off | on |
| Payment: idempotency keys, checkpoint + rollback sweep | off | on |
| Reads from the standby | off | on |
| Automatic DB failover, fencing, synchronous replication (H8) | off (controller observes only) | on |
| Backups (H9) | off | every 15 s, verified, 20 kept |
| Authentication, authorization, validation, rate limiting, audit, chaos token | off | on |
| DB wait before a service gives up | 60 s | 0.5 s (nested inside the 0.8 s gateway attempt) |

**The same in both, on purpose:** the topology (two replicas per service, two gateways, two
database nodes, all running), the workload, the fault injection, the monitoring plane (Prometheus,
Grafana, exporters, the database controller as an observer, all alert rules), structured logs with
request IDs, the generated database passwords and least-privilege roles. The baseline has the same
hardware redundancy as the final configuration and simply does not use it, so every measured
difference is caused by the mechanisms.

The intermediate modes of the earlier phases (`midterm`, `endterm`) still deploy. The endterm configuration was not re-run; REPORT.md §10.9 cites its earlier campaign.

## 3. Environment and workload

- One host, Docker Compose; 19 containers. Host details are recorded in REPORT.md §9.2.
- Workload (`experiments/workload.ts`): 10 closed-loop workers, 50 ms think time; 60 % student
  reads, 20 % transcript reads, 20 % payments (a POST with a fresh Idempotency-Key; 20 % of the
  payments are re-sent once with the same key, as a client retry). `high-load` adds 100 workers.
  Client timeout 10 s. Every request is recorded with its timestamp, status, latency and request ID.
- Known-state restore before every run (`experiments/run.ts`): all containers started, chaos
  switches reset, payments truncated and balances zeroed, both database nodes up with the standby
  streaming, no alert firing.
- Duration: 70 s per run (fault at 20 s, operator repair at 45 s); `data-loss` 90 s (loss at 40 s,
  restore at 55 s); `soak` 600 s (nine faults).
- Repetitions: 3 per scenario in final, in repetition-major order (all scenarios once, then again);
  planned as 3 for the baseline too, carried out as 1 (REPORT.md §10).
  Each mode starts from fresh volumes (`docker compose down -v`).
- Requests still in flight when the window closes are cut off by the harness and are excluded from
  the metrics (they are kept in the raw log, flagged `abandoned`).

## 4. Scenarios, hypotheses and acceptance criteria

The assignment's minimum experiment matrix (§6) is covered as follows.

| Matrix row | Scenario(s) |
|---|---|
| 1 Application/service instance failure | E1 `app-crash`, E4 `node-failure`, E7 `gateway-failure` |
| 2 Database or dependency unavailable | E2 `db-failure`, E13 `standby-failure` |
| 3 Network delay or timeout | E3 `net-timeout` |
| 4 Interrupted multi-step transaction | E5 `txn-interrupt` |
| 5 High load or traffic spike | E6 `high-load` |
| 6 Monitoring and alert trigger | E8 `error-spike` (and the alert criteria of E2, E4, E11) |
| 7 Unauthorized or invalid operation | E9 `unauthorized-access`, E10 `abuse` |
| 8 Recovery/rollback/failover verification | E2 `db-failure` (failover and rejoin), E11 `data-loss` (restore), E12 `soak` |

For every scenario: the injected fault, the hypothesis for each configuration (written before the
runs), and the acceptance criteria. The criteria are applied unchanged to both configurations
(`experiments/scenarios.ts`, `experiments/acceptance.ts`).

### E1 `app-crash` — a student replica kills its own process
- **Baseline:** the replica stays down until the repair; roughly half of the student reads fail for 25 s.
- **Final:** the health check and the retry on the other replica mask the crash; the restart policy brings the replica back. No client-visible failure.
- **Criteria:** availability ≥ 99.9 %; no duplicate charge; no lost record.

### E2 `db-failure` — the database node that accepts writes is stopped
- **Baseline:** every request that needs the database fails, and hangs for up to the client timeout, until the repair.
- **Final:** reads continue from the standby. After three failed probes (about 3 s) the controller promotes the standby; payments succeed again within 10 s of the fault, with the old primary still down. No acknowledged payment is lost, because replication is synchronous. At the repair the old primary rejoins as a standby by itself.
- **Criteria:** `DatabaseDown` fires ≤ 10 s; read availability ≥ 99 %; payment path recovers ≤ 10 s after the injection; no duplicate charge; no lost record; ledger balanced; a standby is streaming at the end.
- **Expected not to hold in final:** overall availability stays below SLO-1's 99.5 % in this run, because about 5 s of payments fail in a 70 s window. The scenario therefore has no overall-availability criterion; the cost is reported.

### E3 `net-timeout` — one student replica answers after 3 s
- **Baseline:** half of the student reads take 3 s; throughput collapses because the workers wait.
- **Final:** the 0.8 s attempt timeout and the retry bound the latency; after three timeouts the replica is ejected and latency returns to normal.
- **Criteria:** throughput during the fault ≥ 0.7 × before; p95 ≤ 1 s.

### E4 `node-failure` — student-1 and payment-1 are killed together
- **Baseline:** half of the student reads and half of the payments fail until the repair.
- **Final:** the surviving replicas carry the load; no client-visible failure.
- **Criteria:** `InstanceDown` fires ≤ 10 s; availability ≥ 99.9 %; no duplicate charge.

### E5 `txn-interrupt` — the payment service crashes between checkpoint and charge
- **Baseline:** payments are left `pending` forever; clients that retry are charged under a new record.
- **Final:** the idempotency key makes the retry safe and the sweep rolls stale checkpoints back; nothing stays pending and the ledger balances.
- **Criteria:** no duplicate charge; no lost record; no payment left pending; ledger balanced.

### E6 `high-load` — 10 workers become 110
- **Both:** the system absorbs the load; the final configuration is somewhat slower per request (authentication, validation, audit).
- **Criteria:** error rate ≤ 1 %; p95 ≤ 1 s; no legitimate request rate-limited; CPU and memory recorded.

### E7 `gateway-failure` — gateway-1 is killed
- **Baseline:** nginx has only gateway-1: total outage until the repair.
- **Final:** nginx fails over to gateway-2 within its 1 s connect timeout; a few in-flight requests may fail.
- **Criteria:** availability ≥ 99.5 %; no duplicate charge; no lost record.

### E8 `error-spike` — both student and both payment replicas fail every request
- **Both:** `HighErrorRate` fires within 15 s and resolves within 30 s of the repair; no unrelated alert fires. (A monitoring experiment: the fault is not meant to be masked.)
- **Criteria:** `HighErrorRate` fires ≤ 15 s; resolves ≤ 30 s after the repair; alert set correct.

### E9 `unauthorized-access` — forged, expired and `alg:none` tokens, privilege escalation
- **Baseline:** there is no authentication: every attack succeeds and attacker payments reach the database.
- **Final:** every attempt is denied (401/403) and audited; `AuthFailureSpike` fires; the legitimate workload is unaffected.
- **Criteria:** all attacks denied; no attacker payment in the database; no `evil-` student created; at least one audit deny per attempt; ledger balanced; availability ≥ 99.9 %.

### E10 `abuse` — malformed input, a 1 000-request burst, a login brute force
- **Baseline:** no validation and no limits: some malformed bodies are accepted or cause a 5xx; the burst is served.
- **Final:** malformed input gets 4xx, never 5xx; the burst gets 429 with `Retry-After` after the quota; the brute force gets 429 after five attempts; no instance goes down.
- **Criteria:** no 5xx from malformed input; burst limited; brute force limited; instances stay up; ledger balanced; availability ≥ 99.9 %.

### E11 `data-loss` — the payment records are destroyed (new)
`TRUNCATE payments; UPDATE students SET balance = 0` as the superuser, 40 s into the run: an
operator error, a bad migration or a compromised administrator. Replication copies the damage to
the standby at once. At 55 s the operator restores the newest backup taken before the damage
(`npm run db:restore -- --before <time>`).
- **Baseline:** there is no backup: every payment acknowledged before the damage is gone (a loss window of the full 40 s).
- **Final:** `PaymentRecordsLost` fires within 20 s. The restore verifies the checksum, restores into a scratch database, checks the ledger there and merges the missing payments back while the system keeps serving. Only payments acknowledged after the last backup are missing: a loss window ≤ 20 s.
- **Criteria:** `PaymentRecordsLost` fires ≤ 20 s; the restore succeeds; loss window ≤ 20 s; ledger balanced; no key charged twice in the database; availability ≥ 99.9 %.

### E12 `soak` — nine component faults in ten minutes (new)
One fault a minute, each repaired by the operator 25 s later: application crash, node kill, database
primary stop (twice), gateway kill, slow replica, a second application crash, a two-container node
kill, and a payment crash mid-transaction. The fault rate is a parameter of the experiment, chosen
to be far above any real rate so that enough faults fit into one run.
- **Baseline:** most faults become client-visible failures that last until the repair; availability well below SLO-1.
- **Final:** only the two database failovers are visible, for a few seconds each; availability ≥ 99.5 %; no payment lost or duplicated across nine faults.
- **Criteria:** availability ≥ 99.5 %; payment availability ≥ 98 %; at most 30 seconds with < 99 % success; no duplicate charge; no lost record; ledger balanced; a standby streaming at the end.
- **Used for:** the system-level MTTF, MTBF, MTTR, availability and failure-rate calculations (`reports/final/RELIABILITY.md`).

### E13 `standby-failure` — the database standby is stopped (new)
Added after the campaign had started, when the failure analysis (REPORT.md §4.3, row F7) made a
claim about this case that no scenario measured. Its hypothesis was written before its first run.
- **Baseline:** nothing depends on the standby: no client-visible effect.
- **Final:** replication is synchronous, so commits wait for the standby that is gone until the controller switches to asynchronous replication after two probes. Payments stall for about 2 to 4 s; some time out at the gateway. No payment is lost or duplicated. This is the price of losing no acknowledged write in a failover, and **the final configuration is expected to do worse than the baseline here**, possibly missing the 99.5 % criterion.
- **Criteria:** `DatabaseDown` fires ≤ 10 s; availability ≥ 99.5 %; payment path recovers ≤ 10 s; no duplicate charge; no lost record; ledger balanced; a standby streaming at the end.

## 5. What is recorded per run

`reports/final/runs/<scenario>__<mode>__r<N>/metrics.json` (computed) and
`logs/final/<scenario>__<mode>__r<N>/` (raw, gzip): the per-request workload log, the event log of
every service for the window, the alert observations, and CPU/memory samples.

| Assignment §5 item | Field |
|---|---|
| injected fault, start and end | `scenario`, `injectTs`, `repairTs`, `t0`, `t1`; `verify.faults` for the soak |
| detection time | `metrics.response.detectionMs` (first evidence in the logs), `metrics.alerts[].detectionMs` (alert firing) |
| recovery time | `metrics.response.recoveryMs`, `metrics.writePath.recoveryMs`, `metrics.reliability.mttrMs` |
| successful and failed requests | `metrics.requests`, `metrics.availability` |
| latency | `metrics.response.avgMs/p50Ms/p95Ms/p99Ms` |
| data-integrity result | `consistency` (lost, duplicate, pending, ledger), `verify.dataLoss` |
| recovery actions | `metrics.mechanisms` (retries, breaker openings, degraded reads, duplicates suppressed, rollbacks, promotions) |

## 6. Test levels

| Level | What | Command |
|---|---|---|
| Unit (Python) | every mechanism and control in isolation, no containers | `python3 -m pytest -q tests/unit` |
| Unit (harness) | metric, reliability, acceptance and aggregation code | `npm run test:harness` |
| Alert rules | every rule fires on a crossing series and not just under it | `npm run test:alerts` |
| Integration | the running final stack end to end, including a real failover and a restore | `npm run up:final && npm run test:integration` |
| System experiments | E1–E13, three repetitions, two configurations | `npm run campaign -- --reps 3` |

## 7. Known limitations of the method (stated before the results)

- One host: a host failure is common-mode and is not tested; CPU contention between containers affects latency.
- Three repetitions show the spread but give no confidence intervals.
- The workload is closed-loop: a hanging system receives less load, which flatters the baseline in request-based availability. Time-based figures (failed seconds) are reported next to it.
- `docker compose stop` gives PostgreSQL a clean shutdown. A power loss was not tested.
- The backup interval (15 s) is scaled down to fit a 90 s experiment; a real deployment would pair a longer interval with WAL archiving.
- Alert timing is polled once per second on top of a 2 s scrape and a 2 s rule evaluation: ± 2 s.
