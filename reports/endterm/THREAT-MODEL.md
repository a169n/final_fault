# Threat model

This is the threat model for the endterm system (spec §3, "Security, Resilience, and Intrusion Tolerance", and §8, "Updated requirements, assumptions, and threat model"). It sets out what we protect, from whom, where the trust boundaries are, which threats cross each boundary, and which control answers each threat. Every control has a test or an experiment that shows it working. Each one is a unit test (`tests/unit/…`), an integration test (`tests/integration/…`), a configuration check, or a fault-injection or security experiment (E1–E10, see `reports/endterm/TEST-PLAN.md`).

**When it was written.** We wrote this document before the security controls were built (plan Task 13, which comes before Tasks 8–12). The control and test names below are the design that Tasks 8–12 implement. Section 9 marks which controls existed when this was written. The endterm report (§5) and `RESULTS.md` record the measured outcomes. This document makes no claim that any control works. Only the named test or experiment can show that.

**Method.** We use STRIDE (Spoofing, Tampering, Repudiation, Information disclosure, Denial of service, Elevation of privilege) for each trust boundary of the data-flow diagram below. Threats are numbered `<boundary>.<letter><n>`, for example `B1.S1`.

**Scope of testing.** We test only the local Docker Compose stack, with synthetic data (spec §4). We attack nothing else.

---

## 1. System and data flows

```text
                         untrusted                                  │ host (operator)
 ┌──────────────┐  B1  ┌──────────────┐  B2  ┌────────────────────┐ │  .env (secrets, 0600, git-ignored)
 │ client       │─────▶│ nginx :8080  │─────▶│ gateway-1, gateway-2│ │  docker / docker exec
 │ (browser,    │ HTTP │ (only public │      │ PEP: authn, authz, │ │  logs/events.jsonl (shared volume)
 │  harness,    │      │  port)       │      │ validation, rate   │ │  127.0.0.1-only ports: gateways,
 │  attacker)   │      └──────────────┘      │ limit, audit       │ │   services, DB, Prometheus, Grafana
 └──────────────┘                            └─────────┬──────────┘ │
                                                       │ B3 (compose network, plain HTTP)
                    ┌──────────┬──────────┬────────────┼────────────┬─────────────┐
                    ▼          ▼          ▼            ▼            ▼             │
                 auth-1    student-1/2 payment-1/2 transcript-1 timetable-1/2      │
                 (JWTs)        │          │            │            │             │
                    └──────────┴──────────┴─────┬──────┴────────────┘             │
                                                │ B4 (libpq)                       │
                              ┌─────────────────▼───┐  streaming  ┌──────────────┐ │
                              │ postgres-primary    │────────────▶│ postgres-    │ │
                              │ (only writable copy)│ replication │ replica      │ │
                              └─────────▲───────────┘             └──────────────┘ │
                                        │ pg_monitor (stats only)                  │
                    prometheus ◀── postgres-exporter, /metrics of every app instance│
                    grafana    ◀── prometheus                                       │
                                                                         B5: host ─┘
```

- **B1:** client → nginx. This is the only boundary the public crosses. In endterm, nginx publishes `:8080` and every other published port is bound to `127.0.0.1` (Task 12).
- **B2:** nginx → gateways. Here nginx hands the request to the policy enforcement point (PEP). nginx sets `X-Forwarded-For` and `X-Request-ID`.
- **B3:** gateway → services, and gateway → `auth-1`. This traffic stays on the compose network, as plain HTTP with no service-to-service authentication.
- **B4:** services → PostgreSQL, plus primary → standby replication and exporter → primary.
- **B5:** the host. This covers the Docker daemon, `.env`, the shared `logs/` volume, the loopback-only ports (direct gateway and service ports, Prometheus, Grafana, the DB) and the operator's tools (`npm run …`, `docker exec … psql`).

## 2. Assets

| # | Asset | Where it lives | Property we protect | Impact if it is lost |
|---|---|---|---|---|
| A1 | Student ledger and balances | `students.balance` | integrity | Wrong balances, money credited to the wrong student |
| A2 | Grades and transcripts | `grades`, transcript service (S7 cache) | confidentiality, integrity | Privacy breach, forged academic record |
| A3 | Payments table | `payments` (`idempotency_key UNIQUE`, `state`) | integrity (no duplicate, no lost record), confidentiality | Double charge, lost payment, one student seeing another's payments |
| A4 | Credentials and the JWT signing secret | `app_users.password_hash` (scrypt), `JWT_SECRET`, DB role passwords, `CHAOS_TOKEN`, `GRAFANA_ADMIN_PASSWORD` in `.env` | confidentiality | Anyone can mint tokens or log in to the DB. Every other control is bypassed |
| A5 | Availability of the API | nginx, gateways, service replicas, DB primary and standby | availability | Students and staff cannot work. Failures in the midterm experiments |
| A6 | Audit and observability evidence | `logs/events.jsonl` (`kind="audit"`), Prometheus TSDB | integrity, availability | An incident cannot be detected, diagnosed or attributed |

## 3. Actors

| Actor | Capability | In scope? |
|---|---|---|
| **Anonymous internet client** | Can send any HTTP request to `:8080`: no token, forged tokens, malformed bodies, floods, brute-force logins | yes |
| **Authenticated student** (`s7`, `s8`) | Holds a valid token for their own `student_id`. Tries to read or change other students' data, or perform staff or admin actions | yes |
| **Compromised student token** | An attacker replays a stolen, valid student token until it expires (900 s) | yes. The damage is bounded by the student's own permissions and rate limit (see R3) |
| **Faulty or crashing component** | Instances crash, hang, slow down or lose the DB (the midterm fault model) | yes. Covered by the fault experiments E1–E8 |
| **Malicious insider on the host** | Has root, the Docker socket, `.env`, `docker exec` into Postgres as superuser | **no, out of scope**. Such an actor owns every asset. We only reduce accidental exposure: loopback-only ports, generated secrets, least-privilege app role |
| **Attacker on the compose network** (a compromised container) | Can call services and the DB directly, bypassing the gateway | partly. Least-privilege DB role and service-side validation limit the damage. No mTLS, so see R1 |

## 4. Assumptions

1. The host, the Docker daemon and the base images (`python:3.12-slim`, `postgres:16`, `nginx:1.27-alpine`, the pinned monitoring images) are trusted.
2. The deployment is a single host for the course. The public listener is plain HTTP on `:8080`. A real deployment would terminate TLS at nginx (R7).
3. `.env` is generated per install by `npm run up:<mode>` (Task 0). It is git-ignored and never committed. `.env.example` holds placeholders only.
4. Demo users (`admin`, `bursar`, `s7`, `s8`) share the generated `DEMO_PASSWORD`. They exist only to exercise roles on synthetic data.
5. All security *behaviour* is gated by `ENDTERM_ENABLED=1`. Baseline and midterm keep the midterm's open behaviour on purpose, so that the comparison measures the controls (see §8). Credential hygiene (generated DB passwords, least-privilege roles) is on in every mode.

## 5. STRIDE by trust boundary

Columns:
- **Control** gives the mechanism and the plan task that builds it. "T0" to "T12" are plan tasks. "S5", "S6" and "H2" are midterm mechanisms (`app/fault_tolerance/README.md`).
- **Evidence** is the test or experiment that demonstrates the control. Unit tests live in `tests/unit/`, integration tests in `tests/integration/test_stack.py`, and experiments are in `experiments/scenarios.ts`.

### B1: client → nginx (public, untrusted)

| ID | STRIDE | Threat | Control | Evidence |
|---|---|---|---|---|
| B1.S1 | Spoofing | A request with no token calls a protected route (for example `POST /api/payments`) | The gateway requires `Authorization: Bearer` on every `/api/*` route and fails closed: no principal → 401 (T9) | `test_gateway_returns_401_without_token_in_endterm`, `test_policy_matrix` (anonymous column), E9 "no token" attacks |
| B1.S2 | Spoofing | A forged token: wrong signature, `alg: none`, expired, or another audience | HS256 verified locally with `algorithms=["HS256"]` only, plus `iss`/`aud`/`exp` checks. Every failure raises `TokenError` → 401 (T8, T9) | `test_verify_rejects_bad_signature`, `test_verify_rejects_alg_none`, `test_verify_rejects_expired`, `test_verify_rejects_wrong_audience`; E9 forged, expired and `alg:none` attacks |
| B1.S3 | Spoofing | Credential stuffing or brute force on `POST /auth/token` | scrypt hashes (`n=2**14,r=8,p=1`, salted) with `hmac.compare_digest`. The same 401 for an unknown user and a wrong password (no user enumeration). Per-client-IP limit of 1/s, burst 5 → 429. Every login, success or failure, is audited. `AuthFailureSpike` alert (T8, T9, T11, T4) | `test_password_roundtrip_and_wrong_password`, `test_hash_is_salted`, `test_login_bruteforce_limited_after_5`; E10 "50 wrong logins" (429 after 5; `AuthFailureSpike` must fire) |
| B1.S4 | Spoofing | A client spoofs `X-Forwarded-For` to get a fresh per-IP login quota on every request | nginx **overwrites** `X-Forwarded-For` with `$remote_addr` (both nginx configs, T7). The gateway keys the login limiter on the first XFF value (T11) | `config/nginx/*.conf` (`proxy_set_header X-Forwarded-For $remote_addr`); E10 brute force through `:8080`. Bypassing nginx from the host: R10 |
| B1.T1 | Tampering | Malicious payment or student input: negative, zero or huge amounts (`1e9` overflows `NUMERIC(10,2)` → 5xx in midterm), too many decimal places, SQL in `studentId`, extra fields, control characters in names | Strict pydantic models with `extra='forbid'`, patterns and ranges → 422 `{"error":"invalid input"}`. Checked at the services when endterm is on (T10). Every SQL statement is parameterised (`%s`, midterm) | `test_payment_rejects[*]` (−1, 0, 10000.01, 1e9, "abc", 1.001, `s1'; DROP TABLE students;--`, "", "S1", extra field), `test_payment_accepts_valid`, `test_student_name_rejects_control_chars`, `test_malformed_payment_422_not_5xx`; E10 "0 × 5xx caused by malformed input" |
| B1.T2 | Tampering | Path traversal or junk in path segments (`/api/students/../..`, 10 KB ids) | The gateway rejects any segment that does not match `^[A-Za-z0-9._-]{1,64}$` with 400, before any upstream call (T10). The `pool` path parameter is an enum, so an unknown pool → 404 (midterm) | `test_gateway_rejects_bad_path_segment_400`; E10 "bad path segment" |
| B1.T3 | Tampering | Log injection through a hostile `X-Request-ID` (newline, 10 KB, non-ASCII) forges or corrupts log lines | `accept_request_id`: only `[A-Za-z0-9._-]{8,64}` (fullmatch) is kept. Anything else is replaced by a fresh UUID before it reaches a log (T2) | `test_hostile_request_id_replaced` (exists) |
| B1.T4 | Tampering | A replayed or re-sent payment charges twice. Example: the client retries, or nginx re-sends a POST to gateway-2 after gateway-1 died mid-request | The client must send an `Idempotency-Key` on `POST /api/payments` (400 without one, T7). `payments.idempotency_key UNIQUE` plus checkpoint/rollback (S5, S6) | `test_payment_without_idempotency_key_rejected` (exists), `test_payment_idempotent_end_to_end`; E7 gateway-failure and E5 txn-interrupt (`duplicateCharges = 0`, `lostRecords = 0`) |
| B1.T5 | Tampering, information disclosure | A student re-uses another student's `Idempotency-Key` (known or guessed) on a payment for themselves. Before the final-review fix, the duplicate path answered with the stored payment (the other student's id, amount and state) and a 2xx, and the caller's own payment was silently not made | In endterm the duplicate path returns the stored payment only if it has the same `student_id` and amount; otherwise 409 with no data from the stored row (`app/fault_tolerance/software/idempotency.py`, REPORT.md §5.5). A key used first by an attacker still blocks the victim's later payment under that key (409, not a silent success); client keys are random UUIDs, so this needs the key | `test_other_students_key_refused_in_endterm`, `test_same_student_different_amount_refused_in_endterm`; integration `test_idempotency_key_of_another_student_refused` |
| B1.R1 | Repudiation | A user denies making a payment, or an attacker's probing leaves no trace | `audit.record(...)` writes `kind="audit"` with `rid`, `sub`, `role`, action, outcome and reason for every deny, every payment allow, every admin action and every login. The same `rid` appears on the nginx, gateway and service lines (T2, T9) | `test_audit_event_has_no_secrets`, `test_request_id_propagates_to_payment_service_log`; E9 "audit events ≥ attempts" |
| B1.I1 | Information disclosure | A student reads another student's record, transcript or payments, or lists all students | Authorization matrix (T9): a student may `GET` only their own `/students/{id}` and `/transcripts/{id}`. Listing students and `GET /payments/{key}` are staff or admin only | `test_policy_matrix` (32 cases); E9 "`s7` listing all students"; `test_login_and_read_own_record` |
| B1.I2 | Information disclosure | Internal endpoints reached through the public entry: `/metrics` (topology, instance names) and `/chaos`, either directly or as the `{param}` of a route (`/api/timetables/openapi.json` is forwarded to the timetable service's own `/openapi.json`) | In endterm nginx returns 404 for `/metrics` and `/chaos*` (T7, `redundant.conf`). `/chaos*` also requires `x-chaos-token` (T12). The policy denies `health`, `metrics`, `chaos`, `docs`, `redoc` and `openapi.json` in the parameter position (403 `no_rule`). **Accepted:** the gateway's own API documentation (`/docs`, `/redoc`, `/openapi.json`) stays reachable through nginx on purpose (README: Swagger UI at `/docs`). It describes the public API and lists `/metrics` and `/health/*`, which nginx blocks or which hold no data; it exposes no secret | `config/nginx/redundant.conf`; `test_chaos_requires_token_in_endterm`; `test_routes_outside_the_matrix_are_denied`; integration `test_upstream_endpoints_not_reachable_through_a_param` |
| B1.I3 | Information disclosure | Secrets in logs: the password from a failed login, the bearer token | `audit.record` never serialises a password, a token or the `Authorization` header. The gateway does not forward `Authorization` upstream: it sends only `content-type`, `idempotency-key` and `x-request-id` (T9; `app/services/gateway.py`) | `test_audit_event_has_no_secrets` (no `hunter2`, no `Bearer`) |
| B1.D1 | Denial of service | A request flood from one principal (E10: 1 000 requests in 2 s with the `s7` token), or a walk over many distinct paths that grows the gateway's stale cache | The stale cache (S7) keeps only 2xx answers and at most 10 000 paths, least recently stored evicted first (`STALE_MAX_ENTRIES`; `test_stale_cache_is_bounded_lru`). Token bucket per `sub`+role. Student 10/s burst 20; staff 5 000/s; admin 1 000/s → 429 with `Retry-After`, `rate_limited_total{scope}`, an audit deny (T11). Two gateways (T7). The legitimate workload is not throttled | `test_bucket_allows_burst_then_limits`, `test_bucket_refills_over_time`, `test_keys_are_independent`, `test_staff_quota_absorbs_high_load_peak`; E10 burst (429 after the quota; legitimate availability ≥ 99.9 %), E6 high-load (`rateLimited = 0`) |
| B1.D2 | Denial of service | Oversized or non-JSON bodies use up memory and parser time | Gateway: body > 16 384 bytes → 413; non-JSON POST → 400 (T10). nginx's default `client_max_body_size 1m` is a second cap | `test_gateway_rejects_oversized_body_413`; E10 "1 MiB body", "invalid JSON" (all instances stay up) |
| B1.E1 | Elevation of privilege | A student performs a staff or admin action: pays for another student, creates a student (`evil-1`), starts a timetable job | Authorization matrix (T9). A payment by a student is allowed only if `body.studentId == student_id`. `POST /students` and `POST /timetables` are admin only. Fail closed: any exception in verify or authorize → 401/403 | `test_policy_matrix`, `test_policy_fails_closed_on_exception`, `test_unauthorized_payment_denied_and_db_unchanged`; E9 "`s7` pays for `s8`", "`s7` creates `evil-1`" (attacker-key payments in DB = 0, `evil-*` students = 0, ledger balanced) |
| B1.E2 | Elevation of privilege | A student edits the `role` or `student_id` claim inside the token | The claims are covered by the HS256 signature. A modified token fails verification → 401 (T8) | `test_verify_rejects_bad_signature`; E9 forged token |

### B2: nginx → gateways

| ID | STRIDE | Threat | Control | Evidence |
|---|---|---|---|---|
| B2.S1 | Spoofing | A caller skips nginx and talks to a gateway directly, avoiding its blocked paths and XFF overwrite | The gateway ports `8081`/`8082` are published on `127.0.0.1` only (T7). The gateway enforces authentication, authorization, validation and rate limits itself, so skipping nginx does not skip the PEP | `docker-compose.yml` port bindings; R10 for the remaining XFF gap |
| B2.T1 | Tampering | nginx re-sends a non-idempotent POST to the second gateway (`proxy_next_upstream … non_idempotent`). This double charges if a gateway made up the key | In endterm a payment needs a client-supplied `Idempotency-Key`, so both attempts carry the same key and S5 returns the original payment (T7). Student and timetable POSTs are upserts on a natural key | `test_payment_without_idempotency_key_rejected`; E7 (`duplicateCharges = 0`) |
| B2.R1 | Repudiation | Failover splits one request across two gateways, so it cannot be traced | nginx sets one `X-Request-ID` (the client's, or its own `$request_id`) and reuses it on the retry (T2, T7) | `config/nginx/redundant.conf` (`map $http_x_request_id $rid`); `test_request_id_propagates_to_payment_service_log` |
| B2.D1 | Denial of service | The gateway is a single point of failure: crash, kill or hang | Two gateways. nginx fails over on error or timeout (`proxy_connect_timeout 1s`, `max_fails=1 fail_timeout=5s`). The restart policy restarts the dead one (T5, T7) | E7 gateway-failure (A ≥ 99.5 %; `InstanceDown` must fire) |

### B3: gateway → services and `auth-1` (compose network)

| ID | STRIDE | Threat | Control | Evidence |
|---|---|---|---|---|
| B3.S1 | Spoofing | A compromised container, or anything else on the compose network, calls a service directly and skips the PEP. Services do not verify JWTs | **Partly mitigated.** Services validate their own input in endterm (T10, defence in depth). They connect to the DB as least-privilege `app_rw` (T12). Their host ports are bound to `127.0.0.1` (T12). There is no mTLS and no service-to-service authentication | Task 12 port check; `test_app_role_cannot_truncate`. Residual: **R1** |
| B3.T1 | Tampering | Internal HTTP is modified in transit | Not mitigated (plain HTTP on a single-host bridge network) | Residual: **R1** |
| B3.E1 | Elevation of privilege | Anyone who can reach a service's `/chaos` endpoint can crash it, slow it down or fail requests | In endterm `/chaos*` requires `x-chaos-token == CHAOS_TOKEN`, compared with `hmac.compare_digest`. Otherwise 403 plus an audit event (T12). nginx also blocks `/chaos` (B1.I2) | `test_chaos_requires_token_in_endterm`, `test_chaos_token_compare_constant_time`, `test_chaos_open_in_midterm` |
| B3.I1 | Information disclosure | Bearer tokens leak to downstream services or their logs | The gateway forwards only `content-type`, `idempotency-key` and `x-request-id` upstream. The token stops at the PEP (`app/services/gateway.py`, `proxy`) | Code review of `proxy`; `test_audit_event_has_no_secrets` |
| B3.D1 | Denial of service | `auth-1` is down, so nobody can log in | The gateway verifies tokens locally with `JWT_SECRET`, so an `auth-1` outage blocks only *new* logins and existing sessions keep working (graceful degradation). Token requests go through the same retry and breaker path (T8) | The experiment note in Task 8 (stop `auth-1`, the workload with an existing token keeps succeeding) |
| B3.D2 | Denial of service | A slow or failing replica (or one under attack) drags the pool down | Timeouts, bounded retries, a circuit breaker (midterm S1–S4). Per-instance outlier ejection (T6). Readiness vs liveness (T5) | `test_outlier_ejection.py`, `test_circuit_breaker.py`, `test_retry.py`; E3 net-timeout, E8 error-spike |

### B4: services → PostgreSQL

| ID | STRIDE | Threat | Control | Evidence |
|---|---|---|---|---|
| B4.S1 | Spoofing | Anyone who can reach port 55432 logs in as any role. The midterm `pg_hba.conf` is `trust` for every host and `POSTGRES_PASSWORD: postgres` | `scram-sha-256` for every `host` line. Passwords come from `.env` (generated). `POSTGRES_HOST_AUTH_METHOD: trust` is removed. DB ports are bound to `127.0.0.1`. Only `local all postgres trust` stays, for the operator's `docker exec` (T12) | Task 12 step 2. `grep -rn "replpass\|password: postgres" docker-compose.yml config/` → empty |
| B4.T1 | Tampering | SQL injection through `studentId`, `term` or `name` | Every query is parameterised (`%s` placeholders; midterm). Input patterns (T10) | `test_payment_rejects[s1'; DROP TABLE students;--]`; E10 |
| B4.T2 | Tampering | A compromised or buggy service issues destructive SQL (`TRUNCATE`, `DELETE`, `DROP`), or changes a user's role or password hash in `app_users` | The application role `app_rw` has only SELECT/INSERT/UPDATE on the business tables, SELECT/INSERT on `app_users` (no UPDATE) and SELECT on reference tables. It has no DELETE, TRUNCATE or DDL (T12, `config/postgres/init/90-grants.sql`). All services share this role: R16 | Task 12 step 2: `TRUNCATE payments` as `app_rw` → `permission denied`; `test_app_role_cannot_truncate`, `test_app_role_cannot_change_users` |
| B4.T3 | Tampering | Faults during a payment leave duplicate or lost records, or an unbalanced ledger | `idempotency_key UNIQUE`, a checkpoint before the charge, an atomic charge transaction, and a rollback sweep for stale pending payments (S5, S6). Key-level integrity check in the harness (T14) | E5 txn-interrupt (dup = 0, lost = 0, orphaned pending = 0, ledger balanced); `consistency.*` in every run's `metrics.json` |
| B4.I1 | Information disclosure | Hard-coded credentials in the repository (`CREATE ROLE repl … 'replpass'`) | The `repl` role and its password are created by `00-roles.sh` from `REPL_PASSWORD` (T12). The monitoring role `monitor` has only `pg_monitor`, so it sees statistics and no table data (T4, exists) | The `grep` check above; `config/postgres/init/00-roles.sh` |
| B4.D1 | Denial of service | The primary is down | Reads fail over to the hot standby, writes fail fast, and the breaker opens (H2, midterm). `DatabaseDown` alert (T4) | E2 db-failure (`DatabaseDown` detection ≤ 10 s; read availability ≥ 99 %) |

### B5: host and operator

| ID | STRIDE | Threat | Control | Evidence |
|---|---|---|---|---|
| B5.I1 | Information disclosure | Secrets get committed, or are the same on every install | Secrets are generated per install as 24 random bytes (base64url) into a git-ignored `.env`. Existing values are kept so volumes keep working. `.env.example` holds placeholders only (T0, T12) | `experiments/env.test.ts` ("missing secrets are generated…", "generated secrets are distinct"); `.gitignore` |
| B5.I2 | Information disclosure | Internal ports (services, DB, Prometheus, Grafana) are reachable from the network | Every published port except nginx `8080` is bound to `127.0.0.1` (T12). Grafana anonymous users are Viewers only, and the admin password is generated (T4) | `docker compose config` port list (Task 12); R11 |
| B5.T1 | Tampering | A vulnerable dependency | Every dependency and image is pinned to an exact version (direct dependencies in `requirements.txt`, every installed package in `constraints.txt`, used with `-c` by the Dockerfile and CI). `pip-audit` runs in CI (T16). Findings are recorded in the report, not hidden. The control found 24 advisories (17 in PyJWT 2.10.1, 7 in Starlette 0.41.3 via FastAPI 0.115.6); they were fixed by upgrading to PyJWT 2.15.1, FastAPI 0.162.2 and Starlette 1.10.0 (REPORT.md §5.4). The image's own `pip` is not covered: R14 | CI job `deps`; `reports/endterm/security/pip-audit-before.json` (24 findings), `pip-audit-after.json` (none) |
| B5.R1 | Repudiation | Audit lines are edited or deleted on the host | Not mitigated: audit events share `logs/events.jsonl` with the application logs, and every service can write to it | Residual: **R6** |
| B5.E1 | Elevation of privilege | The operator's reset (`TRUNCATE payments`) or `docker exec` as superuser | By design this is an operator action on the host. The harness uses the superuser over `docker exec`, never the `app_rw` network role, and documents why (T12 step 3). A malicious insider is out of scope | `experiments/run.ts` comment |

## 6. Controls summary (spec §5.4: at least three)

| Control (spec category) | Implemented in | Threats | Main evidence | On in |
|---|---|---|---|---|
| Authentication (JWT, scrypt) | T8 `app/security/tokens.py`, `passwords.py`, `app/services/auth.py` | B1.S1–S3, B1.E2 | `test_verify_rejects_*`, E9 | endterm |
| Authorization (policy matrix, fail closed) | T9 `app/security/policy.py`, gateway | B1.I1, B1.E1 | `test_policy_matrix`, `test_policy_fails_closed_on_exception`, E9 | endterm |
| Audit logging | T9 `app/security/audit.py` | B1.R1, B1.I3 | `test_audit_event_has_no_secrets`, E9 | endterm |
| Input validation and request limits | T10 `app/security/validation.py`, gateway, services | B1.T1, B1.T2, B1.D2, B4.T1 | `test_payment_rejects`, `test_gateway_rejects_*`, E10 | endterm |
| Rate limiting and abuse protection | T11 `app/security/rate_limit.py`, gateway | B1.S3, B1.D1 | `test_bucket_*`, `test_login_bruteforce_limited_after_5`, `test_staff_quota_absorbs_high_load_peak`, E10, E6 | endterm |
| Duplicate-request protection | T7 gateway (`Idempotency-Key` required); S5/S6 | B1.T4, B2.T1, B4.T3 | `test_payment_without_idempotency_key_rejected`, E5, E7 | key required: endterm; S5/S6: midterm and endterm |
| Secure secrets handling | T0 `experiments/env.ts`; T12 compose, `00-roles.sh`, `pg_hba.conf` | B4.S1, B4.I1, B5.I1 | `env.test.ts`, Task 12 grep and psql checks | every mode |
| Least privilege | T12 `app_rw`, `repl`, `monitor`; loopback ports; T4 `monitor` | B4.T2, B3.S1 (partly), B5.I2 | `test_app_role_cannot_truncate`, `test_app_role_cannot_change_users`, Task 12 `TRUNCATE` check; limits: R15, R16 | every mode |
| Chaos endpoint lockdown | T12 `app/fault_injection.py`; T7 nginx | B1.I2, B3.E1 | `test_chaos_requires_token_in_endterm`, `test_chaos_token_compare_constant_time` | endterm (the harness in baseline and midterm needs it open) |
| Log-injection-safe correlation IDs | T2 `app/core/context.py` | B1.T3, B2.R1 | `test_hostile_request_id_replaced` | every mode |
| Dependency and configuration checks | T16 CI: `pip-audit`, `promtool`, `nginx -t`, `docker compose config` | B5.T1 | `pip-audit` before and after the upgrade (`reports/endterm/security/`); post-upgrade E1, E2, E9, E10 runs (`reports/endterm/post-upgrade/`); the jobs' commands run locally (`reports/endterm/security/post-upgrade-checks.log`, `post-review-checks.log`). No GitHub Actions run exists: Actions did not run because the repository owner's account is locked for billing (REPORT.md §11.5) | CI (run locally) |
| Detection of attacks | T4 `AuthFailureSpike` (> 2 denials/s over 30 s) | B1.S1–S3, B1.E1 | `alerts.test.yml`; E9 and E10 must fire it | every mode (it only has data in endterm) |

## 7. Intrusion tolerance: what limits the damage when a control is bypassed or fails

The aim is not only to block an attack but to keep it contained, visible and recoverable:

- **Fail closed.** If token verification or the policy throws, the gateway answers 401/403. It never passes the request through (`test_policy_fails_closed_on_exception`).
- **Bounded blast radius of a stolen token.** A token lives at most 900 s. It carries one role and, for a student, one `student_id`, so it can pay only into that student's own ledger and read only their own record. It is rate-limited per `sub` (student 10/s).
- **Defence in depth on writes.** Even if the PEP is skipped (B3.S1), services validate their input in endterm, and the DB role cannot delete or truncate. `UNIQUE(idempotency_key)` makes a duplicate charge impossible at the storage layer.
- **Availability under attack.** Two gateways, rate limits sized so the legitimate peak is not throttled (Review Focus 1), and validation in front of the DB, so malformed input cannot become a 5xx. E10 measures legitimate availability (≥ 99.9 %) while the attack runs.
- **Detect and diagnose.** Every deny increments `auth_denied_total{reason}` and writes an audit event with `rid` and `sub`. `AuthFailureSpike` fires on a probing or brute-force burst, and the operator follows the `rid` across nginx, gateway and service logs (`reports/endterm/ALERTS.md`).
- **Recover.** After an attack, a ledger-balance check and the key-level integrity check (T14) confirm that no data changed. E9 checks "attacker-key payments = 0, `evil-*` students = 0, ledger balanced".

## 8. Mode applicability

| Behaviour | baseline | midterm | endterm |
|---|---|---|---|
| Authentication, authorization, audit, validation, rate limits, required `Idempotency-Key`, chaos token, nginx blocking `/metrics` and `/chaos` | off | off | **on** |
| Generated secrets, DB passwords and least-privilege roles, loopback-only ports, correlation IDs, metrics, alerts | on | on | on |

Baseline and midterm are deliberately open. They are the comparison points for E9 and E10, where the attacks are expected to succeed (or to cause 5xx, for `amount: 1e9`) and that outcome is recorded as measured. The credential hygiene runs in every mode because it does not change any behaviour under test (Global Constraints of the plan).

## 9. Status at the time of writing

These controls already existed when this document was written:
- correlation-ID sanitisation (T2)
- the required payment `Idempotency-Key` and nginx blocking `/metrics` and `/chaos` in endterm (T7)
- loopback-only ports for the gateways and the monitoring plane (T4, T7)
- generated secrets in `.env` (T0)
- the `monitor` role (T4)
- S5/S6/H2 from the midterm

When this was written, PostgreSQL still used `trust` with the password `postgres`, and the service and DB ports were still published on every interface. B4.S1, B4.I1 and B5.I2 describe that gap, and Task 12 closes it. Every other control in §5 and §6 is built by Tasks 8–12.

## 10. Residual risks

| # | Residual risk | Why we accept it here | What a production deployment would do |
|---|---|---|---|
| R1 | **Services trust the internal network.** There is no mTLS and no service-to-service authentication. Anything on the compose network can call a service directly and skip the PEP (B3.S1, B3.T1) | One host, one bridge network, no untrusted containers. Service-side validation and the least-privilege DB role limit the damage | mTLS through a service mesh, or JWT verification at each service. Network policies so that only the gateways reach the services |
| R2 | **Rate-limit state is per gateway.** With two gateways the effective cluster limit is up to 2× the configured quota. A gateway restart resets its buckets | It keeps the limiter local and fast, with no shared dependency that could itself fail. 2× is still far below what the services can absorb | A shared limiter (Redis) or limits at nginx (`limit_req`) |
| R3 | **No token revocation.** A stolen token is valid until `exp` (≤ 900 s). A role change or a deleted user takes effect only when the token expires | The short lifetime bounds exposure. Rotating `JWT_SECRET` revokes every token at once | A deny-list of `jti` values, refresh tokens with server-side sessions, shorter access-token lifetimes |
| R4 | **Secrets are in environment variables, not a vault.** They are visible to `docker inspect`, `/proc/<pid>/environ` and anyone who can read `.env`. There is no automated rotation | The host is trusted (assumption 1). The secrets are generated per install and never committed | Docker or Kubernetes secrets mounted as files, or a vault with short-lived DB credentials and rotation |
| R5 | **One symmetric signing key** (HS256) is shared by `auth-1` and both gateways. Whoever compromises a gateway can mint tokens | Simple, and there are only three holders, all inside the trust zone | RS256 or EdDSA: only `auth` holds the private key, and the gateways verify with the public key |
| R6 | **The audit log is not tamper-evident.** It shares `logs/events.jsonl` with the application logs, and every service can write to it | It is enough for detection and diagnosis in the experiments | Ship the log to an append-only store, hash-chain the audit events, and keep them separate from the application logs |
| R7 | **No TLS on the public listener** (`:8080`, plain HTTP). Tokens and passwords cross B1 in cleartext | Local, single-host course deployment with synthetic data | TLS termination at nginx, HSTS |
| R8 | **Error bodies can carry exception text.** The service middleware returns `{"error": str(exc)}` on an unexpected exception or upstream error. T10 removes the known malformed-input path (`1e9` overflow), but other faults can still leak driver messages | No credentials appear in these messages. Removing them would cost diagnosis in the experiments | Generic error bodies with the `rid`, and details only in the logs |
| R9 | **No account lockout.** Brute force is slowed per client IP (1/s, burst 5), not per account. A distributed attack from many addresses is limited only by scrypt cost and the `AuthFailureSpike` alert | A per-account lockout would let anyone lock out a known user (a DoS against that user) | Per-account exponential back-off, CAPTCHA or MFA, IP-reputation lists |
| R10 | **The XFF trust on the direct gateway ports.** A client on the host who calls `127.0.0.1:8081` directly can set its own `X-Forwarded-For` and evade the per-IP login limit | Host access is out of scope (malicious insider) | The gateway trusts XFF only from nginx's address, or listens only on the internal network |
| R11 | **Prometheus has no authentication, and Grafana allows anonymous Viewer access** on the loopback ports. Metrics reveal topology and load | Loopback only. Metrics hold no personal data | Authentication in front of the monitoring plane, with SSO for Grafana |
| R12 | **`local all postgres trust`** stays so that the operator and the harness can reset state through `docker exec` | It needs host access, which is already out of scope | Use a separate admin role with a password, and make break-glass access an audited procedure |
| R13 | **Volume denial of service beyond one host's capacity** (DDoS), slow-request attacks (slowloris) against nginx's default timeouts | Out of scope for a single-host course stack. nginx defaults apply | An upstream CDN or DDoS protection, tuned `client_*_timeout` values, connection limits |
| R14 | **The base image's tooling is not audited.** `pip-audit -r requirements.txt` covers the application's dependencies only. In the gateway image built for this report, the `pip` 25.0.1 from `python:3.12-slim` has 6 known advisories (`reports/endterm/security/pip-audit-image-gateway.json`) | pip is not used by the services at run time, and the image is built and run only on the trusted host | Scan the built images (for example `pip-audit` on the installed packages, or an image scanner) in CI, rebuild on new base-image releases, and drop pip from the runtime image with a multi-stage build |
| R15 | **Containers run as root.** The `Dockerfile` has no `USER`, and compose sets no `read_only` or `cap_drop`, so `docker compose exec gateway-1 id` is `uid=0(root)`. A code-execution bug in a service runs as root inside its container | One trusted host, no untrusted workloads, and Docker's default capability set still applies. Changing the user would need a rebuild and a re-run of every check, and the services write only to the shared `logs/` volume, whose ownership would have to change with it | A non-root `USER` in the image, `read_only: true` with a writable `tmpfs` where needed, `cap_drop: [ALL]`, `no-new-privileges`, and a Kubernetes `securityContext` with `runAsNonRoot` |
| R16 | **One database role for every service.** Student, payment, transcript, timetable and auth all connect as `app_rw`. A compromised student service can therefore write payments, and any service can INSERT a new row into `app_users` (for example an admin with a hash it chose). UPDATE on `app_users` is revoked, so existing users cannot be changed | One role keeps the credentials simple (one generated password) on a single trusted host; the grants already remove DELETE, TRUNCATE and DDL, and UPDATE on `app_users` | A role per service with grants on its own tables only (for example `auth_rw` with SELECT/INSERT on `app_users` and nothing else, `payment_rw` on `payments` and `students.balance`) |
