# Baseline vs fault-tolerant: results and comparison

All twelve runs use an identical 70 s observation window, an identical workload
(10 concurrent clients; 60 % student reads, 20 % transcript reads, 20 % payments,
of which 20 % are client-side resends of the same payment intent) and an identical
fault injected at T+20 s with an operator repair at T+45 s. The two versions are
the same container image; only `FT_ENABLED` and the restart policy differ.

## 1. Headline comparison

| Scenario | Failed (baseline) | Failed (FT) | Avail. req (base) | Avail. req (FT) | Detect (base) | Detect (FT) | Dup. charges (base) | Dup. (FT) | Orphans (base) | Orphans (FT) |
|---|---|---|---|---|---|---|---|---|---|---|
| Application crash | 1200 / 11982 | **1 / 12350** | 89.98 % | **99.99 %** | 57 ms | 103 ms | 445 | **0** | 0 | **0** |
| Database failure | 35 / 7175 | **532 / 8704** | 99.51 % | **93.89 %** | 284 ms | 367 ms | 258 | **0** | 0 | **0** |
| Network / service timeout | 0 / 8261 | **0 / 8646** | 100.00 % | **100.00 %** | -- | 848 ms | 334 | **0** | 0 | **0** |
| Hardware / node failure | 1845 / 12469 | **0 / 12645** | 85.20 % | **100.00 %** | 99 ms | 359 ms | 305 | **0** | 0 | **0** |
| Corrupted / lost transaction | 1084 / 12531 | **190 / 12567** | 91.35 % | **98.49 %** | 12 ms | 6 ms | 307 | **0** | 2 | **0** |
| High load | 96 / 40882 | **66 / 39217** | 99.77 % | **99.83 %** | 49930 ms | 49840 ms | 1561 | **0** | 0 | **0** |

## 2. Campaign totals

| Measure | Baseline | Fault-tolerant | Change |
|---|---|---|---|
| Runs | 6 | 6 | |
| Total requests | 93300 | 94129 | |
| Failed requests | **4260** | **789** | 81.5 % fewer |
| Availability (request-based) | 95.43 % | 99.16 % | |
| Availability (time-based) | 99.74 % | 100.00 % | |
| Observed outages | 1 | 0 | |
| Total downtime | 10.0 s | 0.0 s | |
| MTTF | 413.1 s | > 423 s (censored) | |
| MTBF | 423.1 s | n/a | |
| MTTR | 10.0 s | n/a (nothing to repair) | |
| Observed failure rate | 8.5 /h | 0.0 /h | |
| **Duplicate charges** | **3210** | **0** | |
| **Orphaned checkpoints** | **2** | **0** | |

Each version was exposed to six injected faults over 423 s
and 423 s of observation respectively.

## 3. What happened in each scenario

**Application crash.** The baseline lost 1200 of
11982 requests (10.02 %).
The arithmetic explains itself: student traffic is 60 % of the mix, round robin
sends half of it to the dead instance, and the instance is dead for 25 of the 70
seconds -- 0.6 x 0.5 x 25/70 = 10.7 %, against 10.02 % measured. The baseline has no
health checks, so the gateway kept routing to a process that no longer existed. The
fault-tolerant version detected the crash in 103 ms from a
failed call attempt, rescued 18 in-flight requests by
retrying them onto student-2, and lost nothing. Note that time-based availability is
100 % in both versions: the service never stopped answering, it just answered wrongly
half the time -- which is precisely why request-based availability must also be reported.

**Database failure.** This is the one row where the fault-tolerant version looks
worse, and the explanation matters. It returned 532 errors against the
baseline's 35, but those errors are payment *writes* failing fast: a hot
standby is read-only, so with the primary down there is nowhere for a write to go, and
failing in 5 ms (median) is the correct behaviour. Meanwhile reads stayed up --
169 served from the standby and
1422 from the stale cache -- and the client-visible outage was zero.
The baseline's low error count is an artefact: with no timeout, 20 requests hung for the
client's full 10 s patience, and a blocked client issues no further requests. Throughput
collapsed from 8704 to 7175 requests and the system was genuinely
unavailable for 10.0 s (time-based availability
97.78 %). Hanging is not better than failing; it only looks
better in a ratio whose denominator it destroys.

**Network / service timeout.** Neither version lost a request, so availability says
nothing; latency and throughput say everything. In the baseline every request routed
to the slow instance paid the full injected delay: 80 requests took over a
second, the slowest 3021 ms. They are invisible in the baseline's p99
(24 ms) only because they are 0.97 % of the run -- a worker
stuck for 3 s issues no further requests, the same denominator effect as in the
database-failure row. The cost shows up as throughput instead: during the fault the
baseline served 11 requests/s, against 178/s before it. With fault tolerance
the 800 ms per-attempt timeout fired and the retry landed on the healthy replica:
3 requests over a second, a worst case of 1201 ms (the timeout plus one fast
retry, which is also why its p99 is 848 ms), and 33 requests/s during the
fault -- 2.9x the baseline, but still far below the 177/s before it.
245 requests were rescued by retry.

The remaining loss has a precise cause. Every request first routed to the slow
instance still waits out the whole timeout, because nothing removes that instance
from rotation: its /health stays fast, so the health check keeps it in, and the
circuit breaker is kept per *pool*, so each successful retry on student-2 resets it
(0 openings in this run). A breaker per *instance* -- outlier ejection -- would
take student-1 out after a few timeouts and recover the remaining throughput. This
is the scenario a liveness probe cannot catch.

**Hardware / node failure.** Killing student-1 and payment-1 together cost the baseline
1845 requests (14.80 %) and the fault-tolerant version
0. The surviving node absorbed the entire load; the platform degraded in
capacity, not in availability, which is the whole point of replicating across nodes.
Detection took 359 ms and 15 requests were rescued by retry.

**Corrupted / lost transaction.** The most important row for data integrity. Both
payment instances died between writing the durable checkpoint and committing the
charge. The fault-tolerant version's recovery sweep rolled back
2 orphaned checkpoints, leaving 0 rows stuck in `pending` and
0 duplicate charges. The baseline left 2 payments permanently
in `pending` -- money neither charged nor released, with no process that will ever
reconcile them -- and charged 307 students twice.

**High load.** Raising concurrency from 10 to 110 workers broke neither version, and
throughput was comparable (40882 vs 39217 requests). Both rows show failures --
96 and 66 -- but 96 and 66 of them are requests that were still in flight when the
observation window closed (`abandoned_at_window_close`): with 110 workers about a
hundred requests are always in flight, so the cut-off itself produces them. That is
also what the ~50 s "detection time" in the headline table measures: the window
closing, not a reaction to load. Not one request failed because of the overload in
either version. Latency rose in both (p95 135 ms baseline, 150 ms fault-tolerant;
at 10 workers it is 13-20 ms in every other run), so the platform was loaded but not saturated --
this run shows headroom, not overload protection. The duplicate charges
(1561 in the baseline) are the largest of the campaign simply because the most
payments were sent: in the baseline every client resend becomes a second charge,
under any load.

## 4. Which mechanism did the work

Counts are from the fault-tolerant runs; the baseline has none of these paths.

| Scenario | Failed calls absorbed | Rescued by retry | Breaker openings | Degraded responses | Replica reads | Duplicates suppressed | Checkpoints rolled back |
|---|---|---|---|---|---|---|---|
| Application crash | 18 | 18 | 0 | 0 | 0 | 477 | 0 |
| Database failure | 236 | 7 | 3 | 1591 | 169 | 230 | 0 |
| Network / service timeout | 245 | 245 | 0 | 0 | 0 | 321 | 0 |
| Hardware / node failure | 15 | 15 | 0 | 0 | 0 | 497 | 0 |
| Corrupted / lost transaction | 6 | 0 | 1 | 0 | 0 | 455 | 2 |
| High load | 0 | 0 | 0 | 0 | 0 | 1543 | 0 |

Campaign totals: 520 failed upstream calls absorbed internally,
285 requests rescued by retry, 4 circuit-breaker openings,
1422 responses served degraded, 169 reads failed over to the
standby.

## 5. Theoretical vs measured availability

A series-parallel model of the platform: gateway (single) -> student (2 replicas)
-> payment (2 replicas) -> transcript (single) -> database (primary + hot standby,
a parallel pair for reads; the fault-tolerant formula treats it so, the baseline
cannot fail over and has all five in series). REPORT.md §4.3 extends this with a
realistic manual-repair MTTR and the shared host.

Assumption: each component has an MTTF of 720 h (one failure per
component per month). MTTR is the campaign-measured value for each version
(10.0 s baseline,
no outage measured, 3 s assumed fault-tolerant).

| | Baseline | Fault-tolerant |
|---|---|---|
| Component availability | 99.999614 % | 99.999884 % |
| Predicted system availability | 99.998071 % | 99.999769 % |
| Measured (time-based, under injected faults) | 99.74 % | 100.00 % |

For the baseline the prediction is far higher than the measurement. For the
fault-tolerant version the measured 100 % is a censored value -- no outage was
observed at all -- so it is consistent with the prediction but cannot confirm it.
The baseline gap is expected rather than an error: the model assumes faults arrive at the natural
component failure rate, whereas the campaign injects one fault every 70 s --
roughly 37029x the assumed rate. The model
also assumes independent failures, which the node-failure scenario deliberately
violates by taking out two components at once. The useful reading is the *ratio*
between the two columns, not the absolute values: replication raises predicted
availability by turning single points of failure into parallel pairs, and the
measured results reproduce that ordering.

## 6. Threats to validity

* **Three baseline runs were repeated.** In the first pass, node-failure,
  txn-interrupt and high-load stretched their 70 s window to 357 s, 150 s and
  262 s: with no timeout anywhere in the baseline, a single request hung on a
  stale keep-alive connection and the workload generator waited for it. The
  generator now closes the window unconditionally and marks anything still in
  flight as abandoned. Only the repeated runs are reported. The window length of
  every run is published in `EXPERIMENT-LOG.md` so this class of distortion is
  visible rather than hidden.
* **Requests cut off by the window close count as failures.** This is the stated
  definition (METHODOLOGY §2), and it is harmless at 10 workers, where it adds at
  most a handful per run. At 110 workers it produces every failure in the high-load
  row (96 baseline, 66 fault-tolerant) and the ~50 s "detection time", which
  is the window closing. Read that row's failures and detection time as zero.
* **Request-based availability flatters the baseline.** A blocked client issues no
  further requests, so hangs shrink the denominator instead of showing up as
  failures. This is why time-based availability and absolute throughput are
  reported alongside it.
* **One container models one node.** Real node failure would also take out the
  host kernel, local disk and network path; this campaign only removes processes.
* **Single replication factor.** Two replicas per service and one standby is the
  smallest configuration that demonstrates the mechanisms; it says nothing about
  how the system behaves at larger scale.
* **The operator repair is simulated** as a fixed 25 s delay after injection. Real
  mean time to repair depends on paging, diagnosis and human response, all of
  which are outside this measurement.
