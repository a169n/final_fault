# Demonstration script

The assignment asks for a live or recorded demonstration of at least four scenarios. `npm run demo`
runs six, in about four minutes, against whichever configuration is deployed, and prints what to
expect before each one. A captured transcript of the final configuration is in [`demo/`](demo/); the baseline transcript was not recorded before the deadline.

## Preparation (two minutes before)

```bash
npm run up:final            # or up:baseline for the contrast
npm run mode                # -> final
```

Open three browser tabs:

| Tab | URL | Look at |
|---|---|---|
| Grafana | http://localhost:3000/d/university | "Gateway request rate by status", "Instance health", "Database nodes: who accepts writes" |
| Prometheus | http://localhost:9090/alerts | which alerts are pending or firing |
| Controller | http://localhost:3061/health | `writer`, and each node's `role` |

Wait until `curl -s localhost:3061/health` shows one `primary` with `"standbys":1,"sync":true`.

## The run

```bash
npm run demo                # the six scenarios below, Enter between them
npm run demo -- db-failover # one scenario
npm run demo -- full        # all eleven
```

| # | Scenario | What is done | What to point at in final | In the baseline |
|---|---|---|---|---|
| 1 | `app-crash` | student-1 kills its own process | status histogram stays 2xx; the gateway's view shows student-1 down, then up again (restart policy) | about half of the reads fail and the replica stays down |
| 2 | `db-failover` | the database primary is stopped under live payments, and started again 20 s later | per-second lines: a few seconds of 503 on payments, then 2xx **with the primary still down**; the controller line changes `writer`; after the start the old primary shows `standby` | payments (and reads) fail from the stop to the start |
| 3 | `restore` | 60 payments, then `TRUNCATE payments` as the superuser, then a restore | the ledger line goes to 0; `PaymentRecordsLost` fires; the restore reports the checksum, the payments in the backup and how many were merged back; the ledger line is balanced again | "no backup found": the payments are gone |
| 4 | `gateway-failure` | gateway-1 is killed under live traffic | the histogram stays 2xx: nginx fails over | every request fails until gateway-1 is started |
| 5 | `unauthorized` | no token, forged, expired and `alg:none` tokens; student s7 pays for s8 | 401 / 401 / 401 / 401 / 403; one audit line per attempt; the database is unchanged | every attack is accepted |
| 6 | `abuse` | malformed bodies, a burst of 1 000 requests, 50 wrong logins | 422 / 400 / 413, never 5xx; 429 with `Retry-After`; brute force limited after 5 | accepted, or a 5xx |

Each scenario ends by printing a Grafana link for its own time window.

## What each scenario demonstrates

| Scenario | Mechanisms | Assignment work package |
|---|---|---|
| `app-crash` | health check (S4), retry (S1), restart policy (H3) | D, E |
| `db-failover` | automatic failover (H8), writer discovery (S12), synchronous replication, rejoin, fail-fast writes (S8) | C, D, E |
| `restore` | backups and merge restore (H9), `PaymentRecordsLost` | C, F |
| `gateway-failure` | redundant gateways (H6), idempotency on the re-sent POST (S5) | C |
| `unauthorized` | authentication, authorization, audit | G |
| `abuse` | validation, rate limiting | G |

## Questions the demonstration tends to raise

- **"How do the services know where the new primary is?"** They ask both nodes twice a second and
  write to the one that is not in recovery and has the highest timeline. Show
  `grep writer_changed logs/events.jsonl | tail`.
- **"What if the old primary comes back with its old data?"** It compares timelines with its peer
  at start, sees it is behind and rebuilds itself as a standby. Show
  `docker compose logs postgres-primary | grep node.sh`.
- **"Could a payment be lost in the failover?"** Not an acknowledged one: commits wait for the
  standby. The campaign found none in any failover (REPORT.md §10.3). The cost is measured in E13.
- **"Why not restore the newest backup?"** Because after a data-loss incident the newest backup
  already contains the damage. The first smoke run of E11 did exactly that and restored nothing.
- **"What is still a single point of failure?"** nginx and the host. `docker compose kill nginx`
  shows it.

## After the demonstration

```bash
docker compose down -v      # stop everything and delete the volumes
```
