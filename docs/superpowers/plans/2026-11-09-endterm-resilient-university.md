# Endterm: Resilient University Information System — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Extend the midterm fault-tolerant university system with stronger cloud/microservice resilience, full observability with alerting, security controls with intrusion tolerance, and a repeatable verification and fault-injection campaign. Then compare the result, using measurements, against the baseline and the midterm configuration.

**Architecture:** Keep the midterm topology, which is one image with services selected by command, PostgreSQL primary plus hot standby, and the TypeScript experiment harness. Add the following on top:
- a redundant gateway pair behind nginx
- an `auth` microservice that issues JWTs, with the gateway acting as the policy enforcement point
- per-instance outlier ejection
- Prometheus, Grafana and postgres-exporter running in every mode, with alert rules
- correlation IDs across every hop

A new switch, `ENDTERM_ENABLED`, gates every new *behaviour*. That gives three deployable modes from one codebase: **baseline** (FT=0, ENDTERM=0), **midterm** (FT=1, ENDTERM=0) and **endterm** (FT=1, ENDTERM=1). Observability is always on, so all three modes are measured the same way.

**Tech Stack:**
- Python 3.12, FastAPI 0.115.6, httpx 0.28.1, psycopg 3.2.3, prometheus-client 0.21.1, PyJWT 2.10.1
- PostgreSQL 16, nginx 1.27-alpine, Prometheus v2.53.0, Grafana 11.2.0, postgres-exporter v0.15.0
- Docker Compose
- Node ≥ 22.6 harness (`node --test` for harness tests), pytest 8.3.4 with pytest-asyncio 0.25.0
- GitHub Actions CI

**Spec:** `docs/requirements/endterm-assignment.pdf` (primary). `docs/requirements/midterm-assignment.pdf` is the context for continuity. The midterm system it extends is described in `README.md`, `reports/REPORT.md` and `app/fault_tolerance/README.md`.

## Global Constraints

- Extend the midterm system. Do not replace it. Reuse the student, payment, transcript and timetable services and the payment workflow. Document every major architecture change in the endterm report (spec §4).
- Keep at least 3 independently identifiable services and a data-storage component (spec §4).
- Keep the baseline and midterm configurations deployable for fair comparison: `npm run up:baseline`, `npm run up:midterm`, `npm run up:endterm` (spec §4). Tag the current `HEAD` as `midterm-final` before any change.
- Use synthetic data only. Never test anything except the local stack (spec §4).
- Never fabricate measurements. Label any simulated or illustrative number as such (spec §6). Every number in the endterm report must trace to a file under `logs/endterm/` or `reports/endterm/`.
- Run at least 6 experiments. At least 4 must be fault injection or abnormal conditions, and at least 2 must test security or misuse. Restore a known state between experiments (spec §6).
- For every experiment, report the hypothesis, environment/config, steps, expected result, observed result, repetitions and limitations (spec §6).
- Measure the following (spec §7):
  - success and failure counts, error rate, average and p95 latency
  - detection time and recovery time
  - availability
  - alerts fired, and whether each was correct
  - missing or duplicate records
  - baseline vs midterm vs endterm
- Implementation minimums (spec §5): at least 3 metrics, structured logs, a correlation ID, at least 3 alert rules (each with what it detects, its threshold and the expected response), at least 3 security controls, automated tests, and repeatable fault-injection scripts.
- `ENDTERM_ENABLED=1` gates new behaviour: outlier ejection, the second gateway in rotation, authN/authZ, strict validation, rate limiting, required payment Idempotency-Key, and the chaos token check. The following are on in **every** mode: correlation IDs, metrics, structured logs, Prometheus, Grafana, alerts, Docker healthchecks, DB passwords and least-privilege roles. This is measurement and credential hygiene, not behaviour under test. State this choice in the report.
- Pin every new dependency and image to the exact versions in Tech Stack.
- Commit style is the repo's conventional commits (`feat(scope): …`, `docs: …`).

## Review Focus

1. **The legitimate workload throttled by the new rate limiter.** At the high-load ramp (110 workers, about 2 000 req/s), the staff quota must not produce 429s. Otherwise the endterm high-load availability is an artefact of the limiter. This is pinned in Task 11 by `test_staff_quota_absorbs_high_load_peak`.
2. **nginx re-sending a POST to the second gateway after the first died mid-request.** This is a double charge if the gateway generated the key. With ENDTERM on, `POST /api/payments` without `Idempotency-Key` must return 400. Pinned in Task 7 by `test_payment_without_idempotency_key_rejected`.
3. **Forged, expired, `alg=none` or wrong-audience JWTs accepted.** Pinned in Task 8 by `test_verify_rejects_*`.
4. **A hostile `X-Request-ID` (newline, 10 KB, non-ASCII) written verbatim into logs.** This is log injection. It must be replaced by a fresh UUID. Pinned in Task 2 by `test_hostile_request_id_replaced`.
5. **Metric label cardinality blown up by raw paths** (`/api/students/s1…s200`). The route label must be the route template. Pinned in Task 3 by `test_route_label_is_template`.

Also pinned: a failed-login audit event must never contain the password or the Authorization header (`test_audit_event_has_no_secrets`, Task 9).

---

## What the midterm already gives us (do not rebuild)

| Endterm requirement | Already present | Gap this plan closes |
|---|---|---|
| Gateway, replicas, load balancing, health checks, timeout/retry/breaker, degradation | gateway, H1, S1–S4, S7 | the gateway is a SPOF (Task 7); a slow instance is not ejected (Task 6); no liveness/readiness split or container healthchecks (Task 5) |
| Structured logs, metrics, health endpoints | JSONL event log, `ft_events_total` | no correlation ID (Task 2), no latency/error metrics (Task 3), no dashboard or alerts (Task 4) |
| Security | none (Postgres `trust`, open `/chaos`, no auth) | Tasks 8–12 |
| Tests | none | Task 1 (unit), Task 16 (integration + CI) |
| Experiments | 6 fault scenarios × 2 modes × 1 run | auth-aware harness, alert and resource capture, acceptance criteria, 3 repetitions, 3 modes, 4 new scenarios (Tasks 14, 15, 17) |

## File structure (new or changed)

```text
app/core/context.py            request-id contextvar + validation               (T2)
app/core/metrics.py            prometheus_client registry + helpers             (T3)
app/core/service.py            middleware: rid, metrics, /health/live|ready     (T2,T3,T5)
app/core/eventlog.py           adds rid, level, mode(); endterm_enabled()       (T0,T2)
app/fault_tolerance/software/outlier_ejection.py                              (T6)
app/security/tokens.py         JWT issue/verify                                 (T8)
app/security/passwords.py      scrypt hash/verify                               (T8)
app/security/policy.py         authorization matrix                             (T9)
app/security/audit.py          audit events                                     (T9)
app/security/validation.py     pydantic input models + gateway limits           (T10)
app/security/rate_limit.py     token bucket                                     (T11)
app/services/auth.py           auth microservice                                (T8)
app/services/gateway.py        PEP: authn/z, limits, validation, rid forward    (T7–T11)
config/nginx/{single,redundant}.conf                                           (T7)
config/postgres/init/00-roles.sh, 30-auth.sql, pg_hba.conf                     (T8,T12)
config/prometheus/{prometheus.yml,alerts.yml,alerts.test.yml}                  (T4)
config/grafana/provisioning/**, config/grafana/dashboards/university.json      (T4)
docker-compose.yml             nginx, gateway-1/2, auth, grafana, exporter, healthchecks, secrets (T4,T5,T7,T8,T12)
experiments/env.ts             mode → .env builder (pure, tested)               (T0)
experiments/{workload,run,metrics,scenarios,campaign}.ts   upgraded             (T14,T15)
experiments/{alerts,resources,acceptance,aggregate,snapshot}.ts  new           (T14,T17)
experiments/*.test.ts          node --test                                      (T14)
tests/unit/**, tests/integration/**, tests/conftest.py, pytest.ini, requirements-dev.txt (T1,T16)
.github/workflows/ci.yml                                                       (T16)
reports/endterm/{REPORT,RESULTS,TEST-PLAN,THREAT-MODEL,ALERTS,OBSERVABILITY}.md, runs/, figures/  (T13,T17,T19)
logs/endterm/<scenario>__<mode>__r<n>/                                          (T17)
```

---

## Phase 0: Freeze the midterm and add the third mode

### Task 0: Tag the midterm, add `ENDTERM_ENABLED`, three modes, secrets in `.env`

**Files:**
- Create: `experiments/env.ts`, `experiments/env.test.ts`
- Modify: `experiments/up.ts`, `package.json`, `.env.example`, `app/core/eventlog.py`, `app/services/gateway.py` (`/health` body), `README.md` (Running)

**Interfaces:**
- Produces (TS): `buildEnv(mode: 'baseline'|'midterm'|'endterm', existing: Record<string,string>): Record<string,string>`. It keeps the existing secret values and generates missing ones with `randomBytes(24).toString('base64url')`. Keys: `FT_ENABLED`, `ENDTERM_ENABLED`, `RESTART_POLICY`, `NGINX_PROFILE` (`single`|`redundant`), `POSTGRES_PASSWORD`, `APP_DB_PASSWORD`, `REPL_PASSWORD`, `MONITOR_DB_PASSWORD`, `JWT_SECRET`, `CHAOS_TOKEN`, `DEMO_PASSWORD`, `GRAFANA_ADMIN_PASSWORD`.
- Produces (Py): `eventlog.endterm_enabled() -> bool`, `eventlog.mode() -> Literal['baseline','midterm','endterm']`. Every log line gains `"mode"`. Gateway `/health` returns `{"ok", "ft", "endterm", "mode", "instances"}`.

- [ ] **Step 1:** `git tag midterm-final` on the current HEAD (51100cf) and push the tag. Commit the two assignment PDFs under `docs/requirements/` (already copied).
- [ ] **Step 2: Write failing test** `experiments/env.test.ts`:
  - `buildEnv('baseline', {})` → `FT_ENABLED=0, ENDTERM_ENABLED=0, RESTART_POLICY=no, NGINX_PROFILE=single`
  - `midterm` → `1, 0, unless-stopped, single`
  - `endterm` → `1, 1, unless-stopped, redundant`
  - `buildEnv('endterm', {JWT_SECRET:'x'}).JWT_SECRET === 'x'`
  - every secret key is non-empty and at least 24 characters when generated
- [ ] **Step 3:** Run `node --experimental-strip-types --test experiments/` → FAIL (module missing).
- [ ] **Step 4:** Implement `buildEnv` plus `parseEnv(text)` and `formatEnv(obj)`. In `up.ts`, read the existing `.env`, call `buildEnv`, write it, then run `docker compose up -d --build`. Add the npm scripts `up:midterm` and `up:endterm`. Keep `up:ft` as an alias of `up:midterm` so the midterm docs stay valid. Add `"test:harness": "node --experimental-strip-types --test experiments/"`.
- [ ] **Step 5:** Add `endterm_enabled()` and `mode()` to `eventlog.py`, and add `mode` to `/health`. Update `npm run mode` to print `j.mode`.
- [ ] **Step 6:** Run `npm run test:harness` → PASS. Run `docker compose config -q` → exit 0.
- [ ] **Step 7:** Commit `feat(modes): third deployable mode (endterm) and generated secrets in .env`.

### Task 1: Unit-test scaffold and tests for the midterm mechanisms

This safety net must be in place before any mechanism is touched. It also counts as the "automated tests for critical workflows" deliverable.

**Files:**
- Create: `requirements-dev.txt` (pytest==8.3.4, pytest-asyncio==0.25.0, plus `-r requirements.txt`), `pytest.ini` (`asyncio_mode = auto`, `markers = integration`, `testpaths = tests`), `tests/conftest.py`, `tests/unit/test_retry.py`, `tests/unit/test_circuit_breaker.py`, `tests/unit/test_load_balancer.py`, `tests/unit/test_degradation.py`, `tests/unit/test_idempotency.py`

**Interfaces:**
- `tests/conftest.py` sets `DATABASE_URL=postgresql://x@localhost:1/x`, `LOG_DIR=<tmp_path_factory dir>` and `SERVICE_NAME=test` **before** any `app.*` import. It provides the fixture `ft(monkeypatch)` that sets `FT_ENABLED=1`, and `endterm(monkeypatch)` that sets both flags.

- [ ] **Step 1:** Write the tests, each against the current code:
  - `test_retry_succeeds_on_second_attempt`: fn fails once with `UpstreamError('x',503)` and then returns 7. Expect `(7, 2)`.
  - `test_retry_never_retries_4xx`: `UpstreamError('x',404)` → raised after 1 call.
  - `test_baseline_single_attempt_no_timeout`: FT off. fn receives `None` and is called once.
  - `test_breaker_opens_after_threshold_and_half_opens_after_cooldown`: 5 failures → `state(now)=='open'`, and `state(now+5000)=='half-open'`.
  - `test_breaker_open_short_circuits_call`: raises `UpstreamError` with status 503 and does not call fn.
  - `test_ring_skips_down_instances_when_ft`, `test_ring_baseline_is_blind`, `test_ring_all_down_tries_anyway`, `test_ring_rotates_per_call`.
  - `test_stale_cache_serves_203_within_max_age`, `test_stale_cache_disabled_in_baseline`, `test_stale_cache_expires`.
  - `test_payment_key_ignored_in_baseline`, `test_payment_key_from_header_in_ft`.
- [ ] **Step 2:** `pip install -r requirements-dev.txt && pytest tests/unit -q` → all PASS. These tests characterise existing behaviour. A failure is a real finding: stop and report it.
- [ ] **Step 3:** Commit `test: unit tests for midterm fault-tolerance mechanisms`.

---

## Phase 1: Observability (first, because every later experiment depends on it)

### Task 2: Correlation IDs and structured logs

**Files:**
- Create: `app/core/context.py`, `tests/unit/test_context.py`
- Modify: `app/core/service.py` (middleware), `app/core/eventlog.py`, `app/services/gateway.py` (forward header), `app/fault_tolerance/software/health_check.py` (probes carry `rid="health-<uuid>"`)

**Interfaces:**
- `context.REQUEST_ID: ContextVar[str|None]`
- `context.accept_request_id(raw: str|None) -> str` keeps `raw` only if it matches `^[A-Za-z0-9._-]{8,64}$`, and otherwise returns `str(uuid4())`
- `eventlog.log()` adds `rid` (from the contextvar) and `level` (`"error"` if `ok is False`, otherwise `"info"`; an explicit `level=` wins)
- Every response carries `x-request-id`. The gateway forwards `x-request-id` on every upstream attempt, including retries (same id), and the services log it.

- [ ] **Step 1: Failing tests:**
  - `test_valid_request_id_kept("abcd-1234-efgh")`
  - `test_hostile_request_id_replaced` for each of `"a\nb"*5`, `"x"*10_000`, `"ид-12345678"`, `None`: the result matches the UUID4 regex
  - `test_log_line_contains_rid_and_level`: set the contextvar, call `log(kind="t", ok=False)`, read the last line of `events.jsonl` → `rid` equals the set value and `level=="error"`
  - `test_middleware_echoes_request_id`: FastAPI `TestClient` on `create_app(with_db=False)` with a `/ping` route. The response header `x-request-id` equals the sent value, and a fresh UUID is returned when none is sent.
- [ ] **Step 2:** `pytest tests/unit/test_context.py` → FAIL.
- [ ] **Step 3:** Implement. The middleware sets the contextvar before `call_next` and resets it in `finally`.
- [ ] **Step 4:** Tests PASS, along with all of `tests/unit`.
- [ ] **Step 5:** Commit `feat(observability): request/correlation IDs across gateway and services`.

### Task 3: Service-level Prometheus metrics

**Files:**
- Create: `app/core/metrics.py`, `tests/unit/test_metrics.py`
- Modify: `requirements.txt` (+`prometheus-client==0.21.1`), `app/core/service.py`, `app/core/eventlog.py` (`metrics_text` = prometheus_client output + existing `ft_events_total`), `app/services/gateway.py`, `app/fault_tolerance/software/retry.py`, `health_check.py`, `circuit_breaker.py`, `app/services/payment.py`

**Interfaces (metric names are fixed; Task 4's alerts and dashboard use them):**
- `http_requests_total{svc,method,route,status}`: Counter. `route` is the matched route template (`request.scope["route"].path`), or `"unmatched"` if there is no match.
- `http_request_duration_seconds{svc,route}`: Histogram. Buckets: `.005,.01,.025,.05,.1,.25,.5,.8,1,2.5,5,10`.
- `upstream_attempts_total{pool,instance,outcome}`, where outcome is `ok|error|timeout|circuit_open`
- `instance_up{target}`: Gauge, from the gateway health check
- `circuit_breaker_open{name}`: Gauge, 0/1
- `instance_ejected{target}`: Gauge (set by Task 6)
- `auth_denied_total{reason}`, `rate_limited_total{scope}` (incremented by Tasks 9 and 11)
- `payments_stale_pending`: Gauge. The payment service refreshes it every 5 s in **all modes** with `SELECT count(*) FROM payments WHERE state='pending' AND created_at < now() - interval '15 seconds'`.
- `metrics.observe_request(svc, method, route, status, seconds) -> None`

- [ ] **Step 1: Failing tests:**
  - `test_request_counter_and_histogram_recorded`: TestClient hits `/api/students/s1` on a stub app. The `generate_latest()` output contains `http_requests_total{…route="/api/students/{id}"…} 1.0` and an `http_request_duration_seconds_count`.
  - `test_route_label_is_template`: 50 distinct ids produce exactly one label set.
  - `test_health_and_metrics_paths_not_counted`.
- [ ] **Step 2:** FAIL → implement → PASS. Instrument retry (per-attempt outcome), health_check (`instance_up`), breaker (gauge on open/close) and payment (the stale-pending loop).
- [ ] **Step 3:** `docker compose up -d --build`, then `curl -s localhost:8080/metrics | grep -c http_request_duration_seconds_bucket` → > 0.
- [ ] **Step 4:** Commit `feat(observability): request, latency, upstream and integrity metrics`.

### Task 4: Monitoring stack, alert rules and dashboard

**Files:**
- Create: `config/prometheus/prometheus.yml` (moved from `config/prometheus.yml`), `config/prometheus/alerts.yml`, `config/prometheus/alerts.test.yml`, `config/grafana/provisioning/datasources/prometheus.yml`, `config/grafana/provisioning/dashboards/dashboards.yml`, `config/grafana/dashboards/university.json`, `reports/endterm/ALERTS.md`
- Modify: `docker-compose.yml`
  - remove the `monitoring` profile so Prometheus always runs
  - add `grafana` (127.0.0.1:3000, anonymous Viewer, admin password from `.env`) and `postgres-exporter` (DSN as the `monitor` role)
  - Prometheus: `evaluation_interval: 2s`, `rule_files: [alerts.yml]`, scrape gateway-1, gateway-2, auth, all services and the exporter
- Modify: `package.json` (`"test:alerts": "docker run --rm -v ./config/prometheus:/p --entrypoint promtool prom/prometheus:v2.53.0 test rules /p/alerts.test.yml"`)

**Alert rules** (names are fixed; scenarios in Task 15 reference them). Each rule carries the `summary`, `threshold` and `response` annotations.

| Alert | Expression (sketch) | for | Expected response |
|---|---|---|---|
| `InstanceDown` | `up{job="university"} == 0` | 4s | restart policy self-heals; on-call investigates if still firing after 60 s |
| `DatabaseDown` | `pg_up == 0` | 4s | reads fail over to the standby, writes fail fast; operator restores the primary |
| `HighErrorRate` | 5xx share of gateway `http_requests_total` over `[15s]` > 0.05 | 6s | check `upstream_attempts_total` by instance and the breaker state |
| `HighLatencyP95` | `histogram_quantile(0.95, …gateway…[15s]) > 1` | 6s | look for slow instances and ejections; scale or eject |
| `AuthFailureSpike` | `sum(rate(auth_denied_total[30s])) > 2` | 4s | possible intrusion attempt: review the audit log by `rid` and `sub`; block or revoke |
| `PaymentsStuckPending` | `max(payments_stale_pending) > 0` | 10s | lost/interrupted transaction: confirm the rollback sweep ran; reconcile manually in baseline |

- [ ] **Step 1: Write the failing rule unit tests** `alerts.test.yml`. Each alert gets a series that crosses its threshold, with `exp_alerts` at `eval_time` = `for` + one interval, and a series just under the threshold with no alert.
- [ ] **Step 2:** `npm run test:alerts` → FAIL (no rules).
- [ ] **Step 3:** Write `alerts.yml` → `npm run test:alerts` PASS. Also run `promtool check rules`.
- [ ] **Step 4:** Build the dashboard JSON. Panels:
  - request rate by status
  - gateway error ratio
  - p50 and p95 latency
  - `instance_up` and `instance_ejected` state timeline
  - breaker open
  - auth denied and rate limited
  - `payments_stale_pending`
  - DB `pg_up` and replication lag (`pg_stat_replication`, if the exporter provides it)
  - active alerts (the Prometheus `ALERTS` series)
- [ ] **Step 5:** `docker compose up -d`. Then `curl -s localhost:9090/api/v1/rules | grep -c '"name"'` ≥ 6, and `curl -s localhost:3000/api/dashboards/uid/university` → 200.
- [ ] **Step 6:** Write `reports/endterm/ALERTS.md` with one row per alert: what it detects, threshold, `for`, expected team or system response, and which experiment exercises it.
- [ ] **Step 7:** Commit `feat(monitoring): always-on Prometheus, alert rules with tests, Grafana dashboard`.

---

## Phase 2: Cloud and microservices resilience

### Task 5: Liveness and readiness probes, plus container healthchecks

**Files:** Modify `app/core/service.py`, every service's `/health`, `app/fault_tolerance/software/health_check.py` and `docker-compose.yml`. Test: `tests/unit/test_health.py`.

**Interfaces:**
- `GET /health/live` → 200 `{"ok":true}` whenever the process serves. It does not touch the DB.
- `GET /health/ready` returns the current `/health` semantics: DB reachable, or for transcript in FT, cache-capable.
- `GET /health` stays as an alias of ready, so the midterm harness keeps working.
- The gateway probes `/health/ready`.
- In compose, each app service gets `healthcheck: ["CMD","python","-c","import os,urllib.request;urllib.request.urlopen(f'http://localhost:{os.environ[\"PORT\"]}/health/live',timeout=1)"]` with interval 2s, retries 3 and start_period 5s. Each service has its `PORT` env set.

- [ ] **Step 1:** Failing tests: `test_live_ok_without_db` (stub `db_healthy` → False, `/health/live` 200) and `test_ready_503_without_db`.
- [ ] **Step 2:** Implement → PASS. `docker compose ps` shows `(healthy)` for every app container.
- [ ] **Step 3:** Commit `feat(resilience): liveness/readiness split and container healthchecks`.

### Task 6: Per-instance outlier ejection

The midterm report §11 names this as the most valuable next step. The per-pool breaker never isolated the slow student-1.

**Files:** Create `app/fault_tolerance/software/outlier_ejection.py` and `tests/unit/test_outlier_ejection.py`. Modify `app/services/gateway.py` (record the outcome per attempted instance) and `app/fault_tolerance/infrastructure/load_balancer.py`.

**Interfaces:**
- `class OutlierDetector(consecutive: int = 3, eject_ms: int = 10_000, max_ejected_fraction: float = 0.5)` with these methods:
  - `.record(instance: str, ok: bool, now_ms: float|None=None) -> None`
  - `.is_ejected(instance, now_ms=None) -> bool`
  - `.ejected(now_ms=None) -> list[str]`
- Env: `FT_EJECT_CONSECUTIVE`, `FT_EJECT_MS`.
- Log `kind="ejection", target, state="ejected"|"restored"`. Set the `instance_ejected` gauge.
- `load_balancer.ring(pool, instances, is_up, is_ejected=lambda i: False)` filters ejected instances **only when `endterm_enabled()`**. It never ejects more than `max_ejected_fraction` of a pool, and the all-filtered fallback is unchanged.

- [ ] **Step 1:** Failing tests:
  - `test_three_consecutive_failures_eject`
  - `test_success_resets_streak`
  - `test_ejection_expires_after_eject_ms`
  - `test_never_ejects_more_than_half_pool` (2 replicas: the second never ejected)
  - `test_ring_ignores_ejection_in_midterm_mode`
- [ ] **Step 2:** Implement → PASS.
- [ ] **Step 3:** Smoke test on endterm. `curl -X POST localhost:3011/chaos -H "x-chaos-token: $CHAOS_TOKEN" -H 'content-type: application/json' -d '{"latencyMs":3000}'`, then 50 GETs to `/api/students/s7`. Gateway `/metrics` shows `instance_ejected{target="http://student-1:3000"} 1`. The token header only matters once Task 12 lands.
- [ ] **Step 4:** Commit `feat(resilience): per-instance outlier ejection`.

### Task 7: Redundant gateways behind nginx, and a mandatory payment Idempotency-Key

**Files:**
- Create: `config/nginx/single.conf`, `config/nginx/redundant.conf`, `tests/unit/test_gateway_idempotency.py`
- Modify: `docker-compose.yml` and `app/services/gateway.py`
  - compose: `gateway` → `gateway-1`, `gateway-2`, published only on 127.0.0.1:8081/8082; `nginx` on `8080:80`, mounting `./config/nginx/${NGINX_PROFILE:-single}.conf`, with `depends_on` the gateways healthy
  - gateway.py: in endterm, require the key

**Interfaces:**
- `single.conf`: upstream = `gateway-1` only (baseline and midterm, so the topology is identical to the midterm).
- `redundant.conf`: both gateways, with `max_fails=1 fail_timeout=5s`, `proxy_next_upstream error timeout non_idempotent`, `proxy_connect_timeout 1s`, `proxy_read_timeout 5s`, and `proxy_set_header X-Request-ID $http_x_request_id`. It also sets `X-Forwarded-For $remote_addr`, plus `location = /metrics { return 404; }` and `location ^~ /chaos { return 404; }`.
- With ENDTERM on, `POST /api/payments` without `Idempotency-Key` → 400 `{"error":"Idempotency-Key header required"}`. `non_idempotent` retry is safe only because of this rule; write that justification as a comment in `redundant.conf`.

- [ ] **Step 1:** Failing tests: `test_payment_without_idempotency_key_rejected` (endterm → 400) and `test_payment_without_key_allowed_in_midterm` (forwarded).
- [ ] **Step 2:** Implement → PASS. `docker run --rm -v ./config/nginx:/c nginx:1.27-alpine nginx -t -c /c/redundant.conf` passes (wrap in a minimal `http{}` if needed).
- [ ] **Step 3:** Update the harness constants: in `experiments/run.ts`, `INSTANCES` adds 8081 and 8082. The gateway in `ensureHealthy` is still 8080.
- [ ] **Step 4:** Smoke test on endterm. With a workload of `curl` in a loop, `docker compose kill gateway-1`: requests keep succeeding.
- [ ] **Step 5:** Commit `feat(resilience): redundant gateways behind nginx; payments require Idempotency-Key`.

---

## Phase 3: Security and intrusion tolerance

### Task 13 (do first in this phase): Threat model

**Files:** Create `reports/endterm/THREAT-MODEL.md`.

- [ ] **Step 1:** Write the threat model:
  - assets: the student ledger/balances, grades, the payments table, credentials/JWT secret, availability
  - actors: anonymous internet client, authenticated student, compromised student token, malicious insider on the host (out of scope, stated)
  - trust boundaries: client → nginx → gateway → services → DB, and the host
  - a STRIDE table per boundary, mapping each threat → control (Tasks 8–12) → test or experiment that demonstrates it
  - residual risks: services trust the internal network (no mTLS); rate-limit state is per gateway; no token revocation; secrets are in env vars, not a vault
- [ ] **Step 2:** Commit `docs(security): threat model`.

### Task 8: Auth microservice and JWT

**Files:**
- Create: `app/security/tokens.py`, `app/security/passwords.py`, `app/services/auth.py`, `config/postgres/init/30-auth.sql` (`app_users(username PK, password_hash, role CHECK IN ('student','staff','admin'), student_id NULL)`), `tests/unit/test_tokens.py`, `tests/unit/test_passwords.py`
- Modify: `requirements.txt` (+`PyJWT==2.10.1`); `docker-compose.yml` (`auth-1` service on `127.0.0.1:3051:3000`, `JWT_SECRET` and `DEMO_PASSWORD` env); gateway (`POST /auth/token` proxied to `AUTH_URLS`, through the same retry/breaker path); `experiments/run.ts` (`INSTANCES` adds 3051); `config/prometheus/prometheus.yml` (scrape `auth-1:3000`)

**Interfaces:**
- `passwords.hash_password(pw: str) -> str` uses `scrypt n=2**14,r=8,p=1`, stored as `scrypt$<salt_b64>$<hash_b64>`. `passwords.verify_password(pw, stored) -> bool` uses `hmac.compare_digest`.
- `tokens.issue(sub: str, role: str, student_id: str|None, now: int|None=None) -> str` produces HS256 tokens with `iss="ftu-auth"`, `aud="ftu-api"` and `exp=now+900`.
- `tokens.verify(token: str, now: int|None=None) -> Principal` raises `TokenError(reason)`, where reason is `expired|bad_signature|bad_audience|malformed`. It decodes with `algorithms=["HS256"]` only.
- `@dataclass(frozen=True) class Principal: sub: str; role: str; student_id: str|None`.
- Auth service:
  - `POST /token {username,password}` → 200 `{"access_token","token_type":"bearer","expires_in":900}`, or 401 `{"error":"invalid credentials"}` (same message for an unknown user and a wrong password)
  - on startup, if `app_users` is empty, seed `admin`(admin), `bursar`(staff) and `s7`, `s8`(student → s7/s8), all with `DEMO_PASSWORD`
- Resilience property, to be shown in an experiment note: tokens are verified locally at the gateway, so an `auth-1` outage blocks only new logins. Existing sessions keep working, which is graceful degradation.

- [ ] **Step 1:** Failing tests:
  - `test_issue_then_verify_roundtrip`
  - `test_verify_rejects_expired`
  - `test_verify_rejects_bad_signature`
  - `test_verify_rejects_alg_none` (hand-built `alg:none` token)
  - `test_verify_rejects_wrong_audience`
  - `test_password_roundtrip_and_wrong_password`
  - `test_hash_is_salted` (two hashes of the same password differ)
- [ ] **Step 2:** Implement → PASS.
- [ ] **Step 3:** `curl -s localhost:8080/auth/token -d '{"username":"bursar","password":"'$DEMO_PASSWORD'"}'` → token.
- [ ] **Step 4:** Commit `feat(security): auth service issuing short-lived JWTs`.

### Task 9: Authorization at the gateway, and audit logging

**Files:** Create `app/security/policy.py`, `app/security/audit.py`, `tests/unit/test_policy.py` and `tests/unit/test_audit.py`. Modify `app/services/gateway.py`.

**Interfaces:**
- `policy.authorize(p: Principal|None, method: str, pool: str, path: str, body: dict|None) -> Decision`, where `Decision = (allowed: bool, status: 200|401|403, reason: str)`.
- The matrix (exact):

| Route | anonymous | student | staff | admin |
|---|---|---|---|---|
| `GET /api/students` | 401 | 403 | ✓ | ✓ |
| `GET /api/students/{id}` | 401 | ✓ only if `id == student_id` | ✓ | ✓ |
| `POST /api/students` | 401 | 403 | 403 | ✓ |
| `POST /api/payments` | 401 | ✓ only if `body.studentId == student_id` | ✓ | ✓ |
| `GET /api/payments/{key}` | 401 | 403 | ✓ | ✓ |
| `GET /api/transcripts/{id}` | 401 | own only | ✓ | ✓ |
| `POST /api/timetables` | 401 | 403 | 403 | ✓ |
| `GET /api/timetables/{term}` | 401 | ✓ | ✓ | ✓ |

- The gateway reads `Authorization: Bearer`. Enforcement applies only when `endterm_enabled()`; otherwise it allows everything (the baseline and midterm comparison).
- It **fails closed**: any exception in verify or authorize → 401/403, never pass-through.
- `audit.record(action: str, outcome: 'allow'|'deny', p: Principal|None, reason: str, **fields) -> None` logs `kind="audit"` with `rid`. It is called for every deny, every payment allow, every admin action and every login (success and failure). It must never include a password, a token or the Authorization header. Every deny increments `auth_denied_total{reason}`.

- [ ] **Step 1:** Failing tests:
  - a parametrised `test_policy_matrix` with one case per cell above (32 cases)
  - `test_policy_fails_closed_on_exception`
  - `test_audit_event_has_no_secrets`: record a failed login with `password="hunter2"` in the input; the serialized event does not contain `hunter2` or `Bearer`
  - `test_gateway_returns_401_without_token_in_endterm` and `test_gateway_allows_without_token_in_midterm` (TestClient with the upstream stubbed via `respx`, or a monkeypatched `_client`)
- [ ] **Step 2:** Implement → PASS.
- [ ] **Step 3:** Commit `feat(security): gateway authorization policy and audit log`.

### Task 10: Input validation and request limits

**Files:** Create `app/security/validation.py` and `tests/unit/test_validation.py`. Modify `app/services/payment.py`, `student.py`, `timetable.py` and `gateway.py`.

**Interfaces:**
- Pydantic v2 models (via fastapi), all with `model_config = ConfigDict(extra='forbid')`:
  - `PaymentIn(studentId: str pattern ^s[0-9]{1,6}$, amount: Decimal gt 0 le 10000 max 2 decimal places)`
  - `StudentIn(id: same pattern, name: str 1..100 chars no control chars, credits: int 0..300 = 0)`
  - `TimetableJobIn(term: str pattern ^[0-9]{4}-(spring|summer|fall)$ or demo-[0-9]+)`
- `validation.parse(model, body) -> model | JSONResponse(422, {"error": "invalid input", "fields": [...]})`. Services call it when `endterm_enabled()`; otherwise they keep the midterm lenient logic unchanged.
- Gateway, endterm only:
  - body > 16 384 bytes → 413
  - non-JSON body on POST → 400
  - any path segment not matching `^[A-Za-z0-9._-]{1,64}$` → 400, before any upstream call
- Baseline evidence that this matters: `amount: 1e9` overflows `NUMERIC(10,2)` and returns 5xx in baseline/midterm.

- [ ] **Step 1:** Failing tests. A parametrised `test_payment_rejects` over: `amount` of -1, 0, 10000.01, 1e9, "abc", 1.001; `studentId` of `"s1'; DROP TABLE students;--"`, `""`, `"S1"`; an extra field. Also `test_payment_accepts_valid` (`s7`, `100.50`), `test_student_name_rejects_control_chars`, and `test_gateway_rejects_oversized_body_413` / `test_gateway_rejects_bad_path_segment_400`.
- [ ] **Step 2:** Implement → PASS.
- [ ] **Step 3:** Commit `feat(security): strict input validation and request limits`.

### Task 11: Rate limiting and abuse protection

**Files:** Create `app/security/rate_limit.py` and `tests/unit/test_rate_limit.py`. Modify `app/services/gateway.py`.

**Interfaces:**
- `class TokenBucket(rate_per_s: float, burst: int)` with `.allow(key: str, now: float|None=None) -> tuple[bool, float]`, which returns `(allowed, retry_after_s)`. Idle keys are evicted after 60 s.
- Quotas (env-overridable, endterm only):
  - `/auth/token`: per client IP (the first value of `X-Forwarded-For` from nginx), 1/s with burst 5
  - `/api/*`: per `sub` and role. Student 10/s burst 20. Staff 5 000/s burst 5 000. Admin 1 000/s burst 1 000.
- Over quota → 429 with `Retry-After` = `ceil(retry_after_s)`, plus `rate_limited_total{scope}` and an audit deny.
- Document that limits are per gateway: with 2 gateways the effective cluster limit is up to 2×.

- [ ] **Step 1:** Failing tests:
  - `test_bucket_allows_burst_then_limits`
  - `test_bucket_refills_over_time` (fake clock)
  - `test_keys_are_independent`
  - `test_staff_quota_absorbs_high_load_peak`: 2 200 calls inside 1.0 s of fake time with the staff quota → all allowed
  - `test_login_bruteforce_limited_after_5`
- [ ] **Step 2:** Implement → PASS.
- [ ] **Step 3:** Commit `feat(security): per-principal and per-IP rate limiting`.

### Task 12: Secrets handling, least privilege, chaos lockdown and dependency checks

**Files:**
- Create: `config/postgres/init/00-roles.sh`, which creates the roles from env:
  - `app_rw`: SELECT/INSERT/UPDATE on students, payments, grades, timetable_jobs, app_users; SELECT on courses, rooms; USAGE on sequences; **no** DELETE/TRUNCATE/DDL
  - `repl`: REPLICATION
  - `monitor`: `pg_monitor`
- Modify:
  - `pg_hba.conf`: `scram-sha-256` for host lines; keep `local all postgres trust` only for `docker exec` admin, and document why
  - `10-schema.sql`: remove `CREATE ROLE repl … 'replpass'`
  - `docker-compose.yml`:
    - `DATABASE_URL` uses `app_rw:${APP_DB_PASSWORD}`
    - `POSTGRES_PASSWORD` comes from `.env`, and `POSTGRES_HOST_AUTH_METHOD: trust` is removed
    - the replica gets `PGPASSWORD=${REPL_PASSWORD}`
    - every published port except nginx 8080 is bound to `127.0.0.1:`
  - `app/fault_injection.py`: with ENDTERM on, `/chaos*` requires the header `x-chaos-token == CHAOS_TOKEN`, compared with `hmac.compare_digest`; otherwise 403 and an audit event
  - `experiments/scenarios.ts` and `demo.ts`: send `x-chaos-token`, read from `.env` through `parseEnv`
  - `.env.example`: placeholders only
- Test: `tests/unit/test_chaos_guard.py`

- [ ] **Step 1:** Failing tests: `test_chaos_requires_token_in_endterm`, `test_chaos_open_in_midterm` (harness compatibility) and `test_chaos_token_compare_constant_time` (asserts `hmac.compare_digest` is used, via monkeypatch spy).
- [ ] **Step 2:** Implement → PASS. Then `docker compose down -v && npm run up:endterm`:
  - `docker compose exec postgres-primary psql "postgresql://app_rw:$APP_DB_PASSWORD@localhost/university" -c 'TRUNCATE payments'` → `permission denied`
  - `select count(*) from pg_stat_replication` = 1
  - `grep -rn "replpass\|password: postgres" docker-compose.yml config/` → no output
- [ ] **Step 3:** Change the harness: `run.ts`'s `TRUNCATE payments` keeps using superuser `docker exec`, which is correct because it is the operator resetting state. Add a comment.
- [ ] **Step 4:** Commit `feat(security): secrets out of the repo, least-privilege DB roles, chaos endpoint lockdown`.

---

## Phase 4: Verification, fault injection and the campaign

### Task 14: Harness upgrade for repeatable, measurable, auth-aware experiments

**Files:**
- Create: `experiments/alerts.ts`, `experiments/resources.ts`, `experiments/acceptance.ts`, `experiments/metrics.test.ts`, `experiments/acceptance.test.ts`
- Modify: `experiments/workload.ts`, `run.ts`, `metrics.ts`, `scenarios.ts`, `campaign.ts`

**Interfaces:**
- **Workload**:
  - if `/health` reports `endterm`, log in once as `bursar` and send `Authorization` on every request
  - every request sends `x-request-id: <runId>-<n>`, and `Rec` gains `rid` and `rateLimited` (status 429)
  - always send `Idempotency-Key` on payments (it already does)
- **Alerts**: `pollAlerts(promUrl, signal): Promise<AlertObs[]>` polls `GET /api/v1/alerts` every 1 s. It returns one `{name, firstPendingTs, firstFiringTs, resolvedTs|null}` per alert name seen.
- **Resources**: `sampleResources(signal): Promise<ResSample[]>` runs `docker stats --no-stream --format '{{json .}}'` every 2 s and returns `{ts, name, cpuPct, memMiB}`.
- **Metrics** add:
  - `response.avgMs`
  - `requests.errorRate`, `requests.rateLimited`
  - `throughput.preFaultRps`, `throughput.duringFaultRps`, `throughput.postRepairRps`
  - `alerts: {name, detectionMs: firstFiringTs - injectTs}[]`
  - `resources: {name, maxCpuPct, maxMemMiB}[]`
- **Consistency** adds key-level integrity. `run.ts` queries `select idempotency_key, state from payments`. Then:
  - `lostRecords` = intents acknowledged with 201/200 but not `completed` in the DB
  - `phantomRecords` = `completed` in the DB with no 2xx ack (allowed, but reported)
  - `duplicateCharges` is computed from the DB, as `completed` rows per intent > 1 (impossible by the UNIQUE constraint, so the check proves it) **plus** the existing client-side count
- **Scenario** type gains:
  - `kind: 'fault'|'security'|'monitoring'`
  - `expectedAlerts: {mustFire: string[], mayFire: string[]}`
  - `acceptance: Criterion[]`, where `Criterion = {id: string, describe: string, check: (m: RunResult) => boolean}`
  - `verify?: () => Promise<Record<string, unknown>>` for security checks
- `acceptance.evaluate(s: Scenario, r: RunResult) -> {id, describe, pass}[]`. Also `alertCorrectness(expected, observed) -> {correct: boolean, missing: string[], unexpected: string[]}`.
- **Known-state restore** (before every run): `dc start` all, reset chaos on every instance (`{latencyMs:0, failRate:0, crashAfterCheckpoint:false}`), `TRUNCATE payments; UPDATE students SET balance=0; DELETE FROM students WHERE id !~ '^s[0-9]+$'`, wait for health and replication, wait until Prometheus has **no firing alerts** (≤ 60 s), then record the restore outcome in `metrics.json`.
- **CLI**: `npm run exp <scenario> -- --rep N` writes to `logs/endterm/<scenario>__<mode>__r<N>/` and `reports/endterm/runs/<scenario>__<mode>__r<N>/metrics.json`. `npm run campaign -- --reps 3 [--only a,b]`.

- [ ] **Step 1:** Failing node tests:
  - `outages()` on a synthetic recs array with one 3 s gap → one outage of about 3 000 ms
  - `pct([...1..100], 95) === 95`
  - `consistencyFrom` reports `lostRecords === 1` when one acknowledged intent is missing from the DB rows
  - `alertCorrectness({mustFire:['A'],mayFire:['B']}, ['A','C'])` → `{correct:false, unexpected:['C']}`
  - `evaluate()` marks a criterion fail when its check returns false
- [ ] **Step 2:** `npm run test:harness` → FAIL → implement → PASS.
- [ ] **Step 3:** Smoke test on endterm: `npm run exp app-crash -- --rep 0`. `metrics.json` has `alerts`, `resources`, `consistency.lostRecords`, `restore` and an `acceptance` array, and the workload recs carry `rid`.
- [ ] **Step 4:** Commit `feat(experiments): auth-aware workload, alert/resource capture, key-level integrity, acceptance criteria, repetitions`.

### Task 15: Endterm scenarios and acceptance criteria

**Files:** Modify `experiments/scenarios.ts` (and `run.ts` for `verify`). Create `reports/endterm/TEST-PLAN.md`.

Keep the six midterm scenarios and add their `expectedAlerts` and `acceptance`. Add four new scenarios. The table is the exact criteria set. Each check reads `metrics.json`. "A" is request-based availability.

| # | Scenario | kind | Inject at 20 s / repair at 45 s | mustFire / mayFire | Acceptance (endterm target) |
|---|---|---|---|---|---|
| E1 | `app-crash` | fault | `/chaos/crash` student-1 | — / InstanceDown | A ≥ 99.9 %; dup = 0; lost = 0 |
| E2 | `db-failure` | fault | stop primary | DatabaseDown / HighErrorRate, InstanceDown | DatabaseDown detection ≤ 10 s; read availability ≥ 99 %; dup = 0; lost = 0 |
| E3 | `net-timeout` | fault | student-1 latency 3 000 ms | — / HighLatencyP95 | `duringFaultRps ≥ 0.7 × preFaultRps` (outlier ejection); p95 ≤ 1 000 ms |
| E4 | `node-failure` | fault | kill student-1 + payment-1 | InstanceDown / — | InstanceDown detection ≤ 10 s; A ≥ 99.9 %; dup = 0 |
| E5 | `txn-interrupt` | fault | crashAfterCheckpoint on both payment replicas | — / PaymentsStuckPending, HighErrorRate, InstanceDown | dup = 0; lost = 0; orphaned pending = 0 at end; ledger balanced |
| E6 | `high-load` | fault | ramp +100 workers | — / HighLatencyP95 | error rate ≤ 1 %; p95 ≤ 1 000 ms; rateLimited = 0; resources recorded |
| E7 | `gateway-failure` (new) | fault | `docker compose kill gateway-1` | InstanceDown / — | A ≥ 99.5 %; dup = 0; lost = 0 |
| E8 | `error-spike` (new, alert test) | monitoring | `failRate: 1.0` on student-1 **and** student-2 | HighErrorRate / InstanceDown | HighErrorRate detection ≤ 15 s; it resolves ≤ 30 s after repair; no unexpected alerts |
| E9 | `unauthorized-access` (new) | security | during the workload, the attack script listed below | AuthFailureSpike / — | every attack attempt denied (401/403); attacker-key payments in DB = 0; `evil-*` students = 0; audit events ≥ attempts; ledger balanced; legit A ≥ 99.9 % |
| E10 | `abuse` (new) | security | during the workload, the abuse script listed below | AuthFailureSpike / InstanceDown | 0 × 5xx caused by malformed input; burst gets 429 after the quota; brute force gets 429 after 5; all instances stay up; ledger balanced; legit A ≥ 99.9 % |

The E9 attack script, 60 attempts in total:
- no token (POST payment and POST student)
- a forged-signature token
- an expired token
- an `alg:none` token
- student `s7` paying for `s8`
- student `s7` creating student `evil-1`
- student `s7` listing all students

All attacks use the Idempotency-Key prefix `attack-`.

The E10 abuse script:
- 200 malformed payments from the Task 10 rejection list, plus invalid JSON, a 1 MiB body and a bad path segment
- a burst of 1 000 requests in 2 s with the `s7` token
- 50 logins with wrong passwords

- [ ] **Step 1:** Implement the four scenarios and the attack/abuse scripts as `inject` functions with `verify()` (DB queries via `psql`). Use `npx tsc`-free typing; the harness uses strip-types only.
- [ ] **Step 2:** Add node tests for the attack generator: `test attack set covers 7 categories` and `every attack request carries an attack- idempotency key`.
- [ ] **Step 3:** Smoke test every new scenario once on endterm with `--rep 0`. Confirm the acceptance array is populated and the restore succeeds between them.
- [ ] **Step 4:** Write `reports/endterm/TEST-PLAN.md`:
  - test levels (unit → integration → system/fault-injection)
  - one row per E1–E10: hypothesis, configuration, steps (exact commands), expected result, acceptance criteria (copied from the table), repetitions (3 per mode), known limitations
  - the unit and integration suites with what each covers
- [ ] **Step 5:** Commit `feat(experiments): gateway-failure, error-spike, unauthorized-access and abuse scenarios with acceptance criteria`.

### Task 16: Integration tests and CI

**Files:** Create `tests/integration/test_stack.py` and `.github/workflows/ci.yml`. Modify `package.json` (`"test": "pytest -q tests/unit && npm run test:harness"`).

**Interfaces:** Integration tests are marked `@pytest.mark.integration`. They skip unless `GET http://localhost:8080/health` reports `mode == "endterm"`.

- [ ] **Step 1:** Write:
  - `test_login_and_read_own_record`
  - `test_payment_idempotent_end_to_end` (same key twice → one completed row; balance +100 once)
  - `test_unauthorized_payment_denied_and_db_unchanged`
  - `test_malformed_payment_422_not_5xx`
  - `test_request_id_propagates_to_payment_service_log` (send rid; find it in `logs/events.jsonl` for both `svc=gateway-*` and `svc=payment-*`)
  - `test_app_role_cannot_truncate`
- [ ] **Step 2:** With the endterm stack up: `pytest -m integration -q` → PASS.
- [ ] **Step 3:** CI jobs (on push and PR):
  - `unit`: python 3.12, `pip install -r requirements-dev.txt`, `pytest -q tests/unit`
  - `harness`: node 22, `npm run test:harness`
  - `config`: `docker compose config -q`, `npm run test:alerts`, `promtool check config`, `nginx -t` on both confs
  - `deps`: `pip install pip-audit==2.7.3 && pip-audit -r requirements.txt` (the dependency-check control; record any finding in the report rather than hiding it)
  - optional `integration` job: `npm run up:endterm`, wait for health, `pytest -m integration`
- [ ] **Step 4:** Push and confirm the CI run is green. Paste the run link into the report appendix.
- [ ] **Step 5:** Commit `test(ci): integration suite and CI pipeline with config and dependency checks`.

### Task 17: Run the campaign and aggregate results

**Files:**
- Create: `experiments/aggregate.ts` (+ `aggregate.test.ts`), `experiments/snapshot.ts`
- Generated: `reports/endterm/RESULTS.md`, `reports/endterm/results.csv`, `reports/endterm/figures/*.png`, `logs/endterm/**`, `reports/endterm/runs/**`, `reports/endterm/OBSERVABILITY.md`

**Interfaces:**
- `aggregate(runs: RunResult[]) -> Row[]` groups by (scenario, mode). For each group:
  - `n`
  - mean ± sd of A (request and time), error rate, avg and p95 latency, detection and recovery
  - per-alert detection
  - alert correctness `k/n`
  - dup, lost and orphan totals
  - acceptance `passed/n` per criterion
  - overall verdict `PASS` only if every criterion passed in every repetition
- `snapshot.ts` uses Playwright, which is pre-installed (`require('playwright')`). It opens `http://localhost:3000/d/university?from=<t0>&to=<t1>&kiosk` and saves a 1600×1000 PNG at deviceScaleFactor 2.

- [ ] **Step 1:** Node test for aggregate: two synthetic runs with A = 0.99 and 1.0 → mean 0.995. One failing criterion in one repetition → verdict `FAIL (1/2)`.
- [ ] **Step 2:** Implement → PASS.
- [ ] **Step 3: Run the campaign.** This is about 2.5 h; 3 modes × 10 scenarios × 3 repetitions = 90 runs.
  - `npm run up:baseline && npm run campaign -- --reps 3`
  - `docker compose down -v && npm run up:midterm && npm run campaign -- --reps 3`
  - `docker compose down -v && npm run up:endterm && npm run campaign -- --reps 3`

  Run each mode from a fresh volume. Do not edit code mid-campaign. If a code fix is needed, re-run the affected mode in full and record why in `reports/endterm/EXPERIMENT-LOG.md`.
- [ ] **Step 4:** `node --experimental-strip-types experiments/aggregate.ts` → `RESULTS.md` and `results.csv`. `RESULTS.md` contains:
  - (a) a pass/fail table per scenario × mode
  - (b) a baseline vs midterm vs endterm comparison table for the spec §7 measurements
  - (c) the alerts table: fired, correct and detection delay
  - (d) an integrity table: lost, duplicate and orphan counts
- [ ] **Step 5:** Run `snapshot.ts` for one run of E2, E4, E8, E9 and E10 (endterm) → `figures/`.
- [ ] **Step 6:** Write `reports/endterm/OBSERVABILITY.md`. It walks one real incident end to end from the E2 endterm run, using real log lines with the same `rid` from nginx, the gateway and the services, the metric panel, and the alert timeline. This is "how an incident is detected and diagnosed".
- [ ] **Step 7:** Commit the data and reports: `feat(results): endterm campaign — 90 runs, aggregated results and dashboards`.

---

## Phase 5: Demonstration and report

### Task 18: Demonstration

**Files:** Modify `experiments/demo.ts`. Create `reports/endterm/DEMO.md` (script with expected output).

- [ ] **Step 1:** Add the demo scenarios:
  - `gateway-failure`: kill gateway-1 while a status histogram keeps showing 2xx
  - `outlier`: student-1 slow → ejected; show the gateway `/metrics` gauge
  - `unauthorized`: no token, forged token, and s7 paying for s8 → 401/403; show the audit lines by `rid`; DB unchanged
  - `abuse`: malformed → 422, burst → 429 with Retry-After, the instance stays healthy
  - `alerts`: print firing alerts from Prometheus during db-failure

  Every demo step prints the Grafana URL for the time window. The spec minimum is 3 scenarios including one service failure and one security test. The default demo order is `app-crash → db-failure → gateway-failure → unauthorized → abuse`.
- [ ] **Step 2:** Rehearse `npm run demo` on endterm, end to end. Record a screen capture as a fallback for the live demo, and link it in DEMO.md.
- [ ] **Step 3:** Commit `feat(demo): service failure, security and alerting scenarios`.

### Task 19: Endterm report and documentation

**Files:** Create `reports/endterm/REPORT.md`. Modify `reports/ARCHITECTURE.md` (new diagram: nginx → gateway-1/2 → services + auth → DB primary/standby, monitoring plane, trust boundaries), `README.md` (three modes, secrets, Grafana/Prometheus URLs, tests, campaign) and `app/fault_tolerance/README.md` (add E-numbered mechanisms: ejection, gateway redundancy, liveness/readiness).

- [ ] **Step 1:** Write the REPORT using exactly the spec §8 structure:
  1. Introduction and relationship to the midterm (list every major change since `midterm-final`)
  2. Updated requirements, assumptions, threat model (summary + link)
  3. Cloud/microservices architecture and resilience design (deployment and scaling strategy: replicas, restart policy, healthchecks, nginx failover, ejection, degradation; mapping to Kubernetes primitives as discussion only)
  4. Monitoring, logging, metrics, alerting
  5. Security controls and intrusion tolerance
  6. Verification and validation plan
  7. Fault-injection and security-test methodology
  8. Results and baseline vs midterm vs endterm comparison (tables from RESULTS.md, figures)
  9. Discussion, limitations, lessons learned
  10. Conclusion and references
  11. Appendix: links, configs, scripts, logs, CI run, individual contributions
- [ ] **Step 2:** Run a traceability check. Every bullet of spec §§3, 5, 6, 7 and 9 appears in a "Requirement → where implemented → evidence" table in §1 of the report, and every number in the report appears in `RESULTS.md` or a `metrics.json`. Script: `grep -oE '[0-9]+(\.[0-9]+)? ?(%|ms|s)\b' reports/endterm/REPORT.md` is spot-checked against `results.csv`.
- [ ] **Step 3:** Commit `docs: endterm technical report, architecture and run instructions`.

---

## Requirement → task traceability

| Spec item | Task(s) | Evidence |
|---|---|---|
| §3 cloud: gateway, discovery/config, replicas, health/readiness, LB, timeout/retry/breaker, degradation, scaling | 5, 6, 7 (+ midterm S1–S7, H1–H3) | ARCHITECTURE.md, compose, E1/E3/E4/E7 |
| §3 observability: logs, metrics, health, correlation IDs, dashboards, alerts, detection/recovery times | 2, 3, 4, 14 | OBSERVABILITY.md, figures/, ALERTS.md, E8 |
| §3 security: authN/Z, validation, secrets, rate limiting, audit, safe failure, least privilege | 8–13 | THREAT-MODEL.md, E9, E10 |
| §3 V&V: unit/integration/system tests, acceptance criteria, repeatable FI, workload, integrity, comparison | 1, 14–17 | TEST-PLAN.md, CI, RESULTS.md |
| §4 continuity, baseline retained | 0 | `midterm-final` tag, three `up:*` modes |
| §5.1–5.5 | 5–7, 3, 4, 8–12, 1/16 | as above |
| §6 ≥6 experiments, ≥4 fault, ≥2 security, restore state | 14, 15 | E1–E8 fault/monitoring, E9–E10 security |
| §7 measurements | 14, 17 | RESULTS.md |
| §9 deliverables (demo: ≥3 incl. service failure + security) | 18, 19 | DEMO.md, recording |

## Suggested split (for the individual-contribution criterion)

The two tracks only meet at Task 14. Suggested split:
- **Aibyn:** Phases 0–2 (Tasks 0–7), plus Tasks 14 and 17
- **Gani:** Phase 3 (Tasks 13, 8–12), plus Tasks 15 and 16

Do Tasks 18 and 19 together. Each person writes the report sections for their own tasks.
