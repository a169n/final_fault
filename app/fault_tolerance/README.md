# Fault-tolerance mechanisms — where each one lives

Every midterm mechanism is switched by `FT_ENABLED` (software) or `RESTART_POLICY`
(self-healing). With both off you get the **baseline**: same code, same replicas,
nothing that uses them. The endterm additions (S11, H6, H7 below) are listed with the
switch that turns each one on. `ENDTERM_ENABLED=1` (on top of `FT_ENABLED=1`) is the
**endterm** mode; see the three-mode table in [`reports/ARCHITECTURE.md`](../../reports/ARCHITECTURE.md) §7.
`FINAL_ENABLED=1` on top of that is the **final** mode, the improved configuration of the final
project: it adds S12, S13, H8 and H9. The final architecture is in
[`reports/final/ARCHITECTURE.md`](../../reports/final/ARCHITECTURE.md).

The endterm plan calls these "E-numbered" mechanisms. They keep the S/H numbering here instead,
because E1–E10 already name the endterm experiments (`reports/endterm/TEST-PLAN.md`).

## Software (`software/`)


| #   | Mechanism                            | File                                                                 | One line                                                                 |
| --- | ------------------------------------ | -------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| S1  | Retry + exponential backoff + jitter | `[software/retry.py](software/retry.py)`                             | a failed call is repeated on the next replica, waiting 50·2ⁿ ms × random |
| S2  | Timeouts                             | `[software/timeouts.py](software/timeouts.py)`                       | every wait in the system is bounded; all deadlines in one file           |
| S3  | Circuit breaker                      | `[software/circuit_breaker.py](software/circuit_breaker.py)`         | 5 failures in a row → stop calling that service for 5 s                  |
| S4  | Health checks                        | `[software/health_check.py](software/health_check.py)`               | gateway polls `/health/ready` every 1 s, dead replicas leave rotation    |
| S5  | Idempotency + duplicate detection    | `[software/idempotency.py](software/idempotency.py)`                 | same Idempotency-Key twice → original result, no second charge; in endterm only for the same student and amount, else 409 |
| S6  | Checkpoint + rollback / recovery     | `[software/checkpoint_rollback.py](software/checkpoint_rollback.py)` | `pending` row before the charge; a sweep rolls back what a crash left    |
| S7  | Graceful degradation                 | `[software/degradation.py](software/degradation.py)`                 | everything failed on a read → recent stale data (last 2xx, at most 10 000 paths), HTTP 203 `degraded` |
| S8  | Fail-fast writes                     | `[software/timeouts.py](software/timeouts.py)` `DB_ACQUIRE_S`        | no primary database → write fails in ms instead of hanging               |
| S9  | Service replication                  | see H1                                                               |                                                                          |
| S10 | Job checkpoint + lease adoption      | `[software/job_checkpoint.py](software/job_checkpoint.py)`           | timetable job saves progress; another replica resumes it after a crash   |
| S11 | Outlier ejection (endterm only)      | `[software/outlier_ejection.py](software/outlier_ejection.py)`       | 3 failed attempts in a row on one replica → out of the ring for 10 s; never more than half a pool |
| S12 | Writer discovery (final only)        | `[infrastructure/db_failover.py](infrastructure/db_failover.py)` `pick_writer`, `[../core/db.py](../core/db.py)` | every service asks both DB nodes for their role twice a second (and at once after a failed write); writes go to the writable node on the highest timeline |
| S13 | Nested timeouts (final only)         | `[software/timeouts.py](software/timeouts.py)` `DB_ACQUIRE_S`        | the DB wait (0.5 s) is shorter than one gateway attempt (0.8 s): a service answers 503 itself before the gateway gives up on it |




## Infrastructure — assignment §8, at least 2 required


| #   | Mechanism                                    | Declared in                                                                                     | Code that uses it                                                    |
| --- | -------------------------------------------- | ----------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| H1  | Service replicas + load balancing            | `[docker-compose.yml](../../docker-compose.yml)`: `student-1/2`, `payment-1/2`, `timetable-1/2` | `[infrastructure/load_balancer.py](infrastructure/load_balancer.py)` |
| H2  | Database replication (primary → hot standby) | `docker-compose.yml`: `postgres-primary`, `postgres-replica`                                    | `[infrastructure/db_failover.py](infrastructure/db_failover.py)`     |
| H3  | Self-healing (automatic restart)             | `docker-compose.yml`: `restart: ${RESTART_POLICY}`                                              | — (Docker does it)                                                   |
| H4  | Storage checksums                            | `docker-compose.yml`: `--data-checksums`                                                        | — (PostgreSQL does it)                                               |
| H5  | Independent monitoring                       | `docker-compose.yml`: `prometheus`, `grafana`, `postgres-exporter`; `[config/prometheus/](../../config/prometheus/prometheus.yml)` (6 alert rules) | `GET /metrics` in `[core/service.py](../core/service.py)`, metrics in `[core/metrics.py](../core/metrics.py)` |
| H6  | Redundant gateways behind nginx (endterm)    | `docker-compose.yml`: `nginx`, `gateway-1`, `gateway-2`; `[config/nginx/redundant.conf](../../config/nginx/redundant.conf)` | `services/gateway.py`: `POST /api/payments` needs a client `Idempotency-Key` (400 without) |
| H7  | Container healthchecks, liveness/readiness   | `docker-compose.yml`: `healthcheck` on every app container and nginx                            | `GET /health/live` in `[core/service.py](../core/service.py)`; `GET /health/ready` per service |
| H8  | Automatic database failover (final)          | `docker-compose.yml`: `db-controller`; `[../../config/postgres/scripts/node.sh](../../config/postgres/scripts/node.sh)` | `[../services/db_controller.py](../services/db_controller.py)`: promote the standby after 3 failed probes, fence a stale primary, keep replication synchronous while a standby streams; the old primary rejoins as a standby when it is started |
| H9  | Verified backups and merge restore (final)   | `docker-compose.yml`: `db-backup`; `[../../config/postgres/scripts/backup.sh](../../config/postgres/scripts/backup.sh)` | `pg_dump` every 15 s, checked with `pg_restore --list`, SHA-256 next to it, 20 kept; `npm run db:restore` (`experiments/restore.ts`) |
| —   | RAID, ECC memory                             | documented only (cannot exist in containers)                                                    | `[reports/REPORT.md](../../reports/REPORT.md)` §6.3–6.5              |




## Endterm additions in detail

| # | Mechanism | Switched on by | How it works | Unit tests | Experiment |
|---|---|---|---|---|---|
| S11 | Per-instance outlier ejection | `ENDTERM_ENABLED=1` (gateway only) | The per-pool breaker (S3) never opens for one slow replica among healthy ones, because the retry on the next replica succeeds. S11 watches each replica: `FT_EJECT_CONSECUTIVE` (3) failed attempts in a row take it out of the load-balancer ring for `FT_EJECT_MS` (10 000 ms). Then it returns with a clean streak. At most half of a pool is ejected, so a pool-wide fault (DB down) stays the breaker's job. Logged as `kind="ejection"`, exported as `instance_ejected{target}` | `tests/unit/test_outlier_ejection.py` | E3 `net-timeout` |
| H6 | Redundant gateways behind nginx | `NGINX_PROFILE=redundant` (endterm) | nginx sends to `gateway-1` and `gateway-2`. On a connection error (`proxy_connect_timeout 1s`) or a timeout (`proxy_read_timeout 5s`) it re-sends to the other one with the same `X-Request-ID`, and marks the failed one down for 5 s (`max_fails=1 fail_timeout=5s`). Because the re-send may repeat a `POST` the first gateway already forwarded, endterm refuses a payment without a client `Idempotency-Key`: the re-sent request then carries the same key and S5 returns the original payment. Baseline and midterm use `single.conf` (`gateway-1` only), the midterm topology | `tests/unit/test_gateway_idempotency.py`; CI `nginx -t` | E7 `gateway-failure` |
| H7 | Liveness/readiness split + container healthchecks | every mode (Docker healthcheck); the restart that acts on it follows `RESTART_POLICY` | `GET /health/live` answers 200 whenever the process serves and never touches the DB; the Docker healthcheck uses it (interval 2 s, 3 retries, start period 5 s), so a DB outage does not mark healthy processes unhealthy. `GET /health/ready` (alias `/health`) reports whether the instance can do its job (DB reachable; transcript in FT: cache-capable); the gateway's S4 health check polls it | `tests/unit/test_health.py` | E1, E2, E4 |
| S12 | Writer discovery | `FINAL_ENABLED=1` (every service with a DB pool) | After a promotion the services must find the new primary without a restart and without a coordinator. Each one probes both nodes (`PROBE_SQL`) every 0.5 s and immediately after a failed write, and `pick_writer` chooses the node that is not in recovery, not fenced, and on the highest timeline. A promotion always starts a new timeline, so a stale primary that comes back loses everywhere: the rule fences it without any agreement between services. Logged as `kind="failover", action="writer_changed"` | `tests/unit/test_db_controller.py` (`pick_writer`) | E2 `db-failure`, E12 `soak` |
| S13 | Nested timeouts | `FINAL_ENABLED=1` | In midterm/endterm a service waited 1.0 s for a DB connection while the gateway gave up on the attempt after 0.8 s, so every DB failure reached the gateway as a timeout and the service's own 503 was never seen (endterm report §9.4, first follow-up). Final sets the DB wait to 0.5 s | — (a constant) | E2 `db-failure` |
| H8 | Automatic database failover | `FINAL_ENABLED=1` (`db-controller` acts; in the other modes it only exports metrics) | **Promote:** no writable node for `FAILOVER_THRESHOLD` (3) probes, 1 s apart, and a standby that was in sync → `pg_promote()`. A standby that was not in sync is never promoted (`db_failover_refused_total`). **Fence:** two writable nodes → the one on the lower timeline is made read-only. **Synchronous replication:** on while a standby streams (an acknowledged write is on both nodes), off after `SYNC_GRACE` (2) probes without one. **Rejoin:** `node.sh` on a restarted stale primary discards its data and clones the new primary. The controller's database role `failover` has exactly these rights and no table access (`config/postgres/init/90-grants.sql`). Metrics: `db_writer_available`, `db_node_writable{node}`, `db_standby_streaming`, `db_sync_replication`, `db_failovers_total` | `tests/unit/test_db_controller.py` (`decide`), `tests/integration/test_stack_failover.py` | E2 `db-failure`, E12 `soak` |
| H9 | Verified backups, merge restore | `FINAL_ENABLED=1` (`db-backup`; idle otherwise) | Replication copies a destructive statement to the standby at once, so it does not protect the data from an operator error or a compromised superuser. The sidecar dumps the database every `BACKUP_INTERVAL_S` (15 s) as the read-only role `backup`, checks the archive, stores its SHA-256 and keeps `BACKUP_KEEP` (20). `npm run db:restore -- --before <time>` verifies the checksum, restores into a scratch database, checks the ledger invariant there, then merges missing payments back by idempotency key and recomputes balances, under a table lock, while the system keeps serving. Metric: `backup_last_success_timestamp_seconds` | `experiments/scenarios.test.ts` (criteria), `tests/integration/test_stack_failover.py` | E11 `data-loss` |

Related endterm work that is not a fault-tolerance mechanism and lives elsewhere:
- correlation IDs, request/latency/upstream metrics and alert rules: `app/core/context.py`,
  `app/core/metrics.py`, `config/prometheus/`, [`reports/endterm/ALERTS.md`](../../reports/endterm/ALERTS.md);
- security controls (JWT, authorization, audit, validation, rate limiting, chaos token):
  `app/security/`, [`reports/endterm/THREAT-MODEL.md`](../../reports/endterm/THREAT-MODEL.md) §6.

## Where they are used

```
client ─► nginx (H6: gateway-1 ⇄ gateway-2 in endterm)
              ▼
         services/gateway.py ── H1 load_balancer ── S4 health_check (/health/ready) ── S11 outlier_ejection (endterm)
                │                S5 idempotency (forward key)
                │                S1 retry ─ S2 timeout ─ S3 circuit_breaker
                │                S7 degradation (stale cache)
                ▼
   services/student.py      reads ── H2 db_failover
   services/payment.py      S5 idempotency ── S6 checkpoint_rollback
   services/transcript.py   S7 degradation
   services/timetable.py    S10 job_checkpoint
                ▼
   core/db.py               S2 timeouts (S8 fail-fast, S13 nested) ── H2 db_failover ── S12 writer discovery
                ▼
   postgres-primary ⇄ postgres-replica      H8 db-controller (promote, fence, sync) ── H9 db-backup
```

