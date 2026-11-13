# System architecture

Sections 1 and 2 describe the **endterm** system, the version this repository deploys today. Section 3
keeps the midterm deployment diagram exactly as submitted (git tag `midterm-final`), so the two can be
compared. The same code and image run in three modes (section 7). The endterm report
([`endterm/REPORT.md`](endterm/REPORT.md)) explains the design. The threat model
([`endterm/THREAT-MODEL.md`](endterm/THREAT-MODEL.md)) takes its trust boundaries B1 to B5 from this page.

## 1. Deployment (endterm): redundant gateways, auth, monitoring plane, trust boundaries

```mermaid
flowchart TB
    client([Clients — untrusted<br/>experiments/workload.ts · demo.ts · attacks.ts])

    subgraph host["Docker host (one machine) — B5: host and operator, .env secrets, docker exec"]
        nginx["<b>nginx</b> :8080 — the only port published beyond the host<br/>endterm: redundant.conf, failover gateway-1 ⇄ gateway-2<br/>baseline/midterm: single.conf, gateway-1 only<br/>sets X-Request-ID + X-Forwarded-For · 404 on /metrics, /chaos"]

        subgraph PEP["gateways — policy enforcement point · 127.0.0.1 only"]
            g1["gateway-1 :8081<br/>H1 · S1–S5 · S7 · S11 ejection<br/>JWT verify · authz · validation<br/>rate limit · audit"]
            g2["gateway-2 :8082<br/>same code and config<br/>(in nginx rotation in endterm only)"]
        end

        subgraph SVC["services — compose network, plain HTTP · 127.0.0.1 only"]
            auth["auth-1 :3051<br/>issues JWTs (HS256, 15 min)<br/>scrypt password hashes"]
            subgraph STU["student — 2 replicas"]
                s1["student-1 :3011<br/>node A"]
                s2["student-2 :3012<br/>node B"]
            end
            subgraph PAY["payment — 2 replicas"]
                p1["payment-1 :3021<br/>node A"]
                p2["payment-2 :3022<br/>node B"]
            end
            subgraph TT["timetable — 2 replicas"]
                t1["timetable-1 :3041<br/>node A"]
                t2["timetable-2 :3042<br/>node B"]
            end
            tr["transcript-1 :3031<br/>1 instance · S7 stale cache"]
        end

        subgraph DB["database — H2 replication · role app_rw (no DELETE/TRUNCATE/DDL)"]
            pg[("postgres-primary :55432<br/>reads + writes · H4 checksums<br/>scram-sha-256")]
            rp[("postgres-replica :55433<br/>hot standby, read-only")]
        end

        subgraph MON["monitoring plane — on in every mode · 127.0.0.1 only"]
            prom["prometheus :9090<br/>scrape + rules every 2 s<br/>6 alert rules"]
            graf["grafana :3000<br/>dashboard 'university'<br/>anonymous read-only"]
            pgx["postgres-exporter :9187<br/>role monitor (pg_monitor)"]
        end

        log[/"logs/events.jsonl<br/>one JSON line per event, with rid"/]
    end

    client ==>|"B1: HTTP, untrusted"| nginx
    nginx ==>|"B2"| g1
    nginx -.->|"B2: failover (endterm)"| g2
    g1 & g2 -->|"B3: POST /auth/token relay"| auth
    g1 & g2 -->|"B3: round robin over ready,<br/>non-ejected replicas"| STU
    g1 & g2 -->|"B3: + client Idempotency-Key"| PAY
    g1 & g2 -->|B3| TT
    g1 & g2 -->|B3| tr

    auth & STU & PAY & TT & tr -->|"B4: reads + writes as app_rw"| pg
    STU & tr -.->|"B4: read failover (H2)"| rp
    pg ==>|"WAL streaming as repl"| rp

    pgx -->|"B4: stats only"| pg
    prom -.->|"scrape /metrics every 2 s"| g1 & g2 & auth & STU & PAY & TT & tr
    prom -.-> pgx
    graf --> prom

    g1 & g2 & auth & STU & PAY & TT & tr -.->|append| log
```

* **Trust boundaries.** B1 is the only public boundary: clients reach nginx on `:8080` and nothing else.
  B2 (nginx to the gateways) hands the request to the policy enforcement point (PEP). B3 (gateways to
  services and `auth-1`) and B4 (services to PostgreSQL) stay inside the compose network. B5 is the host
  itself: the Docker daemon, the git-ignored `.env`, the shared `logs/` volume and every
  `127.0.0.1`-only port. Section 5 of the threat model lists the threats at each boundary.
* **No more single gateway.** In endterm nginx sends traffic to two gateways and moves to the other one
  on a connection error or a timeout (`proxy_connect_timeout 1s`, `proxy_read_timeout 5s`,
  `max_fails=1 fail_timeout=5s`). Because nginx may re-send a `POST` to the second gateway, endterm
  refuses a payment without a client `Idempotency-Key` (400). Baseline and midterm keep one gateway
  behind nginx (`single.conf`), which is the midterm topology.
* **Auth outside the request path.** `auth-1` is reached only for logins (`POST /auth/token`). The
  gateways check tokens locally with `JWT_SECRET`, so an `auth-1` outage blocks new logins but not
  requests that already carry a token.
* **The monitoring plane is outside the comparison.** Prometheus, Grafana and postgres-exporter run in
  every mode with `restart: unless-stopped`. All three modes are therefore measured the same way.
* **Still single:** nginx, `transcript-1`, `auth-1`, `postgres-primary` (no automatic promotion) and
  the host. See the endterm report §3.8.
* **Node A / node B** are logical, as in the midterm. All containers share one host.

### Trust boundaries and what guards each one

| Boundary | Crossed by | Guard | Mode |
|---|---|---|---|
| B1 client → nginx | every client request | only `:8080` is published, `X-Forwarded-For` is overwritten, `/metrics` and `/chaos*` return 404 (redundant.conf) | port binding in every mode, blocking in endterm |
| B2 nginx → gateways | proxied requests, failover re-sends | one `X-Request-ID` per request, reused on a re-send. Gateways listen on `127.0.0.1` only | every mode |
| B3 gateway → services, auth | upstream calls, login relay | JWT verification, authorization matrix, input validation, rate limits, audit. Only `content-type`, `idempotency-key` and `x-request-id` are forwarded, never the token. `/chaos*` needs `x-chaos-token` | endterm |
| B4 services → PostgreSQL | SQL, replication, exporter | `scram-sha-256` on every network line, least-privilege `app_rw`, `repl`, `monitor` roles, parameterised SQL | every mode |
| B5 host | operator, harness | generated secrets in git-ignored `.env`, loopback-only ports, superuser only over `docker exec` | every mode |

## 2. Code: business logic, fault tolerance and security are separate layers

```mermaid
flowchart TB
    subgraph SVC["app/services/ — what the university does"]
        gw[gateway.py<br/>PEP]
        au[auth.py]
        st[student.py]
        pa[payment.py]
        tr[transcript.py]
        tt["timetable.py + schedule.py"]
    end

    subgraph SEC["app/security/ — endterm controls"]
        tok["tokens.py JWT"]
        pw["passwords.py scrypt"]
        pol["policy.py authz matrix"]
        aud["audit.py"]
        val["validation.py"]
        rl["rate_limit.py"]
    end

    subgraph FT["app/fault_tolerance/ — how it survives failures"]
        subgraph SW["software/"]
            retry["S1 retry.py"]
            to["S2 timeouts.py"]
            cb["S3 circuit_breaker.py"]
            hc["S4 health_check.py"]
            idem["S5 idempotency.py"]
            cp["S6 checkpoint_rollback.py"]
            deg["S7 degradation.py"]
            job["S10 job_checkpoint.py"]
            oe["S11 outlier_ejection.py"]
        end
        subgraph INF["infrastructure/"]
            lb["H1 load_balancer.py"]
            dbf["H2 db_failover.py"]
        end
    end

    subgraph CORE["app/core/ — plumbing"]
        db[db.py]
        ev["eventlog.py<br/>JSONL, rid, mode"]
        ctx["context.py<br/>correlation id"]
        met["metrics.py<br/>Prometheus"]
        sv["service.py<br/>middleware, /health/live, /metrics"]
    end

    gw --> tok & pol & aud & val & rl
    au --> pw & tok & aud
    gw --> lb & hc & oe & idem & retry & deg
    lb --> oe
    retry --> to & cb
    pa --> idem & cp & val
    st --> val
    tr --> deg
    tt --> job & val
    st & pa & tr & tt & au --> db
    db --> dbf & to
    SVC --> sv
    sv --> ctx & met & ev
```

The full list of mechanisms, with file links, is in
[`app/fault_tolerance/README.md`](../app/fault_tolerance/README.md). The security controls are listed in
[`endterm/THREAT-MODEL.md`](endterm/THREAT-MODEL.md) §6.

## 3. Deployment (midterm, as submitted at tag `midterm-final`)

Kept unchanged for comparison. In the current repository the "gateway :8080" box is `gateway-1` behind
nginx (`single.conf`) in baseline and midterm, which has the same topology. Prometheus is no longer
behind a profile.

```mermaid
flowchart TB
    client([Clients<br/>experiments/workload.ts · experiments/demo.ts])

    subgraph host["Docker host (one machine)"]
        gw["<b>gateway</b> :8080<br/>H1 load balancer · S4 health checks<br/>S1 retry · S2 timeout · S3 circuit breaker<br/>S5 idempotency key · S7 stale cache"]

        subgraph STU["student service — 2 replicas"]
            s1["student-1 :3011<br/>node A"]
            s2["student-2 :3012<br/>node B"]
        end
        subgraph PAY["payment service — 2 replicas"]
            p1["payment-1 :3021<br/>node A"]
            p2["payment-2 :3022<br/>node B"]
        end
        subgraph TT["timetable service — 2 replicas"]
            t1["timetable-1 :3041<br/>node A"]
            t2["timetable-2 :3042<br/>node B"]
        end
        tr["transcript-1 :3031<br/>1 instance · S7 stale cache"]

        subgraph DB["database — H2 replication"]
            pg[("postgres-primary :55432<br/>reads + writes · H4 checksums")]
            rp[("postgres-replica :55433<br/>hot standby, read-only")]
        end

        log[/"logs/events.jsonl<br/>one line per event"/]
        prom["prometheus :9090 · H5<br/>(profile: monitoring)"]
    end

    client -->|HTTP| gw
    gw -->|round robin over healthy| STU
    gw -->|"round robin + Idempotency-Key"| PAY
    gw -->|round robin| TT
    gw --> tr

    STU & PAY & TT & tr -->|"reads + writes"| pg
    STU & tr -.->|"read failover (H2)"| rp
    pg ==>|"WAL streaming replication"| rp

    gw & STU & PAY & TT & tr -.->|append| log
    prom -.->|"scrape /metrics every 2 s"| gw & STU & PAY & TT & tr
```

## 4. Components

| Component | Instances | Data it owns | Fault-tolerance and security role | New in endterm |
|---|---|---|---|---|
| nginx | 1 | none | public entry point. Endterm: gateway failover, blocks `/metrics` and `/chaos*`, sets `X-Request-ID` and `X-Forwarded-For` | yes |
| gateway | **2** (`gateway-1`, `gateway-2`) | in-memory health map, outlier state, rate-limit buckets, last-good GET responses | H1, S1–S5, S7. Endterm: S11 outlier ejection, JWT verification, authorization, validation, rate limiting, audit, required payment `Idempotency-Key` | second instance, PEP |
| auth | 1 (`auth-1`) | `app_users` (scrypt hashes) | issues 15-minute HS256 JWTs. Login brute force is rate-limited at the gateway | yes |
| student | **2** | `students` | replicated, stateless. Reads fail over to the standby (H2) | strict validation (endterm) |
| payment | **2** | `payments` | S5 idempotency, S6 checkpoint before charge + rollback sweep, `payments_stale_pending` gauge | strict validation, stale-pending gauge |
| transcript | 1 | `grades` (read-only) + local cache | S7: stale data flagged `degraded` (HTTP 203) when the database is gone | — |
| timetable | **2** | `courses`, `rooms`, `timetable_jobs` | S10: durable checkpoints. A live replica adopts a dead one's job | strict validation (endterm) |
| postgres-primary | 1 | everything | the only writable copy. H4 page checksums. Roles `app_rw`, `repl`, `monitor` | passwords, least privilege |
| postgres-replica | 1 | streaming copy | H2 hot standby for reads | replicates as `repl` |
| prometheus | 1, always on | time series | scrapes every 2 s, evaluates 6 alert rules every 2 s | always on, alert rules |
| grafana | 1, always on | dashboard definition | dashboard `university`: request rate, error ratio, latency, upstream outcomes, health, ejection, breakers, auth denials, stale payments, DB, alerts | yes |
| postgres-exporter | 1, always on | none | `pg_up` (`DatabaseDown`) and replication statistics | yes |

Every application container has a Docker healthcheck on `GET /health/live` (interval 2 s, 3 retries,
start period 5 s). Liveness never touches the database, so a database outage does not mark healthy
processes unhealthy. Readiness (`GET /health/ready`, alias `/health`) is what the gateway's S4 health
check polls.

## 5. Request flow (endterm)

1. A client calls `POST /auth/token` with a username and password. nginx relays it to a gateway, the
   gateway relays it to `auth-1`, and `auth-1` returns a JWT valid for 15 minutes.
2. The client calls `GET|POST /api/{students|payments|transcripts|timetables}/...` on nginx `:8080`.
   nginx assigns an `X-Request-ID` if the client sent none, overwrites `X-Forwarded-For`, and picks a
   gateway. On a connection error or a timeout it re-sends to the other gateway with the same request ID.
3. The gateway (PEP) accepts the request ID only if it matches `[A-Za-z0-9._-]{8,64}`, and otherwise
   replaces it with a fresh UUID. Then it applies its edge limits: body ≤ 16 384 bytes (413), JSON
   object body on POST (400), safe path segments (400). Then, in this order, it verifies the token
   (401), applies the per-principal rate limit (429 with `Retry-After`) and applies the authorization
   matrix (403). It writes an audit event for every deny, every payment allow and every admin action.
4. **H1 + S4 + S11:** the gateway picks the next replica that is ready and not ejected. Three failed
   attempts in a row on one replica eject it for 10 s, but never more than half of a pool.
5. **S5:** a `POST /api/payments` must carry the client's `Idempotency-Key` (400 otherwise). The key
   and the request ID are forwarded. The token is not.
6. **S2 + S1 + S3:** the call runs under an 800 ms timeout, is retried on the next replica with
   exponential backoff and full jitter (up to 3 attempts), and five consecutive failures open the
   pool's circuit breaker for 5 s.
7. **S7:** if every attempt fails on a GET, the gateway answers from its last-good copy (HTTP 203,
   `degraded: true`) when that copy is less than 60 s old.
8. Every hop logs JSON lines with the same `rid` to `logs/events.jsonl` and updates its Prometheus
   metrics (`http_requests_total`, `http_request_duration_seconds`, `upstream_attempts_total`, ...).
   Prometheus scrapes them every 2 s and evaluates the alert rules.

## 6. What changed since the midterm

| Midterm | Endterm | Why |
|---|---|---|
| one gateway on `:8080`, the largest single point of failure (midterm REPORT §4.4) | nginx on `:8080` in front of `gateway-1` and `gateway-2` | the gateway is no longer a SPOF (E7) |
| per-pool circuit breaker only, so a slow replica stayed in rotation (midterm REPORT §11) | + per-instance outlier ejection (S11) | a slow replica is taken out of the ring (E3) |
| one `/health` | `/health/live` (Docker healthcheck) and `/health/ready` (gateway S4) | a DB outage must not get healthy processes restarted |
| JSONL events, `ft_events_total` | + correlation ID on every hop, request/latency/upstream/auth metrics, Grafana, 6 alert rules, postgres-exporter | detection and diagnosis (E8) |
| no authentication, `trust` database, open `/chaos` | auth service, JWTs, authorization, audit, validation, rate limits, passwords, least-privilege roles, chaos token | security and intrusion tolerance (E9, E10) |

## 7. Three modes, one image

All three modes run the **same image**. `experiments/env.ts` writes the switches into `.env`:

| Mode | `FT_ENABLED` | `ENDTERM_ENABLED` | `RESTART_POLICY` | `NGINX_PROFILE` |
|---|---|---|---|---|
| baseline | 0 | 0 | `no` | `single` |
| midterm | 1 | 0 | `unless-stopped` | `single` |
| endterm | 1 | 1 | `unless-stopped` | `redundant` |

`FT_ENABLED=0` turns off every midterm software mechanism (one attempt, no timeout, no breaker, blind
round robin, no standby reads, idempotency key ignored, no recovery sweeps, no timetable checkpoints).
`ENDTERM_ENABLED=1` turns on the new behaviour: outlier ejection, the second gateway in rotation,
authentication and authorization, strict validation, rate limiting, the required payment
`Idempotency-Key` and the chaos token check. Correlation IDs, metrics, structured logs, Prometheus,
Grafana, the alert rules, Docker healthchecks, database passwords and least-privilege roles are on in
**every** mode. They are how the modes are measured and how credentials are handled, not behaviour
under test. The replicas, the standby, the second gateway container and the checksums exist in every
mode. Hardware redundancy without the software that uses it is exactly what the baseline measures.
