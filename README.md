# Resilient University Information System

A small distributed university platform (students, payments, transcripts,
timetables), built as the **midterm** project of the course and extended for the
**endterm**. One code base and one image deploy in **three modes**, the same faults and
attacks are injected into each, and the measured difference shows what each layer of
mechanisms buys:

| Mode | Switches | What it is |
|---|---|---|
| **baseline** | `FT_ENABLED=0`, `ENDTERM_ENABLED=0` | replicas and standby exist, but no software uses them |
| **midterm** | `FT_ENABLED=1`, `ENDTERM_ENABLED=0` | the midterm fault-tolerant system (git tag `midterm-final` = commit `51100cf` = `origin/main`; use the commit if your clone has no tag) |
| **endterm** | `FT_ENABLED=1`, `ENDTERM_ENABLED=1` | + redundant gateways, outlier ejection, authN/authZ, validation, rate limiting, audit, required payment `Idempotency-Key`, chaos token |

Observability (correlation IDs, metrics, structured logs, Prometheus, Grafana, alert
rules, Docker healthchecks) and credential hygiene (generated DB passwords,
least-privilege roles) are on in **every** mode, so all three are measured the same
way. Every measured difference is caused by the mechanisms and nothing else.

Stack: Python 3.12 + FastAPI, PostgreSQL 16 with streaming replication, nginx,
Docker Compose, Prometheus, Grafana, postgres-exporter. The experiment harness is
TypeScript on Node 22.

Reports: the endterm report is [`reports/endterm/REPORT.md`](reports/endterm/REPORT.md);
the midterm report is [`reports/REPORT.md`](reports/REPORT.md); the architecture
diagrams are in [`reports/ARCHITECTURE.md`](reports/ARCHITECTURE.md).

## Project map

```text
docker-compose.yml        the deployment: nginx, 2 gateways, 2 replicas per service, auth,
                          DB primary + standby, monitoring plane, healthchecks, secrets from .env

app/                      everything that runs inside the containers
├── services/             WHAT the system does: the business logic
│   ├── gateway.py          entry point behind nginx; policy enforcement point (endterm)
│   ├── auth.py             issues short-lived JWTs (endterm)
│   ├── student.py          2 replicas
│   ├── payment.py          2 replicas, the money path
│   ├── transcript.py       1 instance, serves stale data when the DB is down
│   ├── timetable.py        2 replicas, long-running jobs
│   └── schedule.py         pure timetable placement algorithm
├── fault_tolerance/      HOW it survives failures (README.md = full list)
│   ├── software/           S1–S11, one file per mechanism
│   │   ├── retry.py              S1 retry + exponential backoff
│   │   ├── timeouts.py           S2 timeouts (+ S8 fail-fast writes)
│   │   ├── circuit_breaker.py    S3
│   │   ├── health_check.py       S4
│   │   ├── idempotency.py        S5 no double charges
│   │   ├── checkpoint_rollback.py S6 payments
│   │   ├── degradation.py        S7 stale cache
│   │   ├── job_checkpoint.py     S10 timetable jobs
│   │   └── outlier_ejection.py   S11 per-instance ejection (endterm)
│   └── infrastructure/     code side of H1 and H2
│       ├── load_balancer.py      H1 round robin over replicas
│       └── db_failover.py        H2 read from the standby
├── security/             endterm controls: tokens, passwords, policy, audit, validation, rate_limit
├── core/                 plumbing: db.py, eventlog.py, context.py (request id), metrics.py, service.py
└── fault_injection.py    /chaos endpoints the experiments use to break things (token in endterm)

config/
├── nginx/                single.conf (baseline, midterm), redundant.conf (endterm)
├── postgres/             schema, seed data, roles (00-roles.sh), auth users, grants, pg_hba.conf
├── prometheus/           prometheus.yml, alerts.yml, alerts.test.yml (promtool unit tests)
└── grafana/              provisioning + dashboard university.json

experiments/              HOW the experiments are run (TypeScript, *.test.ts = node --test)
├── scenarios.ts            the 10 scenarios E1–E10: inject, repair, expected alerts, acceptance
├── workload.ts             load generator, records every request (auth-aware in endterm)
├── attacks.ts              the E9/E10 attack and abuse sets
├── run.ts                  one experiment end to end (known-state restore first)
├── campaign.ts             every scenario × N repetitions
├── metrics.ts              availability, latency, detection/recovery, key-level integrity
├── alerts.ts, resources.ts, acceptance.ts   alert capture, CPU/memory, pass/fail criteria
├── aggregate.ts            runs → reports/endterm/RESULTS.md + results.csv
├── recovery-by-op.ts       raw logs → per-operation outage/recovery (reports/endterm/analysis/)
├── snapshot.ts             Grafana PNG for one run's time window
├── demo.ts                 live demonstration (reports/endterm/DEMO.md)
├── env.ts, env-file.ts     mode → .env builder (pure, tested)
└── up.ts                   deploy a mode (npm run up:baseline | up:midterm | up:endterm)

tests/                    unit/ (pytest, no containers), integration/ (against a live endterm stack)
.github/workflows/ci.yml  unit, harness, config checks, pip-audit, integration

logs/                     raw data. Midterm: logs/<scenario>__<mode>/. Endterm: logs/endterm/<scenario>__<mode>__r<N>/ (post-review checks: logs/post-review/)
reports/                  everything written up
├── REPORT.md               the midterm technical report
├── ARCHITECTURE.md         diagrams: endterm and midterm deployment, code layers, trust boundaries
├── COMPARISON.md, METHODOLOGY.md, EXPERIMENT-LOG.md, runs/   midterm results
└── endterm/
    ├── REPORT.md             ◀ the endterm technical report (start here)
    ├── RESULTS.md, results.csv  the aggregated campaign results (experiments/aggregate.ts)
    ├── THREAT-MODEL.md       STRIDE per trust boundary, controls, residual risks
    ├── ALERTS.md             the 6 alert rules: what, threshold, response
    ├── OBSERVABILITY.md      one real incident detected and diagnosed end to end
    ├── TEST-PLAN.md          test levels, E1–E10 with hypotheses and acceptance criteria
    ├── DEMO.md               demonstration script
    ├── demo/                 captured terminal transcripts of the demo rehearsals
    ├── figures/              Grafana dashboard snapshots of five endterm runs
    ├── analysis/             per-operation recovery from the raw logs (experiments/recovery-by-op.ts)
    ├── deps/                 first pip-audit output (pre-upgrade pins)
    ├── security/             pip-audit before and after the PyJWT/FastAPI upgrade (REPORT.md §5.4), check logs
    ├── post-upgrade/         post-upgrade check: 4 endterm scenarios × 1 run, outside the campaign
    ├── post-review/          after the final-review fixes: 3 endterm scenarios × 1 run (REPORT.md §5.5)
    └── runs/<scenario>__<mode>__r<N>/metrics.json   one file per run
```

## Running

The `npm run` and `docker compose` commands are the same on Windows, macOS and Linux. Needs Docker
and Node.js 22.6 or newer (`node --version`; with nvm: `nvm use 22`). The Python tests need
Python 3.12+ and `pip install -r requirements-dev.txt -c constraints.txt`. `npm test` and
`npm run test:integration` call `python3`; a standard Windows Python install has `python` or `py`
instead, so on Windows run `python -m pytest -q tests/unit` and
`python -m pytest -m integration -q tests/integration` directly (and `npm run test:harness` for the
harness tests).

### Deploy one of the three modes

    npm run up:baseline     # FT_ENABLED=0, ENDTERM_ENABLED=0, RESTART_POLICY=no,             NGINX_PROFILE=single
    npm run up:midterm      # FT_ENABLED=1, ENDTERM_ENABLED=0, RESTART_POLICY=unless-stopped, NGINX_PROFILE=single
    npm run up:endterm      # FT_ENABLED=1, ENDTERM_ENABLED=1, RESTART_POLICY=unless-stopped, NGINX_PROFILE=redundant
    npm run up:ft           # alias of up:midterm, kept so the midterm docs stay valid
    npm run mode            # which mode is running now: baseline | midterm | endterm

Switching mode for a fair comparison: start each mode from a fresh volume,
`docker compose down -v` first. After pulling schema changes, do the same once.

### Secrets and `.env`

`npm run up:<mode>` writes `.env` (template: `.env.example`) and then runs
`docker compose up -d --build`. The mode switches are overwritten each time. The secrets
`POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `REPL_PASSWORD`, `MONITOR_DB_PASSWORD`, `JWT_SECRET`,
`CHAOS_TOKEN`, `DEMO_PASSWORD` and `GRAFANA_ADMIN_PASSWORD` are kept if already present and
generated randomly (24 random bytes, base64url) if missing. `.env` is git-ignored; never commit
it. `docker-compose.yml` refuses to start without it (`${VAR:?}`), and
`npm run env -- <mode>` writes it without starting anything. To use a secret in a shell:

    set -a; . ./.env; set +a      # then $DEMO_PASSWORD, $CHAOS_TOKEN, ... are set

### Monitoring (always on, every mode)

| What | URL | Notes |
|---|---|---|
| API (nginx) | http://localhost:8080 | Swagger UI at `/docs`; every service also on its `127.0.0.1:30xx/docs` |
| Prometheus | http://localhost:9090 | alert state at `/alerts`, rules at `/rules`, targets at `/targets` |
| Grafana | http://localhost:3000/d/university | anonymous read-only; admin user `admin`, password `GRAFANA_ADMIN_PASSWORD` from `.env` |
| postgres-exporter | http://localhost:9187/metrics | `pg_up`, replication statistics |

    npm run monitoring      # (re)start only Prometheus, Grafana and postgres-exporter

### Tests

    npm test                    # unit tests (pytest) + harness tests (node --test)
    python3 -m pytest -q tests/unit
    npm run test:harness        # experiments/**/*.test.ts
    npm run test:alerts         # promtool unit tests for the alert rules (needs Docker)
    npm run up:endterm && npm run test:integration   # integration suite; skips unless the stack runs endterm

CI (`.github/workflows/ci.yml`) runs the unit and harness tests, `docker compose config` for
all three modes, the promtool and `nginx -t` checks, `pip-audit -r requirements.txt`, and the
integration suite against a fresh endterm stack. GitHub Actions has not run this workflow: the
repository owner's account is locked for billing, so the jobs' commands were run locally
(`reports/endterm/security/post-upgrade-checks.log`, `post-review-checks.log`).

### Experiments, campaign, aggregation, figures

    npm run exp app-crash -- --rep 1        # one experiment (restore → workload → inject → repair → capture)
    npm run campaign -- --reps 3            # all 10 scenarios × 3 repetitions against the deployed mode
    npm run campaign -- --reps 1 --only app-crash,db-failure

Each run writes `reports/endterm/runs/<scenario>__<mode>__r<N>/metrics.json` (alerts,
resources, key-level integrity, acceptance) and the raw data to
`logs/endterm/<scenario>__<mode>__r<N>/`. `--rep 0` is a smoke run and is left out of the
aggregation. The full campaign, one fresh volume per mode:

    npm run up:baseline && npm run campaign -- --reps 3
    docker compose down -v && npm run up:midterm && npm run campaign -- --reps 3
    docker compose down -v && npm run up:endterm && npm run campaign -- --reps 3

Then aggregate every stored run and, while the stack still holds the time window in
Prometheus, take dashboard snapshots:

    node --experimental-strip-types experiments/aggregate.ts
        # → reports/endterm/RESULTS.md and reports/endterm/results.csv
    node --experimental-strip-types experiments/snapshot.ts db-failure__endterm__r1 [more tags ...] [--full]
        # → reports/endterm/figures/<tag>.png, plus <tag>-full.png (all panels) with --full
        #   (needs Playwright installed globally)

Do not run the demo or anything else against the stack while a campaign runs.

### Demonstration

    npm run demo                    # app-crash, db-failure, gateway-failure, unauthorized, abuse
    npm run demo -- full            # all nine demos
    npm run demo -- unauthorized    # one demo

The script and what to expect are in [`reports/endterm/DEMO.md`](reports/endterm/DEMO.md).

## Services and ports

| Component | Port | Instances |
|---|---|---|
| nginx (entry point) | 8080 | 1; `config/nginx/single.conf` (baseline, midterm) or `redundant.conf` (endterm) |
| gateway-1 / gateway-2 | 127.0.0.1:8081 / 8082 | 2; only endterm puts gateway-2 in nginx rotation |
| student-1 / student-2 | 127.0.0.1:3011 / 3012 | 2 replicas |
| payment-1 / payment-2 | 127.0.0.1:3021 / 3022 | 2 replicas |
| timetable-1 / timetable-2 | 127.0.0.1:3041 / 3042 | 2 replicas |
| transcript-1 | 127.0.0.1:3031 | 1 |
| auth-1 | 127.0.0.1:3051 | 1; issues JWTs, reached through the gateway as `POST /auth/token` |
| postgres-primary / postgres-replica | 127.0.0.1:55432 / 55433 | primary + hot standby; password required (`scram-sha-256`) |
| prometheus | 127.0.0.1:9090 | 1, always on (alert rules: `config/prometheus/alerts.yml`) |
| grafana | 127.0.0.1:3000 | 1, always on (dashboard `university`) |
| postgres-exporter | 127.0.0.1:9187 | 1, always on (`pg_up`, replication) |

## Logging in

The auth service issues 15-minute JWTs (HS256) through the gateway. The demo users are
`admin` (admin), `bursar` (staff), `s7` and `s8` (students), all with `DEMO_PASSWORD` from `.env`:

    curl -s localhost:8080/auth/token -d '{"username":"bursar","password":"'$DEMO_PASSWORD'"}'

Only endterm requires the token on `/api/*` (`app/security/policy.py`, REPORT.md §5.1). The gateway verifies it with
`JWT_SECRET`, so an `auth-1` outage blocks new logins but not existing sessions.

Endterm also rate-limits at the gateway (`app/security/rate_limit.py`): logins per
client IP (1/s, burst 5) and `/api/*` per user (student 10/s burst 20, staff 5 000/s, admin
1 000/s). Over quota the answer is `429` with `Retry-After`. The limits are kept **per gateway**,
so with two gateways the cluster-wide limit is up to 2× the quota. Override a quota with
`RATE_LIMIT_<SCOPE>_PER_S` / `RATE_LIMIT_<SCOPE>_BURST` (scope `LOGIN`, `STUDENT`, `STAFF`, `ADMIN`).

Only nginx (8080) is published beyond the host; every other port is bound to `127.0.0.1`.

## Database roles

Every password comes from the generated, git-ignored `.env`; nothing is hard-coded
(`config/postgres/init/00-roles.sh`, `90-grants.sql`, `pg_hba.conf`):

| Role | Used by | Rights |
|---|---|---|
| `app_rw` | every service (`DATABASE_URL`, `DATABASE_REPLICA_URL`) | SELECT/INSERT/UPDATE on students, payments, grades, timetable_jobs, app_users; SELECT on courses, rooms; sequence USAGE. No DELETE, TRUNCATE or DDL |
| `repl` | postgres-replica (`pg_basebackup`, streaming) | REPLICATION only |
| `monitor` | postgres-exporter | `pg_monitor` (statistics, no table data) |
| `postgres` | the operator, over `docker exec` only | superuser; the only `trust` line in `pg_hba.conf` is its local socket |

Every network connection needs a password (`scram-sha-256`). The harness resets state between
experiments as the superuser over `docker exec` (`experiments/run.ts`), an operator action.

## Breaking it by hand

In endterm the `/chaos*` endpoints answer only with `x-chaos-token: $CHAOS_TOKEN` (from `.env`);
anything else is a `403` plus an audit event. Baseline and midterm ignore the header.

    H="x-chaos-token: $CHAOS_TOKEN"
    curl -X POST localhost:3011/chaos/crash -H "$H"                              # application crash
    J="content-type: application/json"   # without it curl -d sends a form and /chaos answers 422
    curl -X POST localhost:3011/chaos -H "$H" -H "$J" -d '{"latencyMs":3000}'            # slow service
    curl -X POST localhost:3021/chaos -H "$H" -H "$J" -d '{"crashAfterCheckpoint":true}' # interrupted payment
    docker compose stop postgres-primary                                 # database failure
    docker compose kill student-1 payment-1                              # node failure

`docker compose kill` is an operator stop and deliberately does **not** trip the
restart policy, which makes it a faithful "the node is gone" simulation. An
application crash must therefore come from inside the process (`/chaos/crash`).

## Measurement

Every service appends one JSON line per event to `logs/events.jsonl`. Every line carries the
request's correlation id (`rid`), the service, the mode and a level (values below are placeholders):

    {"ts":…,"svc":"gateway-1","ft":1,"mode":"endterm","rid":"…","level":"info","kind":"route","target":"payments","instance":"http://payment-2:3000","ok":true,"attempts":1}
    {"ts":…,"svc":"gateway-1","ft":1,"mode":"endterm","rid":"…","level":"warning","kind":"audit","action":"POST /api/payments","outcome":"deny","reason":"not_owner","sub":"s7","role":"student"}
    {"ts":…,"svc":"payment-1","ft":1,"mode":"endterm","rid":"…","level":"info","kind":"recovery","action":"duplicate_suppressed"}

    grep '"rid": "<id>"' logs/events.jsonl     # one request's path through nginx, gateway and services

Every metric in `reports/` is computed from this log plus the per-request workload
log; no number is asserted without raw data behind it. Live metrics are on `GET /metrics`
of every gateway and service (scraped by Prometheus every 2 s).
