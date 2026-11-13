# Verification and validation test plan

This plan covers how the resilient university information system is tested, from pure unit tests up
to full system fault-injection and security experiments. It is the reference for the experiment
campaign (REPORT.md §7, §8) and the report ([`REPORT.md`](REPORT.md)).

Three deployable modes are tested the same way, so results are comparable:

| Mode | `FT_ENABLED` | `ENDTERM_ENABLED` | nginx | Brought up with |
|---|---|---|---|---|
| baseline | 0 | 0 | single | `npm run up:baseline` |
| midterm | 1 | 0 | single | `npm run up:midterm` |
| endterm | 1 | 1 | redundant | `npm run up:endterm` |

Observability (correlation IDs, metrics, structured logs, Prometheus, Grafana, alerts, Docker
healthchecks) and credential hygiene (DB passwords, least-privilege roles) are on in every mode, so
all three are measured identically. Only behaviour under test (outlier ejection, the second gateway
in rotation, authN/Z, strict validation, rate limiting, the required payment Idempotency-Key, the
chaos token) is gated by `ENDTERM_ENABLED`.

## Test levels

| Level | What it checks | Where | Run with |
|---|---|---|---|
| Unit (Python) | Pure logic of each mechanism and security control, with upstreams stubbed or monkeypatched. No containers. | `tests/unit/**` (20 files) | `python3 -m pytest -q tests/unit` |
| Unit (harness) | Pure logic of the experiment harness: metrics, acceptance evaluation, alert folding, resource sampling, the mode→`.env` builder, the security attack/abuse generators and verdicts, aggregation, snapshot, demo and the per-operation recovery analysis. No containers. | `experiments/*.test.ts` (11 files) | `npm run test:harness` |
| Config | The alert rules, Prometheus config and nginx configs are valid. | `config/prometheus/alerts.test.yml`, `promtool`, `nginx -t` | `npm run test:alerts` (+ the CI `config` job in `.github/workflows/ci.yml`) |
| Integration | The real endterm stack end to end: login, idempotent payment, an `Idempotency-Key` re-used by another student refused, authorization, reserved upstream paths denied, validation, correlation-ID propagation, least privilege (no TRUNCATE, no UPDATE on `app_users`). Skips unless `GET /health` reports `mode == "endterm"`. | `tests/integration/test_stack.py` | `pytest -m integration -q` |
| System / fault injection | The whole stack under 10 fault, monitoring and security scenarios, with acceptance criteria, 3 repetitions per mode. | `experiments/scenarios.ts`, `run.ts`, `campaign.ts` | `npm run exp <scenario> -- --rep N`, `npm run campaign -- --reps 3` |

### Unit suites and what they cover

Python (`tests/unit/`): `test_tokens.py`, `test_passwords.py` (JWT issue/verify incl. expired,
bad-signature, `alg:none`, wrong-audience; salted scrypt), `test_policy.py` (the full authorization
matrix, fail-closed), `test_audit.py` (no secrets reach the log line), `test_validation.py` (the
payment/student/timetable rejection lists, gateway size/path limits), `test_rate_limit.py` (token
bucket burst/refill, staff quota absorbs the high-load peak, login brute-force), `test_chaos_guard.py`
(chaos token required in endterm, open in midterm, constant-time compare), `test_gateway_*.py`
(idempotency-key requirement, authN/Z proxy behaviour), plus the midterm mechanisms
(`test_circuit_breaker.py`, `test_retry.py`, `test_load_balancer.py`, `test_outlier_ejection.py`,
`test_health.py`, `test_degradation.py`, `test_idempotency.py`, `test_context.py`, `test_metrics.py`,
`test_auth_service.py`).

Harness (`experiments/`): `metrics.test.ts` (outage detection, percentiles, throughput windows,
key-level integrity, read availability, resource summary), `acceptance.test.ts` (criteria helpers,
alert correctness, fail-closed on missing evidence), `attacks.test.ts` (the 7 attack categories, the
`attack-`/`abuse-` idempotency keys, forged/expired/`alg:none` token shape, the 200 malformed bodies,
the burst/brute-force verdicts), `scenarios.test.ts` (all ten scenarios exist with the right kind,
expected alerts and acceptance criteria), `env.test.ts` (mode→`.env`).

## The ten system scenarios (E1–E10)

Common to every scenario:

- **Environment/config:** the stack in the mode under test (baseline / midterm / endterm), brought
  up from a fresh volume per mode. Observability on in all three.
- **Known-state restore before every run** (`run.ts`): every container started, chaos reset on every
  instance (`{latencyMs:0, failRate:0, crashAfterCheckpoint:false}`), the DB reset
  (`TRUNCATE payments; UPDATE students SET balance=0; DELETE FROM students WHERE id !~ '^s[0-9]+$'`),
  health and replication confirmed, and Prometheus confirmed to have **no firing alert** (≤ 60 s).
  The restore outcome is recorded in `metrics.json`.
- **Workload:** `experiments/workload.ts`, 10 base workers, 60 % student reads / 20 % transcript
  reads / 20 % payments, every request carrying `x-request-id: <runId>-<n>`. In endterm the workload
  logs in once as `bursar` (staff) and sends `Authorization` on every request.
- **Timeline:** 70 s observation, inject at T+20 s, repair at T+45 s.
- **Steps (exact commands):**
  1. `npm run up:<mode>` (once per mode).
  2. `npm run exp <scenario> -- --rep <n>` (the harness does restore → workload → inject → repair →
     capture). For the whole set: `npm run campaign -- --reps 3`.
  3. Results land in `reports/endterm/runs/<scenario>__<mode>__r<n>/metrics.json` and raw data in
     `logs/endterm/<scenario>__<mode>__r<n>/`.
- **Repetitions:** 3 per mode (30 runs per mode, 90 in total).
- **Measurements captured** (spec §7): success/failure counts, error rate, avg and p95 latency,
  detection and recovery time, availability (request- and time-based; read availability for the DB
  scenario), alerts fired and whether each was correct, lost/duplicate/orphaned records, per-alert
  detection delay, and max CPU/memory per container.

"A" below is request-based availability. Acceptance targets are the **endterm** targets from the plan;
baseline and midterm are expected to miss several and are reported for comparison, not as failures.

### E1 `app-crash` — application crash (fault)

- **Hypothesis:** when a service process crashes, redundancy and the restart policy keep the system
  available with no lost or duplicate payment.
- **Inject / repair:** `POST /chaos/crash` on student-1 / `docker compose start student-1`.
- **Alerts:** mustFire — ; mayFire — `InstanceDown`.
- **Acceptance (endterm):** A ≥ 99.9 %; duplicate charges = 0; lost records = 0.
- **Limitations:** a crash of a single replica is masked by its peer; this does not exercise a
  whole-pool outage.

### E2 `db-failure` — database primary failure (fault)

- **Hypothesis:** when the primary stops, reads fail over to the hot standby and writes fail fast;
  `DatabaseDown` fires quickly; no payment is lost or duplicated.
- **Inject / repair:** `docker compose stop postgres-primary` / `docker compose start postgres-primary`.
- **Alerts:** mustFire — `DatabaseDown`; mayFire — `HighErrorRate`, `InstanceDown`.
- **Acceptance (endterm):** `DatabaseDown` detection ≤ 10 s; read availability ≥ 99 %; duplicate
  charges = 0; lost records = 0.
- **Limitations:** the exporter is the DB's only observer, so if it is down `DatabaseDown` cannot
  fire (ALERTS.md). Read availability, not overall A, is the fair measure, because writes are meant
  to fail fast while the primary is down.

### E3 `net-timeout` — network / service timeout (fault)

- **Hypothesis:** a slow instance is ejected (endterm), so goodput is largely preserved and p95 stays
  bounded.
- **Inject / repair:** student-1 `latencyMs: 3000` via `/chaos` / reset to 0.
- **Alerts:** mustFire — ; mayFire — `HighLatencyP95`.
- **Acceptance (endterm):** during-fault throughput ≥ 0.7 × pre-fault throughput (outlier ejection);
  p95 ≤ 1 000 ms.
- **Limitations:** ejection is per gateway; a very short latency spike may resolve before ejection.

### E4 `node-failure` — hardware / node failure (fault)

- **Hypothesis:** losing a whole node (a service replica is killed outright) is detected and masked.
- **Inject / repair:** `docker compose kill student-1 payment-1` / `docker compose start student-1 payment-1`.
- **Alerts:** mustFire — `InstanceDown`; mayFire — .
- **Acceptance (endterm):** `InstanceDown` detection ≤ 10 s; A ≥ 99.9 %; duplicate charges = 0.
- **Limitations:** two replicas of one pool are not both killed, so no pool goes fully dark.

### E5 `txn-interrupt` — corrupted / lost transaction (fault)

- **Hypothesis:** a payment interrupted after its checkpoint is rolled back by the sweep; the ledger
  stays balanced with no duplicate, lost or orphaned pending payment.
- **Inject / repair:** `crashAfterCheckpoint: true` on both payment replicas (3021, 3022) /
  `docker compose start payment-1 payment-2`.
- **Alerts:** mustFire — ; mayFire — `PaymentsStuckPending`, `HighErrorRate`, `InstanceDown`.
- **Acceptance (endterm):** duplicate charges = 0; lost records = 0; orphaned pending = 0 at end;
  ledger balanced.
- **Limitations:** the stale-pending age (15 s) plus `for` means `PaymentsStuckPending` may resolve
  before it fires if the sweep is fast; it is therefore mayFire, not mustFire.

### E6 `high-load` — high load (fault)

- **Hypothesis:** at a 110-worker peak (~2 000 req/s) the system holds latency and error rate, and
  the staff rate-limit quota never throttles the legitimate workload.
- **Inject / repair:** +100 workers join at T+20 s (ramp) / the ramp ends naturally.
- **Alerts:** mustFire — ; mayFire — `HighLatencyP95`.
- **Acceptance (endterm):** error rate ≤ 1 %; p95 ≤ 1 000 ms; rate-limited = 0 (Review Focus 1);
  resources recorded.
- **Limitations:** the peak is bounded by the host; `rateLimited = 0` is the guard that the endterm
  availability is not an artefact of the limiter.

### E7 `gateway-failure` — redundant gateway killed (fault, new)

- **Hypothesis:** nginx fails over to the second gateway when the first is killed mid-stream, so
  clients keep succeeding with no double charge.
- **Inject / repair:** `docker compose kill gateway-1` / `docker compose start gateway-1`.
- **Alerts:** mustFire — `InstanceDown`; mayFire — .
- **Acceptance (endterm):** A ≥ 99.5 %; duplicate charges = 0; lost records = 0.
- **Limitations:** `proxy_next_upstream … non_idempotent` re-sends a POST to gateway-2; this is safe
  only because endterm requires a client `Idempotency-Key` (Review Focus 2, pinned by
  `test_payment_without_idempotency_key_rejected`). Baseline/midterm run a single gateway, so there
  is nothing to fail over to — a genuine SPOF, which is the point of the comparison.

### E8 `error-spike` — error spike (monitoring, new)

- **Hypothesis:** a sustained 5xx spike is detected by `HighErrorRate` within 15 s and the alert
  resolves within 30 s of repair, with no unexpected alert.
- **Inject / repair:** `failRate: 1.0` on student-1, student-2, payment-1 and payment-2 / reset all
  to 0.
- **Alerts:** mustFire — `HighErrorRate`; mayFire — `InstanceDown`.
- **Acceptance (endterm):** `HighErrorRate` detection ≤ 15 s; it resolves ≤ 30 s after repair; no
  unexpected alerts (`alertsCorrect`).
- **Limitations and deviation from the plan:** the plan lists `failRate: 1.0 on student-1 and
  student-2` only. In endterm, a failed **read** degrades to a 203 from the stale cache (S7), so the
  gateway 5xx share stays near zero and `HighErrorRate` cannot fire from read failures alone
  (confirmed: a student-only spike left A ≈ 99.98 % with ~3 failures). Payment **writes** cannot
  degrade, so both payment replicas are failed as well; that drives a genuine ~20 % gateway 5xx share
  that the alert measures (confirmed: A ≈ 90.7 %, `HighErrorRate` fired, correct). Both student
  replicas are still failed, as named.

### E9 `unauthorized-access` — forged tokens and privilege escalation (security, new)

- **Hypothesis:** every unauthenticated or over-privileged request is denied and audited, nothing
  reaches the database, and the denial rate raises `AuthFailureSpike`, all while the legitimate
  workload stays available.
- **Inject:** during the workload, the attack script below (63 attempts, interleaved round-robin,
  every attempt carrying an `attack-` Idempotency-Key, paced so the s7 attacks stay under s7's own
  quota). **Repair:** none — the controls must leave no state behind.
- **Attack script (7 categories, `experiments/attacks.ts` `attackSet`):**
  - no token: `POST /api/payments` and `POST /api/students`
  - a forged-signature admin token (`alg:HS256`, signed with the wrong key)
  - an expired admin token (genuine signature, `exp` in the past)
  - an `alg:none` admin token
  - student `s7` paying for `s8`
  - student `s7` creating student `evil-N`
  - student `s7` listing all students
- **verify():** counts DB payment rows with the attack amount 13.37 (no legitimate request uses it;
  the workload and the demo pay 100) or an `attack-` key (must be 0), and student rows
  `where id like 'evil-%'` (must be 0), the audit deny events whose `rid` matches an attack rid, the
  status counts per attack category, and whether the s7 login succeeded (`logins`). A failed login is
  recorded, not swallowed: the s7 attempts would then go out without a token and get a 401 before the
  authorization policy runs, so the "every attempt denied" criterion also requires every s7-token
  attempt (pay for s8, create `evil-N`, list all) to be a 403.
- **Alerts:** mustFire — `AuthFailureSpike`; mayFire — .
- **Acceptance (endterm):** every attempt denied (401/403), the s7-token ones by the policy (403);
  attacker payments in DB = 0; `evil-*` students = 0; audit events ≥ attempts; ledger balanced;
  legitimate A ≥ 99.9 %.
- **Limitations:** 63 denials only just clear the `AuthFailureSpike` threshold (> 60 in 30 s,
  ALERTS.md); if the host is slow enough to spread them past one window the alert may be late. No
  token revocation exists (tokens are short-lived instead), so a stolen valid token is out of scope
  here.

### E10 `abuse` — malformed input, burst and brute force (security, new)

- **Hypothesis:** malformed input is rejected with a 4xx (never a 5xx), a request burst and a login
  brute force are rate-limited after their quota, every instance stays up, and the legitimate
  workload stays available.
- **Inject:** during the workload, the abuse script below. **Repair:** none.
- **Abuse script (`experiments/attacks.ts` `abuseSet` / `burstSet` / `bruteForceSet`):**
  - 200 malformed payments: the 20 seeds of the validation rejection list (`experiments/attacks.ts`), 10 sends each, every body
    exactly as written (only the two extra-field seeds carry a field beyond `studentId`/`amount`, so
    each seed is rejected for its own reason), plus invalid JSON, a 1 MiB body and a bad path segment
    (all with the staff token: the body, not the policy, is what is wrong)
  - a burst of 1 000 `GET /api/students/s7` in ~2 s with the s7 student token
  - 50 logins with wrong passwords
- **verify():** 5xx count and status counts among the malformed requests (no 5xx, and none refused
  with 401/403/429 before validation, e.g. because the staff login failed); the burst summary (some
  429s, `Retry-After` on every 429, no 5xx, at least one gateway's burst of 20 admitted and ≤ the
  2-gateway cluster ceiling; counts only, because the burst is sent in concurrent waves of 50 and a
  429's position in send order is not the order the gateways processed it); the
  brute-force status sequence (429 after the 5-attempt burst); the logins it depended on (`logins`);
  and the instances: every one answering `/health` afterwards, and no container whose `docker
  inspect` RestartCount or StartedAt changed (or that stopped) between a snapshot taken when the abuse
  starts and one taken in verify(). The snapshot matters because endterm runs with
  `RESTART_POLICY=unless-stopped`: a container that crashed under the abuse is restarted within
  seconds, long before a `/health` probe could notice.
- **Alerts:** mustFire — `AuthFailureSpike`; mayFire — `InstanceDown`.
- **Acceptance (endterm):** 0 × 5xx caused by malformed input (and every malformed request reached
  validation); burst gets 429 after the quota; brute force gets 429 after 5; all instances stay up (no
  container restarted, stopped or disappeared; all healthy after); ledger balanced; legitimate
  A ≥ 99.9 %.
- **Limitations:** rate-limit state is per gateway, so the effective cluster quota is up to 2× a
  single gateway's; the burst verdict accounts for this. The burst is bounded by the host's ability
  to issue 1 000 requests in ~2 s.

## Smoke-test evidence (endterm, `--rep 0`)

Each new scenario was smoke-tested once on the running endterm stack. The restore succeeded before
each, and every acceptance array was populated and fully passed:

| Scenario | Alerts fired | Acceptance | Notes |
|---|---|---|---|
| `gateway-failure` | `InstanceDown` (correct) | 3/3 | A 99.99 %, dup 0, lost 0 |
| `error-spike` | `HighErrorRate` (correct) | 3/3 | A 90.70 %, detection ~11 s, no unexpected alert |
| `unauthorized-access` | `AuthFailureSpike` (correct) | 6/6 | 63/63 denied (36×401, 27×403), 0 attack rows, 63 audit denies |
| `abuse` | `AuthFailureSpike` (correct) | 6/6 | malformed 422×200/400×2/413×1 no 5xx; burst 938/1000 limited with Retry-After; brute force 10×401 then 40×429; instances up |

After the review fix (category-aware E9 verdict, E10 validation-reached check and container restart
snapshot), `unauthorized-access` and `abuse` were smoke-run once more with `--rep 0`: both 6/6 with
`AuthFailureSpike` (correct). E9: 63/63 denied, every s7-token attempt 403 (9 per category), s7 login
ok. E10: malformed 422×200/400×2/413×1, staff and s7 logins ok, 16 containers snapshotted, none
restarted. A separate live check of the snapshot diff (`docker compose restart timetable-2` between
two snapshots) reported exactly that container.

After the second review fix (count-only burst verdict, malformed seeds sent exactly as written,
attacker payments counted by the attack amount 13.37), both were smoke-run once more on endterm with
`--rep 0`: `abuse` 6/6 (malformed 422×200/400×2/413×1, no 5xx; burst 60 ok / 940 limited with
Retry-After in 1 138 ms, first 429 at send index 31; brute force 10×401 then 40×429; 16 containers,
none restarted) and `unauthorized-access` 6/6 (63/63 denied, 36×401 / 27×403, 0 attacker payments,
0 `evil-*`, 63 audit denies), both with `AuthFailureSpike` (correct). A one-off baseline smoke run of
`unauthorized-access` (stack brought up with `npm run up:baseline`, then back to endterm; output not
kept) confirmed the new count: 41 attacker payments in the DB (every payment attempt of no-token,
forged, expired, `alg:none` and s7-for-s8 succeeded), none of them with an `attack-` key, so the old
key-only count would have read 0; `attacker-payments-in-db-eq-0` failed as it should (2/6).

`--rep 0` is a smoke run and is not part of the 3-repetition campaign (REPORT.md §7.6). The numbers above are
single observations, kept for provenance alongside each run's `metrics.json`.
