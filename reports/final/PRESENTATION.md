# Presentation outline (10 minutes + demonstration)

Slides are taken from the compact report ([`REPORT-compact.pdf`](REPORT-compact.pdf)); the live
part follows [`DEMO.md`](DEMO.md).

| # | Slide | Content | Source |
|---|---|---|---|
| 1 | Title and key results | 13/13 against 2/13 scenarios; 6.8 s failover; 99.76 % in the soak; 77 % of destroyed records restored | compact report, page 1 |
| 2 | System and the two configurations | 19 containers; same image, topology and workload; baseline does not use the redundancy | §1 |
| 3 | Objectives | the eight SLOs and which are met | §2 |
| 4 | How it fails | fault, error, failure; the failure-mode table; remaining single points of failure | §3 |
| 5 | What was built for the final | automatic database failover, writer discovery, synchronous replication, backups and merge restore | §5 |
| 6 | Reliability | formulas, the worked soak example, coverage 77.8 % against 11.1 % | §4 |
| 7 | Results | the pass/fail table and the availability chart | §8 |
| 8 | One incident end to end | the Grafana snapshot of a failover | §8 |
| 9 | Where it is weak | SLO-1 missed in E2 and E5; one baseline repetition; a discarded first baseline campaign; the breaker lengthens the failover | §9 |
| 10 | Lessons and next steps | restore from before the incident; replication is not a backup; measure availability two ways | §9 |

**Live demonstration (4 scenarios minimum):** `npm run up:final && npm run demo` runs application
crash, database failover, data loss and restore, gateway failure, unauthorized access and abuse.
Recorded transcripts: [`demo/demo-final.txt`](demo/demo-final.txt) and, for contrast, [`demo/demo-baseline.txt`](demo/demo-baseline.txt).
