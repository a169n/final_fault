# Resilient University Information System — Final Project

Course: Fault Tolerance and Dependable Computing · Integrated Dependability Engineering Capstone
(Option A: the university information system of the midterm and endterm, continued).

A small distributed university platform — students, payments, transcripts, timetables — built to be
broken on purpose. One code base and one image deploy in a **baseline** configuration (redundant
hardware that nothing uses) and in the **final** configuration (every mechanism on). The same
faults, load and attacks are injected into both, and the measured difference is the result.

| Start here | |
|---|---|
| **Final technical report** | [`reports/final/REPORT.md`](reports/final/REPORT.md) |
| Consolidated results (generated) | [`reports/final/RESULTS.md`](reports/final/RESULTS.md), [`results.csv`](reports/final/results.csv) |
| Reliability calculations (generated) | [`reports/final/RELIABILITY.md`](reports/final/RELIABILITY.md) |
| Architecture, data flows, fault tree | [`reports/final/ARCHITECTURE.md`](reports/final/ARCHITECTURE.md) |
| Test plan: SLOs, hypotheses, acceptance criteria | [`reports/final/TEST-PLAN.md`](reports/final/TEST-PLAN.md) |
| Threat model | [`reports/final/THREAT-MODEL.md`](reports/final/THREAT-MODEL.md) |
| Alert rules | [`reports/final/ALERTS.md`](reports/final/ALERTS.md) |
| Demonstration script | [`reports/final/DEMO.md`](reports/final/DEMO.md) |
| Compact report (PDF) | [`reports/final/REPORT-compact.pdf`](reports/final/REPORT-compact.pdf) |
| Presentation outline | [`reports/final/PRESENTATION.md`](reports/final/PRESENTATION.md) |
| Experiment log (incidents during the campaign) | [`reports/final/EXPERIMENT-LOG.md`](reports/final/EXPERIMENT-LOG.md) |

The reports of the earlier phases are kept for reference: midterm in `reports/REPORT.md`, endterm
in `reports/endterm/`.

## What the system is

```text
client ─► nginx :8080 ─► gateway-1 / gateway-2 ─► student ×2 · payment ×2 · timetable ×2 · transcript · auth
                                                        │
                                   postgres-primary ⇄ postgres-replica   (synchronous streaming replication)
                                   db-controller (promote · fence · sync)      db-backup (pg_dump every 15 s)
           Prometheus (11 alert rules) · Grafana · 2 × postgres-exporter        always on, in every mode
```

Stack: Python 3.12 + FastAPI, PostgreSQL 16, nginx, Docker Compose, Prometheus, Grafana. The
experiment harness is TypeScript on Node 22 (no dependencies to install).

## The two configurations

| | **baseline** | **final** |
|---|---|---|
| `npm run` | `up:baseline` | `up:final` |
| Software fault tolerance (retry, timeouts, circuit breaker, health checks, idempotency, checkpoint/rollback, degradation, outlier ejection, job checkpoints) | off | on |
| Infrastructure resilience actually used (replica failover, redundant gateways, standby reads, restart policy, **automatic database failover**, **backups**) | off | on |
| Security (JWT authentication, authorization, validation, rate limiting, audit log, chaos token) | off | on |
| Monitoring, structured logs, request IDs, alert rules, DB credentials and roles | on | on |

`up:midterm` and `up:endterm` still deploy the intermediate configurations of the earlier phases.
The exact switch list is in [`TEST-PLAN.md`](reports/final/TEST-PLAN.md) §2; the list of mechanisms
with file, switch and test is in [`app/fault_tolerance/README.md`](app/fault_tolerance/README.md).

## Quick start

Needs Docker (with Compose) and Node.js ≥ 22.6. Python 3.12 is needed only for the Python tests.

```bash
npm run up:final          # writes .env (generated secrets), builds, starts 19 containers
npm run mode              # -> final
npm run demo              # six live scenarios, about four minutes
```

| What | URL |
|---|---|
| API (nginx) | http://localhost:8080 — Swagger UI at `/docs` |
| Grafana dashboard | http://localhost:3000/d/university (anonymous read-only) |
| Prometheus alerts | http://localhost:9090/alerts |
| Database controller | http://localhost:3061/health — who accepts writes, who is the standby |

Log in and make a payment by hand:

```bash
set -a; . ./.env; set +a
TOKEN=$(curl -s localhost:8080/auth/token -H 'content-type: application/json' \
  -d '{"username":"bursar","password":"'$DEMO_PASSWORD'"}' | python3 -c 'import sys,json;print(json.load(sys.stdin)["access_token"])')
curl -s localhost:8080/api/payments -H "authorization: Bearer $TOKEN" -H 'content-type: application/json' \
  -H "idempotency-key: demo-$(date +%s)" -d '{"studentId":"s7","amount":100}'
```

## Reproducing the experiments

```bash
# one experiment, end to end: known-state restore -> workload -> inject -> repair -> checks
npm run exp db-failure -- --rep 1

# the campaign: 13 scenarios x 3 repetitions per configuration, each from fresh volumes
npm run up:baseline && npm run campaign -- --reps 3
docker compose down -v
npm run up:final    && npm run campaign -- --reps 3     # add --resume to continue an interrupted campaign

# aggregate every stored run into the report tables
npm run aggregate       # -> reports/final/RESULTS.md, results.csv
npm run reliability     # -> reports/final/RELIABILITY.md, reliability.csv
```

A 70 s scenario takes about 100 s with its restore; the soak takes 11 minutes. One configuration
takes about 80 minutes. Do not run anything else against the stack while a campaign runs
(see the experiment log for what happens if you do).

Each run writes `reports/final/runs/<scenario>__<mode>__r<N>/metrics.json` and the raw data
(`workload.jsonl.gz`, `events.jsonl.gz`, `alerts.json`, `resources.jsonl.gz`) to
`logs/final/<scenario>__<mode>__r<N>/`. Every number in the report is computed from these files.

### The thirteen scenarios

| # | Scenario | Fault | Assignment matrix row |
|---|---|---|---|
| E1 | `app-crash` | a student replica kills its own process | 1 |
| E2 | `db-failure` | the database primary is stopped | 2, 8 |
| E3 | `net-timeout` | a replica answers after 3 s | 3 |
| E4 | `node-failure` | two containers are killed together | 1 |
| E5 | `txn-interrupt` | the payment service crashes mid-transaction | 4 |
| E6 | `high-load` | 10 → 110 concurrent clients | 5 |
| E7 | `gateway-failure` | one gateway is killed | 1 |
| E8 | `error-spike` | four replicas fail every request (alerting) | 6 |
| E9 | `unauthorized-access` | forged tokens, privilege escalation | 7 |
| E10 | `abuse` | malformed input, burst, brute force | 7 |
| E11 | `data-loss` | payment records destroyed, restored from backup | 8 |
| E12 | `soak` | nine faults in ten minutes (MTTF/MTTR/availability) | 8 |
| E13 | `standby-failure` | the database standby is stopped | 2 |

## Tests

```bash
npm test                    # Python unit tests + harness tests
npm run test:alerts         # promtool unit tests of the 11 alert rules (needs Docker)
npm run up:final && npm run test:integration   # end to end, including a real failover and a restore
```

`npm run test:integration` stops and restarts a database node; never run it during a campaign.
On Windows use `python -m pytest ...` instead of the `python3` the npm scripts call.

## Breaking it by hand

```bash
H="x-chaos-token: $CHAOS_TOKEN"; J="content-type: application/json"
curl -X POST localhost:3011/chaos/crash -H "$H"                          # application crash
curl -X POST localhost:3011/chaos -H "$H" -H "$J" -d '{"latencyMs":3000}'   # slow replica
curl -X POST localhost:3021/chaos -H "$H" -H "$J" -d '{"crashAfterCheckpoint":true}'  # interrupted payment
docker compose stop postgres-primary        # database failure: watch localhost:3061/health
docker compose start postgres-primary       # it rejoins as a standby
docker compose kill student-1 payment-1     # node failure
npm run db:restore -- --verify              # prove the newest backup restores
```

## Project map

```text
docker-compose.yml          the deployment (19 containers)
app/
├── services/               gateway, auth, student, payment, transcript, timetable, db_controller
├── fault_tolerance/        software/ (S1–S13) and infrastructure/ (H1–H2, H8); README.md lists all
├── security/               tokens, passwords, policy, audit, validation, rate_limit
├── core/                   db (writer routing), eventlog, metrics, request context
└── fault_injection.py      /chaos endpoints
config/
├── postgres/               init/ (schema, roles, grants), pg_hba.conf, scripts/node.sh, scripts/backup.sh
├── nginx/                  single.conf, redundant.conf
├── prometheus/             prometheus.yml, alerts.yml, alerts.test.yml
└── grafana/                dashboard + provisioning
experiments/                the harness: scenarios, workload, run, campaign, metrics, acceptance,
                            aggregate, reliability, restore, demo (+ *.test.ts)
tests/                      unit/ (pytest), integration/ (against the running stack)
reports/final/              the final report and everything it cites
logs/final/                 raw data of every run
docs/requirements/          the three assignment texts
```

## Secrets and data

`npm run up:<mode>` generates every password and key into a git-ignored `.env` (24 random bytes
each); nothing secret is in the repository. All data is synthetic (200 generated students). The
experiments, the attacks and the demonstration run only against this local stack.

## Team

Aibyn Talgatov (CSE-2505M). Contribution: REPORT.md, appendix A.6.
