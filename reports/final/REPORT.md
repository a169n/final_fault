# Resilient University Information System — Final Technical Report

Course: Fault Tolerance and Dependable Computing — Final Project (Integrated Dependability
Engineering Capstone), Option A: continuation of the university information system of the midterm
and endterm projects.

Author: Aibyn Talgatov, CSE-2505M (`a169n`). Contribution: appendix A.6.

Repository: <https://github.com/a169n/final_fault>

**How to read the numbers.** Every measured value in this report is computed by a script from the
raw logs of the campaign and can be traced to [`RESULTS.md`](RESULTS.md),
[`RELIABILITY.md`](RELIABILITY.md) or a run's `metrics.json`. A value that is a design parameter, an
assumption or a model output is labelled as such where it appears. Nothing was measured by hand and
no completed run was removed from the results except the one named in
[`EXPERIMENT-LOG.md`](EXPERIMENT-LOG.md).

---

## 1. Abstract

This project designs, implements and evaluates a dependable distributed system: a university
information system with seven services, a replicated PostgreSQL store and a payment workflow that
must execute exactly once. Objectives are stated as eight service-level objectives, the ways the
system can fail are analysed (18 failure modes, a fault tree, a STRIDE threat model), and the
objectives are tested by 13 fault-injection, load and security scenarios run against two
configurations of the same code: a baseline in which the redundant hardware exists but nothing
uses it, and the final configuration with twelve software and nine infrastructure mechanisms
switched on. The final project adds automatic database failover with fencing and synchronous
replication, verified backups with a merge restore, and reliability calculations taken from the
experiments.

In 39 controlled runs the final configuration passed every acceptance criterion of all 13
scenarios in all three repetitions; the baseline, in the 17 runs completed before the deadline,
passed one scenario of 13. With the database primary stopped, payments resumed 6.8 s after the
fault without an operator (baseline: only after the repair, 20.5 s) and no acknowledged payment was
lost in any of nine failovers. After a destructive statement the backup restore recovered 77 % of
the payments acknowledged before it (loss window 3.8 to 13.7 s; baseline: everything lost). In the
ten-minute soak with nine component faults, availability was 99.76 % against 85.30 %, and the
system-level MTTF under that fault load was 292 s against 22 s. The final configuration missed its
own 99.5 % availability objective in the run where the primary is stopped (98.81 %), the baseline
evidence is thinner than planned (one or two repetitions), and three integration tests fail; all
three are reported with their data.

**Keywords:** fault tolerance, dependability, availability, MTTF, MTTR, failover, fencing,
synchronous replication, backup and restore, circuit breaker, idempotency, fault injection,
observability, intrusion tolerance.

---

## 2. Introduction, motivation and system context

### 2.1 Motivation

A university's information system is ordinary software with unforgiving failure modes. If the
payment path is down during the registration week, students miss a deadline. If a payment is
charged twice, or acknowledged and then lost, the university owes somebody money and cannot say
whom. If anyone can post a payment or read a transcript, the records are worthless. None of this
requires an exotic fault: a process crashes, a database host reboots, a replica becomes slow, an
administrator runs the wrong statement.

The midterm project built such a system and made it survive crashes with software mechanisms. The
endterm added redundant gateways, observability and security. Both reports ended with the same
admission: the database primary was still a single point of failure for every write, and nothing
protected the data itself. The final project closes those two gaps and then does what the earlier
phases did not: it states measurable objectives first, models how the system fails, and tests
whether the objectives are met, with reliability figures computed from the experiments.

### 2.2 The system

The system serves four functions through one public HTTP API:

| Function | Operations | Data |
|---|---|---|
| Student records | read, list, create | `students` (id, name, credits, balance) |
| **Payments** (the critical workflow) | pay into a student's ledger, read a payment by key | `payments` (idempotency key, student, amount, state) and `students.balance` |
| Transcripts | read | `grades` |
| Timetables | start a long-running generation job, poll it | `timetable_jobs` (with checkpoints) |

Users are students (may read their own record and pay into their own ledger), staff (`bursar`: may
read and pay for any student) and an administrator. All data is synthetic: 200 generated students.

It is deployed as 19 containers on one Docker host
([`ARCHITECTURE.md`](ARCHITECTURE.md) §1): nginx, two gateways, an authentication service, two
replicas each of the student, payment and timetable services, one transcript service, two
PostgreSQL nodes, a database controller, a backup sidecar, and the monitoring plane. That is seven
independently deployable services, one persistent data store, and one critical workflow that
crosses five components (client → nginx → gateway → payment → database → standby), which meets the
scope the assignment asks for (§3).

### 2.3 What the final project adds

| Area | State after the endterm | Added in the final |
|---|---|---|
| Requirements | ten dependability requirements, tied to experiments | SLOs with numeric targets, critical functions, a fault/error/failure model and a failure-impact analysis (§3, §4) |
| Reliability engineering | MTTR per run, as a by-product | MTTF, MTBF, MTTR, availability and failure rate with stated formulas, units and windows; a soak experiment built for them; a series/parallel model (§5) |
| Database | primary + hot standby; reads fail over, writes do not | automatic promotion, fencing, synchronous replication, automatic rejoin (H8); services find the new writer themselves (S12) |
| Data protection | none beyond replication | verified backups every 15 s and a merge restore (H9) |
| Timeouts | the DB wait outlived the gateway's attempt | nested (S13) |
| Monitoring | 6 alert rules, one exporter | 11 alert rules, an exporter per node, controller metrics, three more dashboard panels |
| Experiments | 10 scenarios | 13: a failover-and-rejoin check, a data-loss-and-restore scenario, a ten-minute soak and a standby failure |
| Method | cut-off requests counted as failures; write-path outages invisible | cut-off requests excluded; payment-path availability, downtime and recovery measured separately |

### 2.4 Technology choices

| Choice | Why |
|---|---|
| Python 3.12 + FastAPI | small services whose fault-tolerance code is readable in one file each; async I/O makes timeouts and cancellation explicit |
| PostgreSQL 16 | transactions and a `UNIQUE` constraint carry the integrity guarantees; streaming replication, `pg_promote()` and per-parameter `ALTER SYSTEM` grants make a least-privilege failover controller possible |
| nginx | a well-understood entry point with upstream failover |
| Docker Compose | the whole system starts with one command on the instructor's machine; `docker compose stop/kill` is a precise fault injector. Kubernetes would hide the mechanisms this project is about (the mapping is discussed in the endterm report §3.7) |
| Prometheus + Grafana | pull-based metrics with testable alert rules (`promtool test rules`) |
| TypeScript harness on Node 22 | runs without a build step or dependencies (`--experimental-strip-types`); the metric code is unit-tested |

---

## 3. Requirements, assumptions and dependability objectives

### 3.1 Critical functions

| # | Function | Why it is critical | Consequence of failure |
|---|---|---|---|
| CF1 | Make a payment exactly once | money and a legal record | a lost payment (student paid, university has no record), a double charge, or an unusable service in a deadline week |
| CF2 | Keep payment records durable | the ledger is the system of record | permanent loss; no reconciliation possible |
| CF3 | Read student records and transcripts | most of the traffic; needed by every other workflow | students and staff cannot work, but no lasting damage |
| CF4 | Refuse unauthorized operations | integrity and confidentiality of the records | forged payments, exposed grades |
| CF5 | Detect and explain incidents | recovery depends on someone knowing | longer outages; silent data loss |

Timetable generation is not critical: a job that is delayed by a failure is resumed from its
checkpoint and completes later.

### 3.2 Service-level objectives

| ID | Objective | Target | Function |
|---|---|---|---|
| SLO-1 | Availability under a single component fault | ≥ 99.5 % of requests succeed over the experiment window (≥ 99.9 % where the fault should be fully masked) | CF1, CF3 |
| SLO-2 | Payment-path recovery without an operator | ≤ 10 s after a single component or database-node failure | CF1 |
| SLO-3 | Latency | p95 ≤ 1 s for successful requests, also at 11× load | CF1, CF3 |
| SLO-4 | Payment integrity | 0 duplicate charges, 0 acknowledged payments lost, ledger balanced, after any single component failure | CF1, CF2 |
| SLO-5 | Recovery from destroyed data | recovery point ≤ 20 s, restore ≤ 60 s once started | CF2 |
| SLO-6 | Detection | alert ≤ 10 s after an instance or database failure, ≤ 15 s after an error spike, ≤ 20 s after records are destroyed | CF5 |
| SLO-7 | Access control | 100 % of unauthorized requests denied and audited; malformed input never causes a 5xx | CF4 |
| SLO-8 | Redundancy restored | a standby streams again after the repair, with no manual rebuild | CF1, CF2 |

The targets are chosen for a system of this size on one host, not copied from a production
contract. 99.5 % over a 70 s window allows 0.35 s of total outage; over the ten-minute soak with
nine faults it allows 3 s. They are deliberately tight enough that the final configuration can miss
them, and §10 reports where it does.

The objectives are per experiment window, with a fault inside the window. They are not annual
figures: an annual availability would need a fault rate that this project cannot observe (§5.4).

### 3.3 Requirements table

| # | Requirement | SLO | Verified by |
|---|---|---|---|
| R1 | A crashed or killed service replica does not interrupt the service | SLO-1, SLO-4 | E1, E4, E12 |
| R2 | The gateway is not a single point of failure | SLO-1 | E7, E12 |
| R3 | A slow replica is detected and removed from rotation | SLO-1, SLO-3 | E3, E12 |
| R4 | With a database node down, reads continue and the outage is alerted | SLO-1, SLO-6 | E2 |
| R5 | **With the database primary down, payments resume without an operator** | SLO-2 | E2, E12 |
| R6 | **No acknowledged payment is lost in a failover** | SLO-4 | E2, E12 |
| R7 | **After the repair, database redundancy restores itself** | SLO-8 | E2, E12 |
| R8 | An interrupted payment leaves no duplicate, lost or pending record | SLO-4 | E5, E12 |
| R9 | At 11× load, errors ≤ 1 %, p95 ≤ 1 s, no legitimate request throttled | SLO-3 | E6 |
| R10 | **Destroyed payment records are detected and recovered from a backup** | SLO-5, SLO-6 | E11 |
| R11 | Each incident class raises its alert and no unrelated alert | SLO-6 | E2, E4, E8, E9, E10, E11 |
| R12 | Unauthorized and over-privileged requests are denied and audited | SLO-7 | E9 |
| R13 | Malformed input, floods and brute force are contained | SLO-7 | E10 |
| R14 | Every request is traceable by one request ID across all hops | – | unit and integration tests |

Bold: new in the final project.

### 3.4 Assumptions

1. **Fault classes.** Crash faults (a process or container stops), omission faults (a request or
   response is lost), timing faults (a component answers late), and one class of value fault
   introduced by a human: a destructive but syntactically valid privileged statement. Byzantine
   behaviour of a component (arbitrary wrong answers) is out of scope.
2. **Single fault at a time.** The mechanisms are designed for one failed component per redundancy
   group. Two database nodes down, or both replicas of a service down, is an outage by design.
3. **One host.** All containers share one machine and one Docker daemon. A host failure is
   common-mode and is not tolerated.
4. **Clean database stops.** The database fault is `docker compose stop`. Durability under a power
   loss rests on PostgreSQL's own WAL and was not tested.
5. **Trusted host and operator intent.** The host, the Docker daemon and the base images are
   trusted. The operator is not malicious but can make mistakes (E11).
6. **Clocks.** One host, one clock: timestamps from different containers are comparable.
7. **Synthetic data, local network.** No real personal data; the public listener is plain HTTP.
8. **Load.** 10 concurrent clients as the normal load, 110 as the peak.

---

## 4. Fault model, threat model and failure analysis

### 4.1 Terminology

The report uses the terms of Avižienis et al. [1]:

- A **fault** is the cause: a defect or an event, such as a killed container, a slow disk, a wrong
  SQL statement, a forged token.
- An **error** is the part of the system state that deviates because of an activated fault: a
  connection pool full of dead connections, a payment row left `pending`, a gateway routing to a
  replica that is gone.
- A **failure** is the deviation of the delivered service from the specified one, seen at the
  service interface: an HTTP 5xx, a response slower than the objective, a payment acknowledged and
  then missing, an unauthorized request that succeeds.

Fault tolerance is everything that stops an error from becoming a failure (masking), or that makes
the failure short and harmless (detection, recovery, safe failure). This distinction is what the
experiments measure: each scenario injects a **fault**; the event log shows the **errors** (failed
attempts, health transitions, rollbacks); the client log shows whether a **failure** occurred, for
how long, and whether data was damaged.

| Example | Fault | Error | Failure without tolerance | With tolerance |
|---|---|---|---|---|
| E1 | process exits | connections to student-1 refused | 5xx on half of the reads | masked: retry on student-2, replica restarted |
| E5 | crash between checkpoint and charge | payment row `pending`, balance unchanged | payment stuck forever; a client retry charges under a new record | row rolled back by the sweep; the retry returns the stored result |
| E2 | primary stops | no node accepts writes | payments fail until the operator acts | a failure of a few seconds, then masked by promotion |
| E11 | `TRUNCATE payments` | ledger empty on both nodes | all records lost | failure limited to the payments since the last backup |

### 4.2 Fault model

| Class | Fault | Injected by | Scenario |
|---|---|---|---|
| Crash | a service process exits | `POST /chaos/crash` (`os._exit`) | E1, E12 |
| Crash | containers killed (a "node") | `docker compose kill` | E4, E7, E12 |
| Crash | the database primary stops | `docker compose stop` | E2, E12 |
| Crash, mid-operation | the payment service dies between two steps of a payment | `crashAfterCheckpoint` | E5, E12 |
| Timing | a replica answers after 3 s | `latencyMs` | E3, E12 |
| Omission / value | replicas answer every request with a 5xx | `failRate` | E8 |
| Overload | 11× concurrency | workload ramp | E6 |
| Human, destructive | payment records truncated by a privileged statement | `psql` as the superuser | E11 |
| Malicious, external | forged or missing tokens, privilege escalation, malformed input, floods, brute force | attack sets | E9, E10 |

Not in the model, and therefore not claimed: host loss, network partitions between containers,
disk corruption below PostgreSQL's checksums, Byzantine services, a malicious operator.

### 4.3 Failure scenarios and impact analysis

A failure mode and effects analysis of the components. Severity: **S1** data loss or corruption,
**S2** critical function unavailable, **S3** degraded service, **S4** no user-visible effect.
"Effect" is what a client sees; the measured values are in §10.

| # | Component and failure mode | Effect in the baseline | Sev. | Detection | Tolerance in final | Effect in final | Sev. |
|---|---|---|---|---|---|---|---|
| F1 | service replica crashes | about half of that service's requests fail until an operator restarts it | S2 | `InstanceDown`; health probe | health check, retry on the other replica, restart policy | none | S4 |
| F2 | "node" dies (student-1 + payment-1) | half of reads and payments fail | S2 | `InstanceDown` | as F1 | none | S4 |
| F3 | replica slow (3 s) | half of the reads take 3 s; throughput collapses | S3 | `HighLatencyP95`; ejection metric | timeout, retry, outlier ejection | a few slow requests before the ejection | S4 |
| F4 | gateway dies | total outage (nginx has one upstream) | S2 | `InstanceDown` | nginx fails over to the second gateway | a few in-flight requests fail | S3 |
| F5 | payment service crashes mid-payment | payment stuck `pending`; retries create new records | **S1** | `PaymentsStuckPending` | idempotency key, checkpoint, rollback sweep | the request fails; the retry is safe | S3 |
| F6 | database primary stops | every database request fails or hangs | S2 | `DatabaseDown`, `DatabaseNoWriter` | reads from the standby; promotion; writer discovery; synchronous replication | payments fail for a few seconds | S3 |
| F7 | database standby stops | none (nothing uses it) | S4 | `DatabaseDown`, `DatabaseRedundancyLost` | synchronous replication switched off after 2 probes | writes pause for up to about 3 s | S3 |
| F8 | both database nodes down | total outage | S2 | `DatabaseNoWriter` | none (double fault) | total outage | S2 |
| F9 | payment records destroyed by a privileged statement | permanent loss of every payment | **S1** | `PaymentRecordsLost` | backups, merge restore | payments since the last backup lost (≤ 15 s) | S1, bounded |
| F10 | stale primary returns after a failover | – (no failover) | – | controller log, `db_node_fenced` | highest-timeline rule, fencing, rebuild as standby | none | S4 |
| F11 | controller down | none | S4 | `InstanceDown` | fail-safe: no failover happens | as endterm: writes wait for the operator if the primary then fails | S4 alone |
| F12 | backup sidecar down | none | S4 | `BackupStale` | restart policy | recovery point grows | S4 alone |
| F13 | nginx dies | total outage | S2 | none from inside (blackbox probe missing) | restart policy only | total outage until restarted | S2 |
| F14 | auth service down | – (no logins in baseline) | – | `InstanceDown` | tokens are verified locally by the gateways | no new logins; existing sessions work | S3 |
| F15 | transcript service down | transcript reads fail | S3 | `InstanceDown` | stale cache (HTTP 203) | recently read transcripts are served stale | S3 |
| F16 | forged or missing token | request accepted | **S1** | – | authentication, authorization, audit | denied, audited | S4 |
| F17 | malformed input, flood, brute force | accepted, or a 5xx | S3 | `AuthFailureSpike` | validation, rate limits | 4xx / 429 | S4 |
| F18 | Docker host down | total outage | S2 | external only | none | total outage | S2 |

Reading the table: the final configuration removes every S1 and S2 outcome of a single component
fault except three, which are the remaining single points of failure (F13 nginx, F18 the host) and
the bounded data loss of F9. These are the limits §11 discusses.

The fault tree for the top event "a payment cannot be made" is in
[`ARCHITECTURE.md`](ARCHITECTURE.md) §6. Its first-order cut sets in final are {host} and {nginx};
in the baseline every component on the path is one.

### 4.4 Threat model (summary)

The full model is [`THREAT-MODEL.md`](THREAT-MODEL.md): STRIDE applied to five trust boundaries
(client → nginx, nginx → gateways, gateways → services, services → database, host and operator),
with a control and a test for each threat and 21 accepted residual risks. The actors in scope are
anonymous clients, authenticated students exceeding their rights, a holder of a stolen student
token, faulty components, and an operator who makes a mistake. A malicious insider with root on the
host is out of scope.

| Boundary | Main threats | Main controls |
|---|---|---|
| client → nginx | missing, forged, expired or `alg:none` tokens; privilege escalation; malformed or oversized input; floods; brute-force logins; replayed payments; log injection | JWT verification, authorization matrix, validation, rate limits, required idempotency key, request-ID sanitisation |
| nginx → gateways | gateway as a single point of failure; double charge on a re-sent POST | two gateways; client-supplied idempotency key |
| gateways → services | a compromised container calling services directly; abuse of the chaos endpoints | service-side validation; chaos token |
| services → database | SQL injection; destructive SQL; lost or duplicate records; primary down | parameterised SQL; `app_rw` without DELETE, TRUNCATE or DDL; idempotency and checkpoints; failover |
| host and operator | leaked secrets; exposed internal ports; vulnerable dependencies; **destroyed records; unusable backups; abuse of the failover credentials** | generated secrets; loopback-only ports; `pip-audit`; **verified backups; least-privilege `failover` and `backup` roles** |

Bold: added by the final project (THREAT-MODEL.md §11). The security controls answer threats, the
fault-tolerance mechanisms answer faults, and the two meet in three places that the experiments
exercise: an attack must not reduce availability for legitimate users (E9, E10), a failover must
not open a security hole (the controller cannot read data), and a recovery procedure must not be
able to damage what it recovers (E11).

---

## 5. Reliability engineering calculations

The calculations are generated by `experiments/reliability.ts` from the raw per-request logs and
written to [`RELIABILITY.md`](RELIABILITY.md) and `reliability.csv`. The formulas are unit-tested.

### 5.1 Definitions, formulas and units

| Quantity | Definition | Unit |
|---|---|---|
| second | a 1 s bin of the observation window that holds at least one request | s |
| failed second | a second in which fewer than 99 % of the requests succeeded | s |
| failure | a maximal run of failed seconds (runs one good second apart are merged) | count |
| T | observation window: the seconds of all repetitions of a scenario, added up | s |
| downtime D | number of failed seconds | s |
| MTTR | D / failures | s |
| MTTF | (T − D) / failures | s |
| MTBF | T / failures = MTTF + MTTR | s |
| availability A | MTTF / (MTTF + MTTR) = 1 − D / T | % |
| failure rate λ | failures / (T − D) | 1/h |

With no failure in T, MTTF is censored (MTTF > T) and only a bound can be given: λ ≤ 3 / T at 95 %
confidence (rule of three [8]).

**The fault rate is not a property of the system.** Every run injects its fault on purpose. MTTF,
MTBF and λ below describe the system under the injected fault load, which is far harsher than
real operation. What transfers is the MTTR, the share of injected faults that become failures, and
the ratio between the configurations.

### 5.2 Worked example: the soak (E12), final configuration

Three runs of 600 s, nine injected faults each. Measured: T = 1 800 s, 267 757 requests, 637
failed, 6 failures (the two database failovers of each run), D = 46 failed seconds.

- MTTR = D / failures = 46 / 6 = **7.7 s**
- MTTF = (T − D) / failures = (1 800 − 46) / 6 = **292.3 s**
- MTBF = T / failures = 1 800 / 6 = **300.0 s** (= 292.3 + 7.7)
- A (time) = MTTF / (MTTF + MTTR) = 292.3 / 300.0 = **97.44 %**
- λ = failures / (T − D) = 6 / 1 754 s = **12.3 per hour**
- request failure ratio = 637 / 267 757 = 0.24 %, so A (request) = **99.76 %**

The two availability figures differ on purpose. A second counts as failed as soon as 1 % of its
requests fail, and during a failover only payments (20 % of the traffic) fail, so the time-based
figure is the strict one and the request-based figure is what users experienced on average.

### 5.3 Observed values, baseline against final

| Scenario | Config. | Runs | T (s) | Failures | D (s) | MTTR (s) | MTTF (s) | MTBF (s) | A (time) | λ (1/h) |
|---|---|---|---|---|---|---|---|---|---|---|
| E12 soak | baseline | 1 | 524 | 13 | 240 | 18.5 | 21.8 | 40.3 | 54.20 % | 164.8 |
| E12 soak | final | 3 | 1 800 | 6 | 46 | 7.7 | 292.3 | 300.0 | 97.44 % | 12.3 |
| E1 app-crash | baseline | 2 | 133 | 2 | 47 | 23.5 | 43.0 | 66.5 | 64.66 % | 83.7 |
| E1 app-crash | final | 3 | 210 | 0 | 0 | – | > 210 | > 210 | 100 % | 0 observed (≤ 51.4) |
| E4 node-failure | baseline | 2 | 129 | 4 | 71 | 17.8 | 14.5 | 32.3 | 44.96 % | 248.3 |
| E4 node-failure | final | 3 | 210 | 0 | 0 | – | > 210 | > 210 | 100 % | 0 observed (≤ 51.4) |
| E7 gateway-failure | baseline | 1 | 61 | 2 | 20 | 10.0 | 20.5 | 30.5 | 67.21 % | 175.6 |
| E7 gateway-failure | final | 3 | 210 | 0 | 0 | – | > 210 | > 210 | 100 % | 0 observed (≤ 51.4) |
| E2 db-failure | baseline | 2 | 90 | 5 | 5 | 1.0 | 17.0 | 18.0 | 94.44 % | 211.8 |
| E2 db-failure | final | 3 | 210 | 3 | 25 | 8.3 | 61.7 | 70.0 | 88.10 % | 58.4 |
| E5 txn-interrupt | baseline | 1 | 69 | 1 | 27 | 27.0 | 42.0 | 69.0 | 60.87 % | 85.7 |
| E5 txn-interrupt | final | 3 | 210 | 3 | 19 | 6.3 | 63.7 | 70.0 | 90.95 % | 56.5 |

Interpretation:

- **Fault coverage.** In the soak, 6 of 27 injected faults became failures in final (coverage
  77.8 %); in the baseline 8 of 9 did (coverage 11.1 %). The six are the database failovers; the
  other seven fault types were masked in every run.
- **MTTR.** Where a failure still occurs in final it lasts 6 to 8 s, set by the mechanisms
  (three probes, the promotion, the 5 s circuit-breaker cool-down). In the baseline it lasts until
  the operator acts: 18 to 27 s here, because the experiment's operator reacts after 25 s.
- **The baseline's E2 row is misleading and is kept for that reason.** T is 90 s for two 70 s runs
  and D is 5 s: with the database down the baseline's clients hang for their full 10 s timeout, so
  most seconds hold no completed request and are not counted at all. The baseline served 1.4 to
  1.8 successful requests per second during the fault; final served 125 to 133. A closed-loop
  workload flatters a system that hangs [5]; §10.4 returns to this.
- **Zero observed failures is not zero failure rate.** For the fully masked scenarios the honest
  statement is the bound: at most 51 failures per hour of such fault load, at 95 % confidence.

### 5.4 Series/parallel model (illustrative inputs)

This subsection is a model, not a measurement. It asks what the redundancy structure is worth if
every component failed independently with the same, **explicitly illustrative** MTTF of 30 days,
using the measured restore times as MTTR.

- Component availability: A_c = MTTF / (MTTF + MTTR). Baseline: 2 592 000 / (2 592 000 + 18.5) =
  0.9999929. Final: 2 592 000 / (2 592 000 + 7.7) = 0.9999970.
- Series: A = Π A_i. Parallel: A = 1 − Π (1 − A_i).

| Configuration | Structure | A (model) | Downtime per year (model) |
|---|---|---|---|
| baseline | series of 8: nginx, gateway, student ×2, payment ×2, transcript, database | 99.99430 % | 29.9 min |
| final | nginx · (gateway ∥ gateway) · (student ∥ student) · (payment ∥ payment) · (db ∥ db) · transcript | 99.99941 % | 3.1 min |

In the final structure almost all of the modelled downtime comes from the two components that
remain single, nginx and the transcript service: the model says where the next improvement is,
which is its only use. Its assumptions do not hold in this deployment (one host is a common-mode
failure; a parallel pair is not perfect, as §5.3 shows), so its absolute numbers must not be read
as a prediction.

---

## 6. System architecture and resilience design

The diagrams are in [`ARCHITECTURE.md`](ARCHITECTURE.md): deployment and data flows (§1), service
boundaries (§2), the payment sequence (§3), the redundancy table (§4), the failover state machine
(§5), the fault tree (§6).

### 6.1 Design principles

1. **Redundancy is only worth what uses it.** The baseline has the same replicas and the same
   standby as the final configuration. They change nothing until a health check, a retry or a
   controller routes around a failure. This is why the comparison holds the topology constant.
2. **Fail fast, then retry elsewhere.** Every wait is bounded and the bounds are nested: database
   wait 0.5 s < gateway attempt 0.8 s < three attempts ≈ 2.5 s < nginx read timeout 5 s < client
   timeout 10 s. An inner layer always answers before the outer one gives up, so each layer sees
   the real cause.
3. **Make retries safe before making them automatic.** A payment can be re-sent by the client, by
   nginx or by the gateway only because the idempotency key and a `UNIQUE` constraint make the
   second attempt a no-op.
4. **Prefer losing availability to losing data.** A standby that might be behind is not promoted.
   Replication is synchronous while there is a standby. A backup that fails a check is not merged.
5. **Recovery restores redundancy, not only service.** A crashed replica is restarted; a failed
   primary comes back as a standby without anyone rebuilding it.
6. **Observe every mode the same way.** Monitoring, logs and alert rules are identical in the
   baseline and in the final configuration, so the instruments are not part of the experiment.

### 6.2 Redundancy, replication and backup strategy

| Asset | Strategy | Parameters |
|---|---|---|
| Stateless services | active-active replicas behind a health-checked, retrying load balancer | 2 replicas; health probe every 1 s |
| Gateway | active-active behind nginx | 2; `proxy_next_upstream` on error or timeout, 1 s connect timeout |
| Database, against node failure | primary + hot standby, streaming replication, **synchronous while the standby streams**; automatic promotion | probe every 1 s; promotion after 3 failed probes; RPO 0 for acknowledged writes |
| Database, against data destruction | **logical backups** by a read-only role, verified, with checksums | every 15 s; 20 kept (5 minutes); RPO ≤ one interval |
| In-flight payments | checkpoint row before the charge; rollback sweep | stale after 15 s |
| Long jobs | progress checkpoints with a lease; another replica adopts the job | per timetable row |
| Read data during a database outage | standby reads; stale cache at the gateway | cache ≤ 60 s old, ≤ 10 000 paths |

The two database strategies answer different faults and neither replaces the other. Replication
has a recovery point of zero for a dead node and is useless against a wrong statement, which it
copies in milliseconds. A backup survives the wrong statement and loses whatever came after it.
E2 and E11 measure one each.

The backup interval of 15 s is a scaled-down parameter: it has to be shorter than an experiment. A
deployment would run base backups hourly or daily and archive the WAL continuously, which gives
recovery to any second; that is future work (§11.3).

### 6.3 Single points of failure

| Component | In the baseline | In final | Why it remains |
|---|---|---|---|
| each service replica | yes (for its share of requests) | no | |
| gateway | yes | no | |
| database primary, for reads | yes | no | |
| database primary, for writes | yes | **no** (was yes until the endterm) | |
| payment data against destruction | yes | **bounded** (≤ 15 s) | |
| nginx | yes | yes | one public port on one host; a second nginx needs a virtual IP |
| auth service | – | partly (no new logins) | tokens are verified locally, so existing sessions survive |
| transcript service | yes | degraded (stale reads) | kept single as the degradation example |
| database controller | – | fail-safe | its failure removes automatic failover and causes no outage |
| Docker host | yes | yes | course deployment |

### 6.4 Deployment, restart and dependency-failure behaviour

- **Deployment.** `npm run up:<mode>` writes `.env` (mode switches and generated secrets) and runs
  `docker compose up -d --build`. Services wait for the database to be healthy; nginx waits for
  both gateways.
- **Restart behaviour.** In final every application container has `restart: unless-stopped`: a
  process that exits is restarted by Docker within about a second. A container stopped or killed
  with `docker compose stop/kill` is not restarted, which is how the experiments simulate a node
  that is really gone.
- **Liveness and readiness.** `/health/live` never touches a dependency (Docker's healthcheck uses
  it, so a database outage does not restart healthy services). `/health/ready` includes the
  database (the gateway's health check uses it, so a service that cannot reach the database leaves
  the rotation).
- **Dependency failure.**

  | Dependency down | Behaviour of the dependent |
  |---|---|
  | a service replica | the gateway retries on the other replica, marks it down within 1 s, ejects it after 3 failed attempts |
  | every replica of a service | circuit breaker opens after 5 failures: requests fail in milliseconds for 5 s instead of queueing; reads are served from the stale cache with HTTP 203 |
  | database writer | services answer 503 within 0.5 s; reads move to the other node; after the promotion the services find the new writer within 0.5 s |
  | auth | the gateways keep verifying tokens locally; `POST /auth/token` fails |
  | Prometheus, Grafana, controller, backup sidecar | no effect on requests |

- **Resource and load assumptions.** One host with 4 CPUs and 15 GiB of memory runs all 19
  containers and the load generator. No container has a CPU or memory limit. The normal load is 10
  closed-loop clients (about 150 requests per second), the peak 110. Rate limits are sized so that
  the legitimate peak is never throttled (staff 5 000/s, students 10/s per user). Database pools
  hold at most 10 connections per service.

---

## 7. Infrastructure and software fault-tolerance implementation

The complete list, with file, switch, test and experiment for each mechanism, is
[`app/fault_tolerance/README.md`](../../app/fault_tolerance/README.md). Mechanisms are numbered S
(software) and H (infrastructure) as in the earlier reports.

### 7.1 Infrastructure-level mechanisms

| # | Mechanism | Implementation | Demonstrated by |
|---|---|---|---|
| H1 | Service replicas and load balancing | `docker-compose.yml`; `infrastructure/load_balancer.py` | E1, E4 |
| H2 | Database replication, standby reads | `postgres-primary`, `postgres-replica`; `infrastructure/db_failover.py` | E2 |
| H3 | Self-healing restart | `restart: unless-stopped` | E1 |
| H4 | Storage checksums | `initdb --data-checksums` | configuration |
| H5 | Independent monitoring plane | Prometheus, Grafana, exporters | E8 |
| H6 | Redundant gateways behind nginx | `config/nginx/redundant.conf` | E7 |
| H7 | Liveness/readiness split | Docker healthchecks, `/health/live`, `/health/ready` | E2 (no restart storm) |
| **H8** | **Automatic database failover** | `app/services/db_controller.py`, `config/postgres/scripts/node.sh` | E2, E12 |
| **H9** | **Verified backups and merge restore** | `config/postgres/scripts/backup.sh`, `experiments/restore.ts` | E11 |

The assignment asks for at least two infrastructure-level mechanisms with a demonstration; H8 and
H9 are the two built for this project, and H1, H2, H3 and H6 are re-measured.

#### H8: automatic database failover

Four parts, each small:

1. **Symmetric nodes** (`node.sh`). Both database containers run the same start script, so
   "primary" and "replica" are names, not roles. On start, a node with an empty data directory
   clones its peer or, if it is the designated first primary and no peer is up, initialises the
   database. A node that was a primary and finds its peer is now a primary on a **higher
   timeline** knows it was failed over while it was down: it discards its data and clones the
   peer. This is the automatic rejoin.

2. **The controller** (`db_controller.py`). It probes both nodes every second with one query
   (role, fenced or not, timeline, number of streaming standbys, synchronous setting) and applies
   a policy that is a pure function, `decide`, unit-tested without a database:

   | Observation | Action |
   |---|---|
   | no writable node for 3 probes; a standby is reachable and was in sync | `pg_promote()` on the standby |
   | same, but the standby was **not** in sync | refuse, log, count (`db_failover_refused_total`) |
   | two writable nodes | make the one on the lower timeline read-only (fence) |
   | the writer has a streaming standby and replication is asynchronous | switch synchronous replication on |
   | the writer has had no standby for 2 probes and replication is synchronous | switch it off, so that writes do not hang |

   It connects as the role `failover`, which holds exactly the privileges for these actions:
   `EXECUTE` on `pg_promote` and `pg_reload_conf`, `ALTER SYSTEM` on two parameters, and
   `pg_monitor`. It cannot read or change a table.

3. **Writer discovery in the services** (S12, `core/db.py`). There is no virtual IP and no proxy
   in front of the database. Each service keeps a pool to each node, asks both for their role
   every 0.5 s and immediately after a failed write, and sends writes to the node chosen by
   `pick_writer`: not in recovery, not fenced, highest timeline. Because a promotion always starts
   a new timeline, a stale primary loses this comparison in every service independently. No
   coordination between services is needed and none can go wrong.

4. **Synchronous replication.** While a standby streams, a commit returns only after the standby
   has the WAL. So every payment a client saw acknowledged is on the node that gets promoted.
   The price is latency on every write and a pause of a few seconds when the standby dies (F7).

Three thresholds decide the behaviour, and each is a trade-off: 3 probes before a promotion (fewer
means a faster recovery and more needless failovers on a blip), 2 probes before giving up
synchronous replication (fewer means a shorter write pause when the standby dies and a larger
window in which a second failure loses data), 0.5 s between writer lookups.

#### H9: verified backups and merge restore

The sidecar (`backup.sh`) runs `pg_dump -Fc` every 15 s as the read-only role `backup`, checks that
the archive can be listed, writes its SHA-256 next to it, records it in `latest.json` and keeps the
newest 20. It dumps from the primary, or from the standby if there is no primary, so backups
continue through a failover.

The restore (`npm run db:restore`, `experiments/restore.ts`) is the part that matters, because a
backup is only as good as its restore:

1. choose the newest backup, or the newest from **before a given time** (`--before`);
2. check the SHA-256;
3. restore into a scratch database, which proves the archive is usable;
4. check the ledger invariant inside the scratch database; an unbalanced backup is not used;
5. **merge**: insert the payments whose idempotency key is missing from the live table, re-create
   missing students, recompute every balance from the completed payments. This runs in one
   transaction under a table lock, so no payment commits half-way through it. It never updates or
   deletes a payment, so payments made after the backup are kept;
6. drop the scratch database.

The system keeps serving requests during the restore; payments wait for the lock for the
milliseconds the merge takes.

### 7.2 Software-level mechanisms

| # | Mechanism | Parameters | Code | Unit test | Experiment |
|---|---|---|---|---|---|
| S1 | Bounded retry with exponential backoff and jitter | 3 attempts; 50 ms × 2ⁿ × random; never on a 4xx | `software/retry.py` | `test_retry.py` | E1, E4 |
| S2 | Timeouts | 0.8 s per attempt | `software/timeouts.py` | `test_retry.py` | E3 |
| S3 | Circuit breaker | opens after 5 consecutive failures, half-open after 5 s | `software/circuit_breaker.py` | `test_circuit_breaker.py` | E2, E8 |
| S4 | Health checks | `/health/ready` every 1 s | `software/health_check.py` | `test_health.py` | E1, E4 |
| S5 | Idempotency and duplicate-request detection | client key, `UNIQUE` constraint; same key with another body → 409 | `software/idempotency.py` | `test_idempotency.py`, `test_gateway_idempotency.py` | E5, E7 |
| S6 | Checkpoint, rollback and recovery | `pending` row before the charge; sweep after 15 s | `software/checkpoint_rollback.py` | covered through `test_idempotency.py`; E5 | E5 |
| S7 | Graceful degradation | last good answer ≤ 60 s old, HTTP 203 | `software/degradation.py` | `test_degradation.py` | E2, E8 |
| S8 | Fail-fast writes | no writer → 503 at once | `software/timeouts.py` | – | E2 |
| S10 | Job checkpoint and lease adoption | per timetable row | `software/job_checkpoint.py` | – | demo `timetable` |
| S11 | Outlier ejection | 3 failed attempts → out for 10 s; at most half a pool | `software/outlier_ejection.py` | `test_outlier_ejection.py` | E3 |
| **S12** | **Writer discovery** | probe every 0.5 s and after a failed write | `infrastructure/db_failover.py`, `core/db.py` | `test_db_controller.py` | E2, E12 |
| **S13** | **Nested timeouts** | DB wait 0.5 s < attempt 0.8 s | `software/timeouts.py` | – | E2 |

(S9 is the service replication listed as H1.) The assignment asks for at least four software
mechanisms; twelve are implemented, each with a code reference and, except the constants, a test.

**How they combine on one request.** A read arrives at a gateway. The load balancer builds a ring
of the replicas that are healthy (S4) and not ejected (S11). The first attempt has 0.8 s (S2). If
it fails, the next attempt goes to the next replica after a jittered backoff (S1). Every outcome
feeds the breaker of that pool (S3) and the ejection counter of that replica (S11). If every
attempt fails and the request was a read, the last good answer is returned as 203 (S7). A payment
takes the same path with its idempotency key (S5) and can therefore be retried as safely as a
read; inside the payment service the checkpoint (S6) makes a crash at any point recoverable.

**Why the retries are bounded.** Three attempts with a 0.8 s timeout cost at most about 2.5 s. An
unbounded or longer retry would turn one slow replica into a queue of waiting requests in every
gateway; with the breaker open the cost of a dead pool is microseconds.

---

## 8. Monitoring, observability and security implementation

### 8.1 Structured logs and request correlation

Every service appends one JSON line per event to `logs/events.jsonl`, with a timestamp, the
service, the mode, a level, a `kind` and the request ID:

```json
{"ts":1794565063901,"svc":"gateway-1","mode":"final","rid":"db-failure-final-r1-…-3112","level":"error","kind":"attempt","target":"payments","ok":false,"attempts":1,"err":"upstream 503"}
{"ts":1794565066320,"svc":"db-controller","mode":"final","rid":null,"level":"warning","kind":"failover","target":"db","action":"promote","node":"postgres-replica","reason":"no writer for 3 probes"}
{"ts":1794565066973,"svc":"payment-2","mode":"final","rid":null,"level":"info","kind":"failover","target":"db","action":"writer_changed","to":"postgres-replica","timeline":2}
{"ts":1794565071002,"svc":"gateway-2","mode":"final","rid":"…","level":"warning","kind":"audit","action":"POST /api/payments","outcome":"deny","reason":"not_owner","sub":"s7","role":"student"}
```

The request ID (`x-request-id`) is accepted from the client if it is well-formed, generated
otherwise, forwarded on every hop including retries, written on every log line and returned in the
response. `grep '"rid": "<id>"' logs/events.jsonl` shows one request's path through nginx, a
gateway, the attempts and the service. A hostile ID (newlines, quotes) is replaced, so it cannot
forge log lines.

Event kinds: `request`, `route`, `attempt`, `upstream`, `health`, `breaker`, `ejection`,
`degraded`, `recovery` (retry succeeded, duplicate suppressed, checkpoint rolled back), `audit`,
`rejected`, `chaos`, and new in the final `failover` (promote, fence, sync on/off, promotion
refused, writer changed) and `db_node` (role changes of each database node).

### 8.2 Metrics

Every service exposes `/metrics`; Prometheus scrapes every 2 s. Label values come from bounded
sets (route templates, pool names, fixed reason strings), never from request data.

| Metric | Type | Meaning |
|---|---|---|
| `http_requests_total{svc,method,route,status}` | counter | requests, by route template and status |
| `http_request_duration_seconds{svc,route}` | histogram | latency |
| `upstream_attempts_total{pool,instance,outcome}` | counter | gateway attempts: ok, error, timeout, circuit_open |
| `instance_up{target}`, `circuit_breaker_open{name}`, `instance_ejected{target}` | gauges | the gateway's view of each replica and pool |
| `auth_denied_total{reason}`, `rate_limited_total{scope}` | counters | security denials |
| `payments_stale_pending` | gauge | payments pending for more than 15 s |
| **`payments_completed_rows`** | gauge | completed payments; a decrease means records were destroyed |
| **`db_writer_available`**, **`db_node_up{node}`**, **`db_node_writable{node}`**, **`db_node_fenced{node}`** | gauges | the controller's view of the database |
| **`db_standby_streaming`**, **`db_sync_replication`** | gauges | redundancy and durability state |
| **`db_failovers_total`**, **`db_failover_refused_total{reason}`** | counters | promotions and refusals |
| **`backup_last_success_timestamp_seconds`**, **`backup_last_size_bytes`** | gauges | the newest verified backup |
| `pg_up`, `pg_stat_replication_*` | exporter | per node |

Bold: added in the final. The assignment asks for at least three meaningful metrics.

### 8.3 Alert rules

Eleven rules, each with a threshold, a `for` duration, a severity and a response annotation;
documented in [`ALERTS.md`](ALERTS.md) and unit-tested with `promtool` (a series that crosses the
threshold fires; one just under it, or a blip, does not).

| Alert | Fires when | Severity |
|---|---|---|
| `InstanceDown` | a service or gateway misses scrapes for 4 s | warning |
| `DatabaseDown` | a database node is unreachable for 4 s | critical |
| `HighErrorRate` | more than 5 % of gateway responses are 5xx over 15 s, for 6 s | critical |
| `HighLatencyP95` | gateway p95 above 1 s over 15 s, for 6 s | warning |
| `AuthFailureSpike` | more than 2 denials per second over 30 s | warning |
| `PaymentsStuckPending` | a payment is pending 15 s after creation, for 10 s | critical |
| **`DatabaseNoWriter`** | no node accepts writes for 4 s | critical |
| **`DatabaseRedundancyLost`** | a primary without a streaming standby for 10 s | warning |
| **`DatabaseFailover`** | a promotion in the last minute | warning |
| **`BackupStale`** | no verified backup for 60 s | warning |
| **`PaymentRecordsLost`** | the number of completed payments decreased | critical |

Each scenario declares which alerts must fire and which may; any other alert that fires makes the
run's alert result "incorrect". This turns false positives into a measured quantity (§10.6).

### 8.4 Dashboard

Grafana dashboard `university` (provisioned from `config/grafana/`): request rate by status, 5xx
ratio and p95 latency with their alert thresholds, upstream attempts by instance and outcome,
instance health, outlier ejection, circuit breakers, security denials, stuck payments, database
nodes and who accepts writes, failovers and synchronous replication, backup age and completed
payments, alerts over time and alerts firing now. Snapshots of campaign runs are in
[`figures/`](figures/) (§10.7).

### 8.5 Security controls

The controls are those of the endterm, unchanged and re-tested, plus the least-privilege roles of
the two new components. The assignment asks for at least three controls and two tested misuse
scenarios.

| Control | Implementation | Tested by |
|---|---|---|
| Authentication | `auth` service: scrypt password hashes, constant-time compare; HS256 JWTs with `iss`, `aud`, `exp` (900 s); gateways verify locally and accept HS256 only | `test_tokens.py`, `test_passwords.py`; E9 |
| Authorization | role × route × method matrix in `security/policy.py`; a student reads and pays only for themself; any exception → deny (fail closed) | `test_policy.py`, `test_gateway_authz.py`; E9 |
| Input validation and request limits | closed pydantic models (unknown fields rejected), ranges and patterns → 422; body > 16 KiB → 413; all SQL parameterised | `test_validation.py`; E10 |
| Rate limiting | token buckets: logins 1/s burst 5 per IP; API per user by role → 429 with `Retry-After` | `test_rate_limit.py`; E10, E6 |
| Audit logging | one `audit` line per deny, per payment and per admin action, with request ID, subject and reason; never a secret | `test_audit.py`; E9 |
| Duplicate-request protection | required idempotency key; `UNIQUE` constraint; 409 for a key re-used with another body | `test_idempotency.py`; E5, E7 |
| Secrets handling | every secret generated per install into a git-ignored `.env`; compose refuses to start without them | `env.test.ts` |
| Least privilege in the database | `app_rw`: no DELETE, TRUNCATE or DDL; `repl`: replication only; `monitor`: statistics only; **`failover`: promote, fence, sync, no table access; `backup`: read-only**; `scram-sha-256` everywhere; only nginx is published beyond the host | `test_stack.py`, **`test_stack_failover.py`** |
| Chaos-endpoint lockdown | `/chaos*` needs a token; nginx answers 404 for `/chaos*` and `/metrics` | `test_chaos_guard.py` |
| Dependency audit | `pip-audit` in CI | CI job `deps` |

**Intrusion tolerance.** The aim is to keep an attack contained, visible and recoverable, not only
to block it: verification failures deny; a stolen token lives 15 minutes, carries one role and is
rate-limited; services validate their own input even if the gateway is bypassed; the application
role cannot delete; the idempotency constraint makes a double charge impossible at the storage
layer; every denial is counted and audited and a burst raises `AuthFailureSpike`; the legitimate
workload's availability is measured while the attack runs (E9, E10); and, new in the final, records
destroyed by a privileged actor are detected and can be restored (E11).

---

## 9. Verification, validation and experimental methodology

The plan is [`TEST-PLAN.md`](TEST-PLAN.md); this section summarises it.

### 9.1 Test levels

| Level | Count | What it shows | Command |
|---|---|---|---|
| Unit, Python | 424 tests | each mechanism and control in isolation | `python3 -m pytest -q tests/unit` |
| Unit, harness | 104 tests | the metric, reliability, acceptance and aggregation code is right | `npm run test:harness` |
| Alert rules | 11 rules, 32 cases | each rule fires when it should and not otherwise | `npm run test:alerts` |
| Integration | 22 (19 pass, 3 fail: §10.4) tests | the running stack end to end, including a real failover and a restore | `npm run test:integration` |
| System experiments | 13 scenarios × 3 repetitions (final), 17 runs (baseline) | whether the objectives are met | `npm run campaign -- --reps 3` |

The harness is tested because the results depend on it: a wrong percentile or a wrong outage
boundary would be a wrong result. The reliability formulas of §5 have their own tests
(`experiments/reliability.test.ts`).

### 9.2 Environment

| | |
|---|---|
| Host | one virtual machine: 4 vCPU (Intel Xeon, 2.1 GHz), 15 GiB memory, Linux 6.18 |
| Software | Docker 29.9, Compose 5.6, Node.js 22.23, PostgreSQL 16, Python 3.12 (in the image) |
| Deployment | 19 containers on one bridge network; the load generator runs on the same host |
| Isolation | a controlled environment used only for this project; synthetic data; all attacks target `localhost` |

The load generator shares the CPUs with the system. Absolute latencies and throughput are specific
to this host; the comparison between configurations is what transfers.

### 9.3 Baseline and improved configuration

Defined in TEST-PLAN.md §2. In one sentence: the baseline is the same image, topology, workload and
monitoring with every fault-tolerance and security switch off; the final configuration turns them
all on. Exactly these differ: the gateway's resilience logic, the payment service's idempotency
and checkpointing, standby reads, the restart policy, the nginx upstream list, the database
controller's actions, the backup sidecar, the database wait, and the security controls.

The baseline is not a straw man built to fail. It is what the system is without the mechanisms,
with its redundant hardware in place and running. Where the baseline does as well as the final
configuration, the report says so.

### 9.4 Procedure of one run

1. **Known-state restore:** start every container, reset every chaos switch, truncate the payments
   and zero the balances, wait until every instance is healthy, a standby is streaming and no
   alert is firing.
2. **Workload** for the scenario's duration; the alert state is polled every second and CPU and
   memory are sampled.
3. **Inject** the fault at its time; **repair** it at its time (the "operator").
4. **After the window:** read the ledger and one row per payment from the database; compare, key
   by key, with what the clients were told; run the scenario's own checks.
5. **Evaluate** the scenario's acceptance criteria on the result and store everything.

### 9.5 Hypotheses, workload, duration, success criteria

Each scenario's hypothesis for both configurations, its fault, its timing and its criteria are in
TEST-PLAN.md §4, fixed before the campaign. The criteria are the same for both configurations.

### 9.6 Repetitions and comparability

Three repetitions per scenario and configuration, in repetition-major order so that a slow drift
of the host does not fall on one scenario. Each configuration starts from fresh volumes. The same
host, the same image and the same harness commit are used throughout. Values are reported as mean
± sample standard deviation with the number of repetitions; three repetitions show the spread and
do not support significance tests, and differences are interpreted accordingly.

### 9.7 Measures

| Measure | Definition |
|---|---|
| Availability (request) | successful requests / requests. Successful: status < 400, including 203 (served stale) |
| Availability of reads, of payments | the same, per operation |
| Failed second | a second in which fewer than 99 % of the requests succeeded |
| Detection time | from the injection to the first evidence in the event log; and, separately, to the alert firing |
| Recovery time | from the injection to the first success after the outage; for the payment path on its own |
| MTTR, MTTF, MTBF, λ | §5.1 |
| Lost record | a payment acknowledged to a client (201, or 200 with state `completed`) that is not `completed` in the database |
| Duplicate charge | more than one completed row for a key, or more than one 201 for one client intent |
| Ledger balanced | Σ completed payment amounts = Σ student balances |
| Loss window (E11) | time between the oldest lost acknowledged payment and the destruction |
| Alert correctness | every must-fire alert fired and no alert outside must/may fired |

### 9.8 Measured, estimated, illustrative

- **Measured:** everything in §10 and in §5.2–5.3.
- **Design parameters** (chosen, not measured): timeouts, thresholds, intervals, the 25 s operator
  repair delay, the fault schedule of the soak.
- **Illustrative:** the component MTTF used by the model in §5.4, and everything derived from it.
- **Derived bounds:** the alert latencies in ALERTS.md are computed from the configuration; the
  measured ones are in §10.6.

---

## 10. Results and baseline-versus-improved comparison

All tables: [`RESULTS.md`](RESULTS.md) (generated). Values are means over the repetitions.

**Completeness.** The final configuration has 3 repetitions of all 13 scenarios (39 runs). The
baseline campaign was stopped by the submission deadline after 17 runs: every scenario once, and
E1 to E4 twice. Baseline values are therefore from one or two runs and carry no spread; `n` is
given in every table. The comparison with the intermediate endterm configuration that the test
plan announced was not run.

### 10.1 Acceptance: pass or fail per scenario

A scenario passes only if every criterion passes in every repetition. The criteria are identical
for both configurations.

| # | Scenario | Matrix row | baseline | final |
|---|---|---|---|---|
| E1 | app-crash | 1 | FAIL (0/2) | **PASS (3/3)** |
| E2 | db-failure | 2, 8 | FAIL (0/2) | **PASS (3/3)** |
| E3 | net-timeout | 3 | FAIL (0/2) | **PASS (3/3)** |
| E4 | node-failure | 1 | FAIL (0/2) | **PASS (3/3)** |
| E5 | txn-interrupt | 4 | FAIL (0/1) | **PASS (3/3)** |
| E6 | high-load | 5 | PASS (1/1) | **PASS (3/3)** |
| E7 | gateway-failure | 1 | FAIL (0/1) | **PASS (3/3)** |
| E8 | error-spike | 6 | FAIL (0/1) | **PASS (3/3)** |
| E9 | unauthorized-access | 7 | FAIL (0/1) | **PASS (3/3)** |
| E10 | abuse | 7 | FAIL (0/1) | **PASS (3/3)** |
| E11 | data-loss | 8 | FAIL (0/1) | **PASS (3/3)** |
| E12 | soak | 8 | FAIL (0/1) | **PASS (3/3)** |
| E13 | standby-failure | 2 | FAIL (0/1) | **PASS (3/3)** |
| | **Scenarios passed** | | **1 / 13** | **13 / 13** |

The baseline's E8 and E13 fail only on alert criteria affected by an artefact (§10.4, item 1);
on the scenario's own measures they behave like final.

### 10.2 Consolidated results

| Scenario | Availability (request) | | Payment availability | | p95 latency (ms) | | Duplicate charges, all runs | |
|---|---|---|---|---|---|---|---|---|
| | baseline | final | baseline | final | baseline | final | baseline | final |
| E1 app-crash | 92.04 % | **100 %** | 100 % | 100 % | 46 | 43 | 658 | **0** |
| E2 db-failure | 99.29 % † | 98.81 % | 99.33 % † | 94.81 % | 52 | 46 | 439 | **0** |
| E3 net-timeout | 100 % † | 100 % | 100 % | 100 % | 49 | 45 | 543 | **0** |
| E4 node-failure | 83.37 % | **100 %** | 83.10 % | **100 %** | 46 | 43 | 452 | **0** |
| E5 txn-interrupt | 92.37 % | 97.95 % | – | 91.19 % | 53 | 46 | 222 | **0** |
| E6 high-load | 100 % | 100 % | 100 % | 100 % | 677 | 680 | 463 | **0** |
| E7 gateway-failure | 61.69 % | **100 %** | 62.88 % | **100 %** | 50 | 45 | 217 | **0** |
| E8 error-spike | 69.12 % | 90.38 % | 62.34 % | 58.78 % | 47 | 40 | 271 | **0** |
| E9 unauthorized | 100 % | 100 % | 100 % | 100 % | 69 | 47 | 386 | **0** |
| E10 abuse | 100 % | 100 % | 100 % | 100 % | 55 | 48 | 403 | **0** |
| E11 data-loss | 100 % | 100 % | 100 % | 100 % | 48 | 47 | 497 | 1 ‡ |
| E12 soak | 85.30 % | **99.76 %** | 85.42 % | **98.96 %** | 52 | 47 | 2 076 | **0** |
| E13 standby-failure | 99.99 % | 100 % | 100 % | 100 % | 49 | 46 | 376 | **0** |

† flattered by the closed-loop workload: the baseline's clients hang instead of failing (§10.4).
‡ one client received two 201 answers for one payment whose record was destroyed between them;
the database holds one row for the key after the restore (0 duplicates in the database).

| Measure | baseline | final |
|---|---|---|
| E2: payments succeed again after the fault | 20.5 s (after the operator's repair; n = 1 measurable) | **6.8 s ± 0.6 s**, primary still down |
| E2: successful requests per second during the fault | 1.4 – 1.8 | **125 – 133** |
| E3: throughput during the fault, share of pre-fault | 7 % (10 of 145 req/s) | **91 %** (137 of 152 req/s) |
| E9: attacks denied, of 63 per run | 0; 41 attacker payments reached the database | **63 of 63**, 0 in the database |
| E11: payments acknowledged before the loss and missing after the repair | all (1 115 acknowledged) | 286, 383, 118 of about 1 140 (**77 % recovered**) |
| E11: loss window | 39.9 s (everything since the start) | **10.4 s, 13.7 s, 3.8 s** (objective ≤ 20 s) |
| E11: restore duration | no backup exists | **2.0 – 2.5 s** |
| E12: seconds with < 99 % success, of 600 | 240 | **14 – 16** |
| E12: lost / duplicate payments across nine faults | 0 / 2 076 | **0 / 0** |
| Acknowledged payments lost in a failover (9 failovers) | – | **0** |

Recovery actions counted in the final runs (means per run): E1: 7 failed attempts, all 7 retried
successfully. E3: 33 failed attempts, 33 retries succeeded, the slow replica ejected. E2: 1
promotion, 2 circuit-breaker openings, 18 failed attempts. E5: 2 checkpoints rolled back, 2 breaker
openings. Every run: about 400 duplicate payments suppressed by the idempotency key. E12: 2
promotions per run and the old primary rejoined as a standby twice per run without intervention.

### 10.3 Per scenario: observed against the hypothesis

- **E1, E4, E7 (instance failures).** Hypothesis confirmed. Final masked all three completely: no
  failed request in nine runs. The baseline lost 8 %, 17 % and 38 % of its requests.
- **E2 (database primary).** Confirmed. Reads stayed at 100 %. Payments were unavailable for
  5.6 s ± 0.6 s and resumed 6.8 s after the fault, inside the 10 s objective; no acknowledged
  payment was lost and the ledger balanced; the old primary rejoined as a standby in every run.
  As the plan predicted, the run's overall availability (98.81 %) is below SLO-1.
- **E3 (slow replica).** Confirmed: 91 % of throughput kept, against 7 % in the baseline.
- **E5 (interrupted payment).** Confirmed for integrity: nothing duplicated, lost or left
  pending. The baseline left 2 payments pending and charged 222 re-sends twice. Availability in
  final was 97.95 %: the fault takes down both payment replicas, so payments fail until they have
  restarted (5.9 s). The mechanism protects the data, not the availability, in this scenario.
- **E6 (load).** Confirmed, and no difference: both configurations served 110 clients with no
  error and a p95 of about 680 ms. The mechanisms cost nothing measurable here; they also buy
  nothing, and the baseline passes.
- **E8 (alerting).** `HighErrorRate` fired after 12.0 s in all three final runs and resolved in
  time.
- **E9, E10 (security).** Confirmed. Final denied 63 of 63 attacks in each run, wrote an audit
  line for each and stored no attacker payment; the legitimate workload stayed at 100 %. In the
  baseline every attack succeeded and 41 attacker payments reached the database.
- **E11 (data loss).** Confirmed. `PaymentRecordsLost` fired 5 to 6 s after the damage. The
  restore took about 2 s and brought back 77 % of the destroyed payments; what was missing had
  been acknowledged after the last backup. The system kept serving throughout (100 %).
- **E12 (soak).** Confirmed: 99.76 % against 85.30 %; only the database failovers were visible.
- **E13 (standby).** **Hypothesis refuted, in the system's favour.** The plan expected payments to
  stall for 2 to 4 s and the 99.5 % criterion to be at risk. Measured: no failed request in three
  runs. The controller switched synchronous replication off once per run, and the slowest
  successful request took 1.3 to 1.8 s: commits did wait, but for less than the retry budget, so
  clients saw a slow answer and not an error.

### 10.4 Anomalies, confounding factors and weak evidence

1. **`BackupStale` fired in every baseline run.** The rule is meant to be silent where backups are
   off. In the baseline it fired throughout, so every baseline run's alert set is "incorrect" and
   the harness waited its full two minutes for alerts to clear before each run. This is a defect
   in the monitoring configuration, found by the campaign and not fixed before the deadline. It
   does not touch any request, latency or integrity figure, but **baseline alert correctness
   cannot be compared with final**, and the baseline's failed alert criteria in E8 and E13 are
   this artefact.
2. **The baseline looks better than final in E2 (99.29 % against 98.81 %).** With the database
   down the baseline's requests hang for the client's 10 s timeout; ten closed-loop workers then
   send almost nothing, so few requests fail. Per second of the fault the baseline completed 1.4
   to 1.8 requests and final 125 to 133. Request-based availability alone would have reported the
   opposite of what happened.
3. **Baseline integrity is checked by count, not by key**, because the baseline does not store the
   client's key. Its "0 lost" is weaker evidence than the final configuration's key-by-key check.
4. **The first restore restored nothing.** A smoke run before the campaign restored the newest
   backup, which had been taken 11 s after the destruction and so contained it: 0 of 1 220
   payments came back. The restore now selects the newest backup from before a given time. A
   backup strategy that keeps too few generations, or an operator who restores "the latest", fails
   in exactly this way.
5. **One run was contaminated by the experimenter** and discarded
   ([`EXPERIMENT-LOG.md`](EXPERIMENT-LOG.md)).
6. **Three of 22 integration tests fail** against the final stack (`integration-final.txt`),
   among them the new failover test, which received a 503 on a payment it expected to succeed.
   The suite ran directly after the demonstration, which itself stops the database; the failures
   were not diagnosed before the deadline. The campaign's 39 runs, not this suite, are the
   evidence for the failover.
7. **Failover time is longer than its mechanism.** Promotion happens about 4 s after the fault;
   payments resume after 6.8 s. The difference is the payment pool's circuit breaker, which opened
   during the outage and stays open for 5 s. Two mechanisms that are each correct add up.

### 10.5 Objectives met

| SLO | Target | Final, measured | Met |
|---|---|---|---|
| SLO-1 availability under one fault | ≥ 99.5 % | 100 % in E1, E3, E4, E7, E13; 99.76 % in the soak; **98.81 % in E2, 97.95 % in E5** | partly |
| SLO-2 payment recovery | ≤ 10 s | 6.8 s (E2), 5.9 s (E5) | yes |
| SLO-3 latency | p95 ≤ 1 s | 40 – 48 ms; 680 ms at 11× load | yes |
| SLO-4 integrity | 0 lost, 0 duplicate | 0 lost, 0 duplicate in 36 runs with a component fault; ledger balanced in 39 of 39 | yes |
| SLO-5 destroyed data | window ≤ 20 s, restore ≤ 60 s | 3.8 – 13.7 s; 2.0 – 2.5 s | yes |
| SLO-6 detection | ≤ 10 / 15 / 20 s | DatabaseDown 6 – 8 s, InstanceDown 5 – 7 s, HighErrorRate 12 s, PaymentRecordsLost 5 – 6 s | yes |
| SLO-7 access control | 100 % denied and audited | 189 of 189 | yes |
| SLO-8 redundancy restored | standby streaming at the end | 12 of 12 runs with a database fault | yes |

SLO-1 is not met where a fault removes every instance that can serve a payment at once: the only
primary (E2) or both payment replicas (E5). In those cases the system offers a bounded outage of 6
to 7 s, not masking.

### 10.6 Alerts

In final, every must-fire alert fired in every run and no unexpected alert fired (39 of 39 runs
correct). Detection, from the injection to the alert firing: `DatabaseDown` 6.0 – 8.0 s,
`InstanceDown` 5.0 – 7.0 s, `HighErrorRate` 12.0 s, `AuthFailureSpike` 8.0 – 10.0 s,
`PaymentRecordsLost` 5.0 – 6.0 s. `DatabaseNoWriter` never fired in final: the promotion beat its
4 s `for`, which is the intended outcome. For the baseline see §10.4, item 1.

### 10.7 Trade-offs and costs

| Cost | Evidence |
|---|---|
| Complexity | a controller, a node script, a backup sidecar, two database roles; 19 containers against 16 |
| A failover that is longer than necessary | breaker cool-down adds about 2.5 s (§10.4, item 7) |
| Synchronous replication | slowest request 1.3 – 1.8 s when the standby died (E13); no error |
| Latency at peak | none measurable: p95 680 ms against 677 ms at 110 clients |
| Recovery point for destroyed data | up to one backup interval: 4 to 14 s of payments lost here |
| False-positive alerts | none in final; one always-firing rule in the baseline |

### 10.8 Figures

Dashboard snapshots of campaign runs are in [`figures/`](figures/): `db-failure__final__r1-full.png`
shows one failover end to end (the 5xx share peaking at 7.7 %, the writer moving from one node to
the other, the alerts in order); `soak__final__r1-full.png`, `data-loss__final__r1-full.png` and
`gateway-failure__final__r1-full.png` show the other new behaviours. A terminal transcript of the
live demonstration, with the per-second failover timeline, is `demo/demo-final.txt`.

---

## 11. Discussion, limitations and future work

### 11.1 Discussion

The measured gains sit exactly where a mechanism acts. Replica and gateway failures are masked
completely; a slow replica costs 9 % of throughput instead of 93 %; a client re-send is no longer
a second charge (the baseline charged 7 003 re-sends twice across its 17 runs); attacks turn from
silent successes into denied, audited and alerted events. The two additions of the final project
do what they were built for: the database primary stopped being a single point of failure for
payments, at the price of a 6 to 7 s outage instead of an indefinite one, and destroyed records
became recoverable up to the last backup.

Three results argue against a simple "more mechanisms, more dependable" reading. Under load the
baseline is as good as the improved system. When one fault removes all capacity for an operation,
fault tolerance bounds the outage and cannot hide it. And mechanisms interact: the circuit breaker
that protects the gateways during the outage is also what keeps payments failing for 2.5 s after
the database is back.

### 11.2 Limitations

- **Baseline evidence is thin:** one or two repetitions, and its alert results are unusable.
- **One host.** A host failure is common-mode and untested; latency figures are specific to it.
- **Three repetitions** show spread, not significance.
- **Closed-loop workload** understates the effect of hanging (§10.4, item 2).
- **Clean database stops only;** no power loss, no partition, no slow-but-alive primary.
- **One controller with one vantage point,** advisory fencing, backups on the same host and
  unencrypted (THREAT-MODEL.md R17 – R19).
- **Three integration tests fail,** undiagnosed.
- **nginx and the host remain single points of failure.**

### 11.3 Future work

In priority order: fix the `BackupStale` rule and complete the baseline campaign; diagnose the
failing integration tests; reset the payment breaker on a writer change, to bring the failover
close to 4 s; an open-loop load generator; WAL archiving for point-in-time recovery and off-host,
encrypted backups; a quorum-based failover manager; a second nginx behind a virtual IP; a second
host.

---

## 12. Conclusion

The final configuration met seven of its eight service-level objectives and passed all 13
scenarios in every repetition; the baseline, on the evidence collected, passed one. The objective
it missed, 99.5 % availability under any single fault, is missed in the two scenarios where one
fault removes all capacity for payments; there the system delivers a bounded outage of 6 to 7 s
and loses no data. Across nine automatic failovers no acknowledged payment was lost, and after a
destructive statement three quarters of the records were back within seconds. The weak points —
thin baseline evidence, an alert rule that misfires in the baseline, three failing integration
tests, two remaining single points of failure — are reported with the data that shows them.

---

## 13. References

1. A. Avižienis, J.-C. Laprie, B. Randell, C. Landwehr, "Basic Concepts and Taxonomy of Dependable
   and Secure Computing", *IEEE Transactions on Dependable and Secure Computing*, 1(1), 2004.
2. M. T. Nygard, *Release It!*, 2nd ed., Pragmatic Bookshelf, 2018 (timeouts, circuit breakers,
   bulkheads).
3. B. Beyer, C. Jones, J. Petoff, N. R. Murphy (eds.), *Site Reliability Engineering*, O'Reilly,
   2016 (service-level objectives, monitoring, alerting).
4. A. Shostack, *Threat Modeling: Designing for Security*, Wiley, 2014 (STRIDE).
5. B. Schroeder, A. Wierman, M. Harchol-Balter, "Open Versus Closed: A Cautionary Tale", USENIX
   NSDI, 2006 (the bias of closed-loop load generators).
6. M. Kleppmann, *Designing Data-Intensive Applications*, O'Reilly, 2017 (replication, failover,
   split brain, fencing).
7. K. S. Trivedi, *Probability and Statistics with Reliability, Queuing, and Computer Science
   Applications*, 2nd ed., Wiley, 2002 (MTTF, availability, series and parallel systems).
8. B. D. Jovanovic, P. S. Levy, "A Look at the Rule of Three", *The American Statistician*, 51(2),
   1997 (upper bound on a rate after zero observed events).
9. PostgreSQL 16 documentation: streaming replication, synchronous replication, `pg_promote`,
   timelines, `pg_basebackup`, `pg_dump`/`pg_restore`, predefined roles, `GRANT ... ON PARAMETER`.
10. nginx documentation: `ngx_http_upstream_module`, `proxy_next_upstream`.
11. Prometheus documentation: alerting rules, `promtool test rules`. Grafana documentation:
    provisioning.
12. RFC 7519 (JSON Web Token), RFC 8725 (JWT Best Current Practices), RFC 7914 (scrypt).
13. OWASP API Security Top 10, 2023.
14. Final, endterm and midterm assignment texts: `docs/requirements/`.
15. Earlier reports of this project: `reports/REPORT.md` (midterm), `reports/endterm/REPORT.md`
    (endterm).

External libraries (pinned in `requirements.txt` and `constraints.txt`): FastAPI, Starlette,
Uvicorn, httpx, psycopg 3 with psycopg-pool, prometheus-client, PyJWT; pytest for the tests.
Container images: `python:3.12-slim`, `postgres:16`, `nginx:1.27-alpine`,
`prom/prometheus:v2.53.0`, `grafana/grafana:11.2.0`,
`prometheuscommunity/postgres-exporter:v0.15.0`. No dataset and no third-party code beyond these
libraries is used.

---

## Appendix A

### A.1 Source code

| Path | Content |
|---|---|
| `app/services/` | gateway, auth, student, payment, transcript, timetable, `db_controller` |
| `app/fault_tolerance/` | `software/` S1–S13, `infrastructure/` H1, H2, H8 (code side); `README.md` is the index |
| `app/security/` | tokens, passwords, policy, audit, validation, rate limiting |
| `app/core/` | database access and writer routing, event log, metrics, request context |
| `app/fault_injection.py` | the `/chaos` endpoints |

### A.2 Configuration

| Path | Content |
|---|---|
| `docker-compose.yml` | the deployment |
| `config/postgres/init/` | schema, seed data, roles, grants |
| `config/postgres/scripts/node.sh`, `backup.sh` | database node start and rejoin; backup loop |
| `config/postgres/pg_hba.conf` | client authentication |
| `config/nginx/single.conf`, `redundant.conf` | baseline and final entry point |
| `config/prometheus/prometheus.yml`, `alerts.yml`, `alerts.test.yml` | scrape targets, rules, rule tests |
| `config/grafana/` | dashboard and provisioning |
| `.env.example`, `experiments/env.ts` | mode switches and secret generation |

### A.3 Test and experiment scripts

| Path | Content |
|---|---|
| `tests/unit/` | Python unit tests |
| `tests/integration/test_stack.py`, `test_stack_failover.py` | end-to-end tests |
| `experiments/scenarios.ts` | the 13 scenarios: inject, repair, expected alerts, criteria, checks |
| `experiments/workload.ts`, `attacks.ts` | load generator; attack and abuse sets |
| `experiments/run.ts`, `campaign.ts` | one run; all runs |
| `experiments/metrics.ts`, `acceptance.ts` | measures; criteria |
| `experiments/aggregate.ts`, `reliability.ts` | RESULTS.md; RELIABILITY.md |
| `experiments/restore.ts` | backup verification and merge restore |
| `experiments/demo.ts` | the live demonstration |
| `experiments/*.test.ts` | tests of the above |
| `.github/workflows/ci.yml` | unit, harness, configuration, alert-rule, dependency and integration jobs |

### A.4 Logs and results

| Path | Content |
|---|---|
| `reports/final/runs/<scenario>__<mode>__r<N>/metrics.json` | the computed result of one run |
| `logs/final/<scenario>__<mode>__r<N>/workload.jsonl.gz` | every request of the run |
| `logs/final/<scenario>__<mode>__r<N>/events.jsonl.gz` | every service's log lines in the window |
| `logs/final/<scenario>__<mode>__r<N>/alerts.json`, `resources.jsonl.gz` | alert observations; CPU and memory samples |
| `reports/final/RESULTS.md`, `results.csv` | aggregated, generated |
| `reports/final/RELIABILITY.md`, `reliability.csv` | reliability calculations, generated |
| `reports/final/figures/` | dashboard snapshots |
| `reports/final/demo/` | transcripts of the demonstration |
| `reports/final/EXPERIMENT-LOG.md` | incidents during the campaign |

### A.5 Supplementary tables

Per-criterion pass counts, every measure per scenario and configuration, and the alert timings are
in RESULTS.md. Fault-by-fault results of the soak are in RELIABILITY.md §4.

### A.6 Contribution

Aibyn Talgatov defined the scope of the final project from the assignment, chose to continue the
university information system in a new repository, directed the work, set the format of the
report and manages the repositories. The implementation, the experiment campaign and the drafting
of this report were produced with an AI coding assistant (Claude Code) working under that
direction; changes were checked by the automated tests described in §9.1. The system extends the
team's midterm project, to which Gani Uapov contributed (the timetable service, the first
Prometheus metrics and the midterm report; see `reports/REPORT.md` §14.4).
