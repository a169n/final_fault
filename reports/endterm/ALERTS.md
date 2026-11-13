# Alert rules

The rules live in [`config/prometheus/alerts.yml`](../../config/prometheus/alerts.yml). They are unit-tested with promtool in [`config/prometheus/alerts.test.yml`](../../config/prometheus/alerts.test.yml), which you run with `npm run test:alerts`. Each alert has two tests. A series that crosses the threshold must fire once `for` has elapsed. A series just under the threshold, or a blip shorter than `for`, must not fire.

Prometheus, Grafana and postgres-exporter run in **every** mode (baseline, midterm, endterm). The alerts are therefore evaluated the same way in all three configurations. This is measurement infrastructure, not behaviour under test.

- Prometheus scrapes every 2 s. The scrape timeout is 1 s for the services and 2 s for the exporter. Rules are evaluated every 2 s.
- Every rule carries three annotations: `summary` (what it detects), `threshold`, and `response` (what the system does on its own and what the operator does). They appear on `http://localhost:9090/alerts` and in the Grafana panels "Alerts over time" and "Firing now".
- Gateway series are matched with `svc=~"gateway.*"`, so the rules keep working once the single gateway becomes `gateway-1`/`gateway-2` behind nginx.

## The rules

| Alert | Severity | What it detects | Threshold (expression) | `for` | Expected system response | Expected operator response | Exercised by |
|---|---|---|---|---|---|---|---|
| `InstanceDown` | warning | An application instance (a service replica or the gateway) has stopped answering Prometheus scrapes: a crash, a kill or a hang | `up{job="university"} == 0` | 4 s (two missed scrapes) | Midterm/endterm: the restart policy (`unless-stopped`) restarts the container. The gateway's health check and the endterm outlier ejection take the instance out of rotation, and replicas serve the traffic. Baseline: none, so the instance stays down | If it is still firing after 60 s, the self-healing failed. Check `docker compose ps`, then the instance's log lines, by `rid` | E1 app-crash (may fire), E4 node-failure (must fire), E7 gateway-failure (must fire), E2/E5/E8/E10 (may fire) |
| `DatabaseDown` | critical | postgres-exporter cannot connect to the PostgreSQL primary | `pg_up == 0` | 4 s | Midterm/endterm: reads fail over to the hot standby (H2), writes fail fast, and the breaker opens. Baseline: every DB-backed route fails | Restore the primary. Confirm that `pg_stat_replication` shows the standby streaming again ("Database primary" panel) | E2 db-failure (must fire) |
| `HighErrorRate` | critical | More than 5 % of the responses the gateway(s) return are 5xx | `sum(rate(http_requests_total{svc=~"gateway.*",status=~"5.."}[15s])) / sum(rate(http_requests_total{svc=~"gateway.*"}[15s])) > 0.05` | 6 s | Midterm/endterm: retries, the circuit breaker and degraded responses keep the share down where they can | Open the "Upstream attempts by instance and outcome" and "Circuit breakers" panels. Find the failing replica or dependency and isolate or restart it | E8 error-spike (must fire), E2/E5 (may fire) |
| `HighLatencyP95` | warning | The gateway's p95 latency is above 1 s | `histogram_quantile(0.95, sum by (le) (rate(http_request_duration_seconds_bucket{svc=~"gateway.*"}[15s]))) > 1` | 6 s | Midterm: timeouts and retries. Endterm: outlier ejection removes the slow instance | Look for a slow instance (upstream `timeout` outcomes, `instance_ejected`) and check the DB. Eject or scale the slow replica | E3 net-timeout (may fire), E6 high-load (may fire) |
| `AuthFailureSpike` | warning | Requests denied by authentication, authorization or the rate limiter arrive faster than 2/s, averaged over 30 s. This is a sign of credential stuffing, token forgery, privilege probing or a request flood. A rate-limit 429 counts as `auth_denied_total{reason="rate_limited"}` (and in `rate_limited_total{scope}`), so a brute force or burst that the limiter stops still raises the alert. The legitimate workload is sized never to hit a quota (E6 requires `rateLimited = 0`), so it cannot cause a false alert this way | `sum(rate(auth_denied_total[30s])) > 2` | 4 s | Endterm: every attempt is denied (401/403) and audited, and the rate limiter caps brute force | A possible intrusion attempt. Review the audit events by `rid` and `sub`. Block the source address, or revoke or rotate the affected credentials | E9 unauthorized-access (must fire), E10 abuse (must fire) |
| `PaymentsStuckPending` | critical | A payment is still `pending` 15 s after it was created, meaning a transaction was lost or interrupted | `max(payments_stale_pending) > 0` | 10 s | Midterm/endterm: the rollback sweep moves stale pending payments to `rolled_back` (S5/S6) | Confirm the sweep ran and the alert resolved. In baseline, nothing sweeps, so reconcile the payment manually against the ledger | E5 txn-interrupt (may fire) |

"Must fire" and "may fire" are the `expectedAlerts` of each scenario (Task 15). A rule that fires during a scenario where it is listed as neither counts as an **unexpected** alert, and that makes the alert result for the run incorrect.

## How fast each alert can fire (derived from the configuration, not measured)

The latency from failure to firing is about: time to the next failed scrape (up to 2 s, plus the scrape timeout) + time to the next rule evaluation (up to 2 s) + `for`. For the rate-based rules, add the time it takes for the windowed rate to cross the threshold. The campaign measures the real detection times (`detectionMs` per alert in each run's `metrics.json`), and `reports/endterm/RESULTS.md` reports them. The bounds below only say what to expect.

| Alert | Expected detection latency |
|---|---|
| `InstanceDown` | about 4 to 9 s after the instance stops answering |
| `DatabaseDown` | about 4 to 10 s after the primary stops accepting connections. With the primary down, an exporter scrape takes about 1 s of failed connection attempts. This is why the `postgres` job has a 2 s scrape timeout and the DSN sets `connect_timeout=1`. With a 1 s timeout the scrape itself would fail, and `pg_up` would disappear instead of reading 0 |
| `HighErrorRate` | 6 to 10 s after the 5xx share crosses 5 % over 15 s. When every request fails, the share crosses at the first evaluation that sees two samples. A partial error rate takes longer |
| `HighLatencyP95` | the same as `HighErrorRate`, once 5 % of requests inside the 15 s window are slower than 1 s |
| `AuthFailureSpike` | `rate()` divides by the full 30 s window. It crosses 2/s only once more than about 60 denials fall inside the window. A burst of r denials per second therefore needs about 60/r s, then 4 s of `for`. At 3 denials/s that is about 24 s (pinned in `alerts.test.yml`). At 20/s it is about 7 s |
| `PaymentsStuckPending` | at least 15 s (the age at which a payment counts as stale), plus up to 5 s (the payment service refreshes the gauge every 5 s), plus a scrape, plus 10 s of `for`. In midterm/endterm, a payment rolled back by the sweep before then never fires |

## Limits of the rule set

- **The exporter is the DB's only observer.** If postgres-exporter itself is down, `pg_up` is absent and `DatabaseDown` cannot fire. The exporter is in its own `postgres` job, so `InstanceDown` does not cover it either. Grafana shows the gap in the `up` row "scrape postgres-exporter:9187".
- **Ratio and quantile rules need traffic.** With no requests in the 15 s window, the 5xx share and p95 are undefined, so `HighErrorRate` and `HighLatencyP95` cannot fire. This is the intended behaviour: an idle system is not failing. Total silence is caught by `InstanceDown`.
- **Counters that appear mid-incident lose their first increments.** `rate()` cannot count a series' first scrape. A labelled counter such as `auth_denied_total{reason="expired"}` that is created only by the first denial of that kind therefore undercounts by that first scrape's value. So every label value is created at start-up, set to 0: the gateways export every `auth_denied_total` deny reason (`app/security/audit.py`, `GATEWAY_REASONS`) and the auth service exports `reason="invalid_credentials"` (Task 9). The gateways also export `rate_limited_total{scope}` for every scope (`login`, `student`, `staff`, `admin`) and `auth_denied_total{reason="rate_limited"}` (Task 11, `app/security/rate_limit.py`, `precreate`). E9's 63 attempts only just clear the 60-in-30 s threshold if they all land inside one window, so this matters there.
- **`InstanceDown` sees what Prometheus scrapes.** The scrape targets are static on purpose. A killed container stops resolving in Docker DNS, so a static target reports `up == 0`. Under DNS discovery it would just disappear. The cost is that new instances must be added to `config/prometheus/prometheus.yml` by hand. The targets list `gateway-1:8080` and `gateway-2:8080` directly (not nginx, which exposes no metrics and blocks `/metrics` in endterm), and `auth-1:3000` (Task 8).
- **Label naming.** `upstream_attempts_total` has its own `instance` label (the upstream URL). Prometheus keeps the scrape target in `instance` and stores the upstream URL as `exported_instance`. Use `exported_instance` when you query per-upstream attempts.

## Where to look

- Prometheus: `http://localhost:9090/alerts` (rules, state, annotations) and `/api/v1/alerts` (the harness polls this).
- Grafana: `http://localhost:3000/d/university`. Anonymous visitors get the Viewer role. The admin password is `GRAFANA_ADMIN_PASSWORD` in `.env`. The dashboard has panels for:
  - request rate by status
  - gateway 5xx ratio (with the alert threshold)
  - p50/p95 latency (with the alert threshold)
  - upstream attempts by instance and outcome
  - instance health, from the gateway's health check and from Prometheus `up`
  - outlier ejection
  - circuit breakers
  - auth denied and rate limited
  - payments stuck pending
  - DB primary `pg_up` and the streaming standbys
  - replication lag in bytes
  - alerts over time (pending/firing)
  - alerts firing now
