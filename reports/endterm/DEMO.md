# Demonstration script

The live demo is [`experiments/demo.ts`](../../experiments/demo.ts) (`npm run demo`). It runs against the
local Docker stack only, with synthetic data. The spec asks for at least 3 scenarios, including one
service failure and one security test. The default order covers both kinds and adds a database failure:

| # | Demo | Kind | What the audience sees |
|---|---|---|---|
| 1 | `app-crash` | service failure | student-1 kills itself; reads stay 2xx and the restart policy brings it back |
| 2 | `db-failure` | data-store failure | reads served by the standby or stale cache, payments fail fast |
| 3 | `gateway-failure` | service failure (endterm addition) | gateway-1 is killed under live traffic; a per-second status histogram stays 2xx |
| 4 | `unauthorized` | security | missing/forged/expired/`alg:none` tokens get 401, s7 paying for s8 gets 403; audit lines by `rid`; DB unchanged |
| 5 | `abuse` | security / misuse | malformed input gets 422/400/413 (never 5xx), a burst gets 429 with `Retry-After`, brute force gets 429; every instance stays healthy |

Four more demos run on request: `outlier` (a slow replica is ejected, shown by the gateway gauge),
`alerts` (Prometheus alerts during a database failure), `node-failure` and `timetable` (both from the
midterm).

> **Recording:** there is no screen recording. The rehearsal ran in a headless sandbox, where a
> screen capture is not possible. **The team still has to record a video** of `npm run demo` (and
> the Grafana and Prometheus windows next to it) as the fallback for the live demo, and link it here.
> What the rehearsal did produce is the real terminal output of every demo, captured on 2026-11-09
> with ANSI colour codes stripped:
>
> | Mode | Transcripts in [`demo/`](demo/) |
> |---|---|
> | endterm | [`app-crash`](demo/endterm-app-crash.txt), [`db-failure`](demo/endterm-db-failure.txt), [`gateway-failure`](demo/endterm-gateway-failure.txt), [`unauthorized`](demo/endterm-unauthorized.txt), [`abuse`](demo/endterm-abuse.txt), [`outlier`](demo/endterm-outlier.txt), [`alerts`](demo/endterm-alerts.txt); the whole default order in one run: [`npm run demo`](demo/endterm-default-order.txt) |
> | baseline (contrast) | [`unauthorized`](demo/baseline-unauthorized.txt), [`abuse`](demo/baseline-abuse.txt) |
>
> Each file starts with the command that produced it and ends with its exit code. `node-failure` and
> `timetable` (midterm demos) and the midterm mode were not part of this rehearsal.

## Before the demo

1. Bring up the mode to show. All three work, and each demo prints what to expect in the deployed mode:

   ```bash
   npm run up:endterm      # or up:baseline / up:midterm for the contrast
   npm run mode            # prints baseline | midterm | endterm
   ```

2. Open these three windows next to the terminal:
   - Grafana: `http://localhost:3000/d/university` (anonymous read-only)
   - Prometheus alerts: `http://localhost:9090/alerts`
   - a second terminal for `tail -f logs/events.jsonl | grep <rid>` when you want to show one request's trail.
3. Do not run the demo while an experiment or the campaign is running. Both drive the same stack, and
   the demo's faults would land in the campaign's measurements.

The demo reads its secrets from the generated `.env` and never prints them:
- `DEMO_PASSWORD`: endterm logs in as `bursar` (staff) for the client traffic, as `s7` for the security demos, and as `admin` for the timetable job.
- `CHAOS_TOKEN`: sent as `x-chaos-token` on every `/chaos` call. Endterm refuses `/chaos` without it, and baseline and midterm ignore it.
- `JWT_SECRET`: used only to make an *expired* token with a genuine signature, and a forged one signed with a different key.

In baseline and midterm there is no authentication in the request path, so the demo does not log in
and sends its requests without `Authorization`.

## Running it

```bash
npm run demo                    # default order: app-crash, db-failure, gateway-failure, unauthorized, abuse
npm run demo -- full            # all nine demos
npm run demo -- unauthorized    # one demo
```

With more than one demo, it waits for Enter between them when stdin is a terminal. Piped or
redirected, it runs straight through, which is how the transcripts in [`demo/`](demo/) were captured:

```bash
npm run -s demo -- abuse 2>&1 | sed -r 's/\x1b\[[0-9;]*m//g' > reports/endterm/demo/endterm-abuse.txt
```

Every demo starts with a line
`expected in <mode>: ...` and ends with `Grafana (this step): <url>`. That link opens the dashboard on
that demo's own time window, padded by 15 s on each side.

## Script, step by step

Each output block below is quoted from the rehearsal transcripts in [`demo/`](demo/) (endterm unless
marked baseline). Only the `deployed mode:` header, the `expected in <mode>:` line and the closing
`Grafana (this step):` link are left out of the quotes; they are in the files. Counts, latencies and
request ids differ on every run. The per-mode tables give the expectation from the design (the
`EXPECT` table in `demo.ts`): the endterm rows and the baseline rows of `unauthorized` and `abuse`
were checked against the rehearsal, while the other baseline and midterm rows were not rehearsed.

### 1. Application crash (`app-crash`, about 10 s)

Say: "student-1 kills its own process. Watch the read histogram."

From [`demo/endterm-default-order.txt`](demo/endterm-default-order.txt):

```text
  before   students: 200 x20
  >> student-1 crashed (POST /chaos/crash)
  during   students: 200 x40
           gateway view: {"http://student-1:3000":false,"http://payment-1:3000":true,"http://payment-2:3000":true,"http://timetable-2:3000":true,"http://student-2:3000":true,"http://timetable-1:3000":true,"http://transcript-1:3000":true,"http://auth-1:3000":true}
  after 8s students: 200 x20
```

`gateway view` is the health-check verdict per instance of the gateway that answered `/health`. The
restart policy brings student-1 back within a few seconds, so the verdict may already read `true`
again by the time it is printed: in the standalone run ([`demo/endterm-app-crash.txt`](demo/endterm-app-crash.txt))
it did. The reads were 2xx in both runs.

| Mode | Expected |
|---|---|
| baseline | `during` and `after` show failures (no health check or retry; the restart policy is `no`, so student-1 stays down) |
| midterm | `during` is all 2xx (the health check and retry route around it); student-1 is back `after 8s` |
| endterm | as midterm (rehearsed: 200 x40 during, 200 x20 after) |

Point at: Grafana "Instance health (gateway health check and Prometheus scrape)" (student-1 drops and
comes back), and `InstanceDown` on the Prometheus page (it may fire if the restart takes more than 4 s).

### 2. Database failure (`db-failure`, about 25 to 30 s)

Say: "We stop the PostgreSQL primary."

From [`demo/endterm-db-failure.txt`](demo/endterm-db-failure.txt):

```text
  before   students: 200 x10   transcripts: 200 x5   payments: 201 x3
  >> postgres-primary stopped
  during   students: 200 x4  203 x1   transcripts: 203 x5   payments: 503 x3
  >> postgres-primary started
  after    students: 200 x5  203 x5   transcripts: 200 x5   payments: 201 x3
```

Most of the 25 to 30 s is `docker compose stop` and `start` of the primary. In this run some
student reads were still served from the stale cache (`203`) 6 s after the restart; in the
default-order run the `after` line was all 200 (`students: 200 x10`).

| Mode | Expected `during` line |
|---|---|
| baseline | students, transcripts and payments fail (5xx or `000`) |
| midterm | students 200 (hot standby), transcripts 200 or 203 (stale cache), payments 503 (fail fast, nothing hangs) |
| endterm | as midterm (rehearsed: students 200/203, transcripts 203, payments 503) |

Point at: Grafana "Database primary" (`pg_up` drops to 0) and "Gateway error ratio (5xx share)". The `alerts` demo shows `DatabaseDown` firing.

### 3. Gateway failure (`gateway-failure`, 16 s)

Say: "Four clients keep reading and paying through nginx. At t+3 s we kill gateway-1, and at t+11 s we
start it again. Each line is one second of client traffic."

From [`demo/endterm-gateway-failure.txt`](demo/endterm-gateway-failure.txt) (lines t+5 s to t+9 s cut):

```text
  t+ 0s  200 x94  201 x45             avg    8 ms  p95   17 ms
  t+ 1s  200 x89  201 x46             avg   10 ms  p95   19 ms
  t+ 2s  200 x100  201 x50            avg    7 ms  p95   11 ms
  t+ 3s  >> kill gateway-1 (docker compose kill)
  t+ 3s  200 x81  201 x37             avg   14 ms  p95   31 ms
  t+ 4s  200 x93  201 x47             avg    8 ms  p95   14 ms
  ...
  t+10s  200 x97  201 x48             avg    8 ms  p95   13 ms
  t+11s  >> start gateway-1
  t+11s  200 x84  201 x43             avg   11 ms  p95   21 ms
  ...
  t+15s  200 x99  201 x48             avg    7 ms  p95   12 ms
  while gateway-1 was down: 200 x731  201 x362
  instances now: gateway-1 up, gateway-2 up, auth-1 up, student-1 up, student-2 up, payment-1 up, payment-2 up, transcript-1 up
```

Both endterm runs (this one and the default-order run) had no non-2xx answer in any second.

| Mode | Expected from t+3 s to t+11 s |
|---|---|
| baseline | nginx has only gateway-1 (`single.conf`): every request is `502` or `000` |
| midterm | same as baseline: the single gateway is a single point of failure |
| endterm | nginx fails over to gateway-2 (`redundant.conf`, `max_fails=1`, 1 s connect timeout): 2xx throughout. At most a handful of requests in flight at the kill take the retry path. A re-sent payment carries the client's `Idempotency-Key`, so it is not charged twice |

Point at: Grafana "Gateway request rate by status" (no gap in endterm) and
`InstanceDown{instance="gateway-1:8080"}` on the Prometheus page. In both endterm rehearsal runs a
Prometheus `ALERTS` query over the demo's window showed `InstanceDown` for `gateway-1:8080` going
pending and then firing.

### 4. Unauthorized access (`unauthorized`, about 2 s)

Say: "An attacker tries to pay 13.37 into student s8's account five ways: with no token, with an
admin token signed with the wrong key, with an expired admin token, with an unsigned (`alg:none`)
admin token, and as student s7 with s7's real token."

From [`demo/endterm-unauthorized.txt`](demo/endterm-unauthorized.txt):

```text
  each attack is POST /api/payments {studentId: "s8", amount: 13.37}
  no token                         -> 401   rid=attack-demo-1794257006877-0
  forged signature (admin claims)  -> 401   rid=attack-demo-1794257006877-1
  expired token (admin claims)     -> 401   rid=attack-demo-1794257006877-2
  alg:none token (admin claims)    -> 401   rid=attack-demo-1794257006877-3
  student s7 pays for s8           -> 403   rid=attack-demo-1794257006877-4
  audit lines for these rids (logs/events.jsonl):
    gateway-2  rid=attack-demo-1794257006877-0  deny 401 missing_token  POST /api/payments  sub=-
    gateway-1  rid=attack-demo-1794257006877-1  deny 401 bad_signature  POST /api/payments  sub=-
    gateway-2  rid=attack-demo-1794257006877-2  deny 401 expired  POST /api/payments  sub=-
    gateway-1  rid=attack-demo-1794257006877-3  deny 401 malformed  POST /api/payments  sub=-
    gateway-2  rid=attack-demo-1794257006877-4  deny 403 not_owner  POST /api/payments  sub=s7 (student)
  attacker payments in the DB (amount 13.37): before 0, after 0
  PASS: all 5 refused (401 x4  403 x1); DB unchanged
  follow one request through every hop: grep attack-demo-1794257006877-0 logs/events.jsonl
```

The `alg:none` token is refused with reason `malformed`: the verifier only accepts HS256, so an
unsigned token fails before any claim is read. nginx alternates the requests between the two
gateways, and each gateway writes its own audit line.

The same demo in baseline, from [`demo/baseline-unauthorized.txt`](demo/baseline-unauthorized.txt):

```text
  each attack is POST /api/payments {studentId: "s8", amount: 13.37}
  (baseline: no login, so the s7 attack goes out without a token as well)
  no token                         -> 201   rid=attack-demo-1794257195787-0
  forged signature (admin claims)  -> 201   rid=attack-demo-1794257195787-1
  expired token (admin claims)     -> 201   rid=attack-demo-1794257195787-2
  alg:none token (admin claims)    -> 201   rid=attack-demo-1794257195787-3
  student s7 pays for s8           -> 201   rid=attack-demo-1794257195787-4
  audit lines for these rids (logs/events.jsonl):
    (none: baseline has no policy enforcement point)
  attacker payments in the DB (amount 13.37): before 0, after 5
  ACCEPTED: 5 of 5 unauthorized requests answered 2xx; 5 attacker payment(s) written to the DB
```

| Mode | Expected |
|---|---|
| baseline | every attack is accepted (2xx); `after` is `before + 5`; no audit lines; the verdict reads `ACCEPTED: 5 of 5 ...` (rehearsed: as quoted above) |
| midterm | same as baseline |
| endterm | 401 x4, 403 x1; one audit `deny` line per rid; `after == before`; `PASS` (rehearsed: as quoted above, twice; transcripts `demo/endterm-unauthorized.txt` and `demo/endterm-default-order.txt`) |

Point at: the audit lines (no password, token or `Authorization` header in them, Task 9). Then run
the `grep` the demo prints. It shows every line logged under that `rid`: nginx forwards the
client's `X-Request-ID`, so the gateway's request line and its audit line carry the same id. In the
rehearsal, `grep attack-demo-1794257006877-0 logs/events.jsonl` returned two lines from gateway-2,
the audit line (`"kind": "audit", "outcome": "deny", "reason": "missing_token", "status": 401`) and
the request line (`"kind": "request", "target": "POST /api/payments", "status": 401`). The request
stops at the gateway, so no other service logs it. In Grafana: "Auth denied and rate limited". Five denials are far below the
`AuthFailureSpike` threshold (more than about 60 in 30 s, ALERTS.md), so the alert does not fire here.
The `abuse` demo right after it does reach that volume.

The DB check counts payments with the attack amount 13.37, which no legitimate request uses. It runs
`psql` as the operator over `docker compose exec`, the same way the experiment harness does.

### 5. Abuse (`abuse`, about 3 to 5 s)

Say: "Now misuse rather than intrusion: bad input, a flood and a password guesser."

From [`demo/endterm-abuse.txt`](demo/endterm-abuse.txt):

```text
  malformed input (23 requests: 20 bad payment bodies, invalid JSON, 1 MiB body, bad path):
    400 x2  413 x1  422 x20
  burst: 1000 GETs of /api/students/s7 as s7 in 863 ms
    2xx 56   429 944 (Retry-After on 944, e.g. "1")   other 0
  login brute force: 20 wrong passwords for s7: 401 x10  429 x10   (first 429 at attempt 11)
  instances after the abuse: gateway-1 up, gateway-2 up, auth-1 up, student-1 up, student-2 up, payment-1 up, payment-2 up, transcript-1 up
```

56 admitted is within the cluster quota: 2 x (20 + 10/s x 0.863 s) is about 57.

The same demo in baseline, from [`demo/baseline-abuse.txt`](demo/baseline-abuse.txt):

```text
  malformed input (23 requests: 20 bad payment bodies, invalid JSON, 1 MiB body, bad path):
    201 x5  400 x9  404 x5  413 x1  422 x1  503 x2
    201 ACCEPTED  {"studentId":"s7","amount":10000.01}
    503 SERVER ERROR  {"studentId":"s7","amount":1000000000}
    201 ACCEPTED  {"studentId":"s7","amount":1.001}
    201 ACCEPTED  {"studentId":"s7","amount":true}
    503 SERVER ERROR  {"studentId":7,"amount":100}
    201 ACCEPTED  {"studentId":"s7","amount":100,"admin":true}
    201 ACCEPTED  {"studentId":"s7","amount":100,"note":"xxxxxxxxxxxxxxxxxxxxxxxxxxxx...
  burst: 600 GETs of /api/students/s7 as s7 in 2142 ms
    2xx 600   429 0 (Retry-After on 0)   other 0
  login brute force: 20 wrong passwords for s7: 401 x20
  instances after the abuse: gateway-1 up, gateway-2 up, auth-1 up, student-1 up, student-2 up, payment-1 up, payment-2 up, transcript-1 up
```

The burst is sent in waves of 50 with a 2 s budget (`sendBurst` in `attacks.ts`): it stops after the
first wave that ends past the budget. Endterm answers the 429s fast enough to send all 1000; baseline
serves every request and runs out of budget after 600.

| Mode | Expected |
|---|---|
| baseline | some malformed bodies are listed as `ACCEPTED` (rehearsed: an amount above 10 000, three decimals, `true`, and extra fields) or `SERVER ERROR` (rehearsed: `amount: 1e9` overflows `NUMERIC(10,2)`, and a numeric `studentId`); the burst is all 2xx; the brute force is 20 x 401 |
| midterm | same as baseline |
| endterm | malformed: only 422/400/413, nothing listed; burst: at most about 2 x (20 + 10/s x window) answered 2xx (two gateways, each with the student quota), the rest 429, every 429 with `Retry-After`; brute force: 401 for the first 5 to 10 tries (5 per gateway), then 429; every instance `up` (rehearsed: as quoted above, twice) |

Point at: Grafana "Auth denied and rate limited" (the `rate_limited` series) and, in endterm,
`AuthFailureSpike` on the Prometheus page (the burst alone is several hundred denials). In the
rehearsal a Prometheus `ALERTS` query over the endterm abuse demo's window showed `AuthFailureSpike`
pending and then firing.

After the brute force, the login quota (1/s per client IP, burst 5) blocks new logins for a few
seconds. The demo logs in at the start of each demo and reuses its tokens for up to 10 minutes, so
this does not affect the next demo.

### Optional: outlier ejection (`outlier`, 24 s)

Say: "student-1 becomes slow: 3 s per request. Watch the latency columns and the `ejected:` column,
read from each gateway's `/metrics`."

From [`demo/endterm-outlier.txt`](demo/endterm-outlier.txt) (lines t+5 s to t+10 s and t+19 s to t+22 s cut):

```text
  t+ 0s  200 x155                     avg    6 ms  p95   12 ms   ejected: gw1=- gw2=-
  t+ 1s  200 x150                     avg    6 ms  p95   13 ms   ejected: gw1=- gw2=-
  t+ 2s  >> student-1 slow: +3000 ms per request (/chaos latencyMs)
  t+ 2s  200 x14                      avg  243 ms  p95  833 ms   ejected: gw1=student-1 gw2=-
  t+ 3s  200 x34                      avg  107 ms  p95  841 ms   ejected: gw1=student-1 gw2=student-1
  t+ 4s  200 x150                     avg    7 ms  p95   11 ms   ejected: gw1=student-1 gw2=student-1
  ...
  t+11s  200 x154                     avg    6 ms  p95    8 ms   ejected: gw1=student-1 gw2=student-1
  t+12s  200 x137                     avg    8 ms  p95   19 ms   ejected: gw1=- gw2=student-1
  t+13s  200 x17                      avg  201 ms  p95  854 ms   ejected: gw1=student-1 gw2=-
  t+14s  200 x37                      avg   98 ms  p95  853 ms   ejected: gw1=student-1 gw2=student-1
  t+15s  200 x154                     avg    6 ms  p95    8 ms   ejected: gw1=student-1 gw2=student-1
  ...
  t+18s  >> student-1 healthy again (latencyMs 0)
  t+18s  200 x148                     avg    7 ms  p95   11 ms   ejected: gw1=student-1 gw2=student-1
  ...
  t+23s  200 x140                     avg    8 ms  p95   18 ms   ejected: gw1=- gw2=student-1
  the gauge is instance_ejected{target} on each gateway's /metrics (Grafana panel "Outlier ejection")
```

The p95 of about 840 ms in the seconds of ejection is the 800 ms attempt timeout paid by the requests
that hit student-1 before it was ejected. At t+12 s to t+14 s the 10 s ejection expired, student-1 was
probed, timed out again and was ejected again. After student-1 is healthy (t+18 s) the ejection stays
until it expires, which happened on gateway-1 at t+23 s.

| Mode | Expected from t+2 s to t+18 s |
|---|---|
| baseline | requests that land on student-1 take about 3 s (one attempt, no timeout); `ejected: gw1=- gw2=-` (no ejection) |
| midterm | each request that lands on student-1 pays the 800 ms attempt timeout before the retry on student-2; `ejected: gw1=- gw2=-` (the breaker is per pool and the retry succeeds, so nothing is taken out) |
| endterm | after 3 consecutive timeouts on a gateway, `ejected: gw1=student-1 gw2=student-1`, and avg/p95 drop back; every 10 s the ejection expires, student-1 is probed again and ejected again while it is still slow (rehearsed: as quoted above) |

Point at: Grafana "Outlier ejection" and "Upstream attempts by instance and outcome" (`timeout` for
student-1).

### Optional: alerting (`alerts`, up to about 100 s; about 20 s in the rehearsal)

Say: "Monitoring runs in every mode. We stop the primary again and watch Prometheus decide."

From [`demo/endterm-alerts.txt`](demo/endterm-alerts.txt):

```text
  alerts before: (none firing or pending)   (http://localhost:9090/alerts)
  t+0.4s  >> postgres-primary stopped
  t+0.4s  (none)
  t+4.4s  pending  DatabaseDown
  t+8.5s  firing   DatabaseDown
  DatabaseDown firing 8.5 s after the stop (1 s polling)
  t+10.5s  firing   DatabaseDown | pending  HighErrorRate | pending  HighLatencyP95
  t+16.9s  >> postgres-primary started
  t+16.9s  firing   DatabaseDown | firing   HighErrorRate | firing   HighLatencyP95
  t+18.9s  firing   HighErrorRate | firing   HighLatencyP95
  DatabaseDown resolved 2.0 s after the restart
  client traffic during the demo: 200 x27  201 x15  203 x27  503 x11
```

The configuration bounds the detection time at about 4 to 10 s (ALERTS.md). The time the demo
prints is the live observation: 8.5 s in this single run, which is one sample, not a measurement of
the detection-time distribution (that is in RESULTS.md). `HighErrorRate` and `HighLatencyP95` also
fired here. The payments that fail fast with 503 (11 of the 80 client requests) are well above the
5 % threshold, and the gateway p95 went above 1 s while the primary was down (the two client loops
completed only 80 requests in about 19 s). This rehearsal did not break the latency down further.
Both alerts resolve on their own a little after the demo ends; the demo does not wait for them. Light client traffic runs throughout, because `HighErrorRate` is a
ratio and cannot fire without requests. `HighErrorRate` may fire in every mode (payments fail), and
is expected in baseline (the reads fail too).

### Optional: node failure and timetable (midterm demos)

`node-failure` kills student-1 and payment-1 together. In midterm and endterm, the surviving node
carries everything. In baseline, about half of the requests fail.

`timetable` starts a 120-step job and crashes its owner. In midterm and endterm, the job resumes
from its last checkpoint on the other replica and reaches `done`. In baseline, it stays `running`.
In endterm, the job is started with the `admin` token, because only admin may `POST /api/timetables`.

## After the demo

Every fault the demo injects is repaired by the demo itself (`docker compose start`, `/chaos` reset).
If a demo is interrupted (Ctrl-C), repair by hand:

```bash
node --experimental-strip-types experiments/scenarios.ts db-failure repair       # or app-crash / gateway-failure / node-failure
curl -s -X POST localhost:3011/chaos -H 'content-type: application/json' \
  -H "x-chaos-token: $(grep ^CHAOS_TOKEN .env | cut -d= -f2)" -d '{"latencyMs":0}'   # after an interrupted outlier demo
```

In baseline and midterm, the security demos write rows: the accepted attacker payments and some
malformed payments. The experiment harness truncates `payments` and removes non-seed students before
every run (`experiments/run.ts`), so the demo cannot leak into measurements. `npm run up:<mode>` keeps the data volumes. For a clean
database before a second demo, run `docker compose down -v` and then `npm run up:<mode>`.
