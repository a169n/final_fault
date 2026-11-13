# Architecture

The deployment is `docker-compose.yml`; every box below is one container. The diagrams show the
**final** configuration. The baseline runs the same containers and does not use the redundancy
(TEST-PLAN.md §2).

## 1. Deployment and data flows

```mermaid
flowchart LR
  client([Client / load generator])

  subgraph edge[Entry]
    nginx[nginx :8080<br/>only public port]
  end

  subgraph gw[Gateway tier · policy enforcement point]
    g1[gateway-1]
    g2[gateway-2]
  end

  subgraph svc[Services]
    auth[auth-1<br/>issues JWTs]
    s1[student-1]
    s2[student-2]
    p1[payment-1]
    p2[payment-2]
    t1[transcript-1]
    tt1[timetable-1]
    tt2[timetable-2]
  end

  subgraph db[Data store]
    pgA[(postgres-primary<br/>node A)]
    pgB[(postgres-replica<br/>node B)]
    ctl[db-controller<br/>promote · fence · sync]
    bak[db-backup<br/>pg_dump every 15 s]
    vol[/backups volume/]
  end

  subgraph mon[Monitoring plane · every mode]
    prom[Prometheus<br/>11 alert rules]
    graf[Grafana]
    ex1[postgres-exporter]
    ex2[postgres-exporter-replica]
  end

  client -->|HTTP + Bearer JWT| nginx
  nginx -->|failover| g1 & g2
  g1 & g2 -->|health check · retry · timeout<br/>breaker · ejection| s1 & s2 & p1 & p2 & t1 & tt1 & tt2
  g1 & g2 --> auth
  s1 & s2 & p1 & p2 & t1 & tt1 & tt2 & auth -->|writes to the writer<br/>reads fall back to the other node| pgA
  s1 & s2 & p1 & p2 & t1 & tt1 & tt2 & auth -.-> pgB
  pgA ==>|synchronous streaming replication| pgB
  ctl -->|probe every 1 s| pgA & pgB
  bak -->|read-only dump| pgA
  bak --> vol
  ex1 --> pgA
  ex2 --> pgB
  prom -->|scrape every 2 s| g1 & g2 & s1 & p1 & ctl & ex1 & ex2
  graf --> prom
```

`postgres-primary` and `postgres-replica` are the names of the two database nodes, not their roles:
both run the same start script, and after a failover `postgres-replica` is the primary and
`postgres-primary` the standby.

## 2. Service boundaries and dependencies

| Component | Instances | Responsibility | Depends on | State |
|---|---|---|---|---|
| nginx | 1 | public entry point, failover between gateways | gateways | none |
| gateway | 2 | authentication, authorization, validation, rate limiting, audit; load balancing, health checks, retry, timeout, circuit breaker, outlier ejection, stale-cache degradation | services, `JWT_SECRET` | in memory (breaker, ejection, cache, rate-limit buckets) |
| auth | 1 | verifies passwords (scrypt), issues 15-minute JWTs | database | none |
| student | 2 | student records | database | none |
| payment | 2 | the critical workflow: idempotency check → checkpoint → atomic charge → completion | database | none (the checkpoint is in the database) |
| transcript | 1 | grade transcripts | database | none |
| timetable | 2 | long-running timetable jobs with checkpoints | database | none (checkpoints in the database) |
| PostgreSQL | 2 nodes | the persistent data store: students, payments, grades, timetable jobs, users | volume per node | durable |
| db-controller | 1 | observes both nodes; in final promotes, fences, switches synchronous replication | both nodes | in memory |
| db-backup | 1 | verified `pg_dump` every 15 s, 20 kept | one node | `backups/` |
| Prometheus, Grafana, exporters | 1 each | metrics, alert rules, dashboard | scrape targets | in memory |

## 3. The critical workflow: a payment

```mermaid
sequenceDiagram
  participant C as Client
  participant N as nginx
  participant G as gateway
  participant P as payment
  participant D as PostgreSQL (writer)
  participant S as standby

  C->>N: POST /api/payments (Idempotency-Key, Bearer token)
  N->>G: forward (to the other gateway if this one is down)
  G->>G: verify token, check policy, validate body, rate limit, audit
  G->>P: forward, 0.8 s timeout, up to 3 attempts across replicas
  P->>D: INSERT payment (key, state = pending)  [checkpoint]
  alt key already exists
    P-->>G: 200 + stored result (no second charge)
  else new payment
    P->>D: BEGIN, lock student row, balance += amount, state = completed, COMMIT
    D->>S: WAL, commit waits for the standby (synchronous)
    P-->>G: 201
  end
  G-->>C: response with x-request-id
```

Where each step can fail and what answers it:

| Failure | Mechanism | Result |
|---|---|---|
| gateway dies | nginx failover; the client's key makes the re-send safe | request served by the other gateway |
| payment replica dies or is slow | health check, timeout, retry on the other replica, outlier ejection | request served by the other replica |
| crash between checkpoint and charge | the sweep rolls back a pending row older than 15 s; a client retry with the same key gets the stored result | no half-applied payment, no double charge |
| database primary dies | controller promotes the standby; services find the new writer; synchronous replication means the standby already has every acknowledged payment | payments resume in a few seconds, none lost |
| records destroyed | backup + merge restore | payments up to the last backup are recovered |

## 4. Redundancy, replication and backup

| Layer | Redundancy | Failure handling | What remains single |
|---|---|---|---|
| Entry | 1 nginx | restart policy | **nginx** (one public port on one host) |
| Gateway | 2, active-active | nginx `proxy_next_upstream` | – |
| student, payment, timetable | 2 each, active-active | gateway health check, retry, ejection | – |
| transcript | 1 | stale cache serves reads | **transcript-1** (degrades, does not fail) |
| auth | 1 | tokens are verified locally by the gateways | **auth-1** (no new logins while it is down) |
| Database | primary + hot standby, synchronous | automatic promotion, fencing, automatic rejoin | – (for one node failure) |
| Data | 20 verified dumps, 15 s apart | merge restore | the backups are on the same host |
| Controller | 1 | restart policy; without it the database behaves as in endterm (no automatic promotion) | **db-controller** (fail-safe: its failure causes no outage) |
| Host | 1 | – | **the Docker host** (common mode) |

## 5. Database failover in detail

```mermaid
stateDiagram-v2
  [*] --> Healthy: primary + streaming standby,<br/>synchronous replication on
  Healthy --> NoWriter: primary stops answering
  NoWriter --> Healthy: primary answers again<br/>within 3 probes (a blip)
  NoWriter --> Promoted: 3 probes without a writer<br/>AND standby was in sync<br/>→ pg_promote()
  NoWriter --> Refused: standby was NOT in sync<br/>→ no promotion, alert
  Promoted --> Single: new primary on timeline + 1,<br/>services switch writer
  Single --> Fenced: old primary started with old data<br/>→ made read-only
  Single --> Healthy: old primary restarted<br/>→ node.sh clones the new primary,<br/>rejoins as standby, sync on again
  Healthy --> Async: standby lost for 2 probes<br/>→ synchronous replication off
  Async --> Healthy: standby streaming again
```

- **Detection:** the controller probes both nodes once a second; three consecutive probes without
  a writable node trigger the promotion (`FAILOVER_THRESHOLD`).
- **Writer discovery:** every service asks both nodes for their role twice a second, and at once
  after a failed write. Writes go to the node that is not in recovery, not fenced, and on the
  highest timeline (`pick_writer`, `app/fault_tolerance/infrastructure/db_failover.py`).
- **No acknowledged write is lost:** while a standby streams, commits wait for it. A standby that
  was not in sync when the primary was last seen is never promoted.
- **No split brain between services:** a promotion always starts a new timeline, so a stale
  primary that comes back loses the comparison everywhere, and the controller makes it read-only.
- **Rejoin:** when the old primary's container starts and finds its peer is a primary on a higher
  timeline, it discards its data and clones the peer (`config/postgres/scripts/node.sh`).

## 6. Fault tree for "a payment cannot be made"

```mermaid
flowchart TD
  top[Payment cannot be made] --> or1{OR}
  or1 --> host[Docker host down]
  or1 --> ng[nginx down]
  or1 --> gws{AND}
  gws --> g1[gateway-1 down]
  gws --> g2[gateway-2 down]
  or1 --> pays{AND}
  pays --> p1[payment-1 down]
  pays --> p2[payment-2 down]
  or1 --> dbs{OR}
  dbs --> both{AND}
  both --> a[node A down]
  both --> b[node B down]
  dbs --> nofo{AND}
  nofo --> one[writer down]
  nofo --> ctl[controller down OR standby not in sync]
  or1 --> authx{AND}
  authx --> au[auth-1 down]
  authx --> tok[client has no valid token]
```

First-order cut sets (single points of failure) in final: the host and nginx. In the baseline every
leaf of the tree is a first-order cut set for the requests that reach it, because nothing fails over.

## 7. Trust boundaries

Unchanged from the endterm (`THREAT-MODEL.md` §1): B1 client → nginx, B2 nginx → gateways,
B3 gateway → services, B4 services → PostgreSQL, B5 host and operator. The final adds two
principals inside B4, each with its own least-privilege database role: the controller (`failover`)
and the backup sidecar (`backup`).
