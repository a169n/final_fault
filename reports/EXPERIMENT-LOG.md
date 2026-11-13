# Experiment log

Every controlled run, in execution order. Each row links to a per-run report
containing the timeline, the raw data and the consistency checks.

The observation window is fixed at 70 s by the workload generator; the column is
shown so that any run whose window was distorted is visible rather than hidden.

| # | Scenario | Version | Requests | Failed | Avail. (req) | Avail. (time) | Detection | Recovery | MTTR | Dup. charges | Orphans | Window | Report |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | Application crash | ft | 12350 | 1 | 99.99 % | 100.00 % | 103 ms | -- | n/a | 0 | 0 | 70.5 s | [report](runs/app-crash__ft/REPORT.md) |
| 2 | Database failure | ft | 8704 | 532 | 93.89 % | 100.00 % | 367 ms | -- | n/a | 0 | 0 | 70.5 s | [report](runs/db-failure__ft/REPORT.md) |
| 3 | Network / service timeout | ft | 8646 | 0 | 100.00 % | 100.00 % | 848 ms | -- | n/a | 0 | 0 | 70.5 s | [report](runs/net-timeout__ft/REPORT.md) |
| 4 | Hardware / node failure | ft | 12645 | 0 | 100.00 % | 100.00 % | 359 ms | -- | n/a | 0 | 0 | 70.5 s | [report](runs/node-failure__ft/REPORT.md) |
| 5 | Corrupted / lost transaction | ft | 12567 | 190 | 98.49 % | 100.00 % | 6 ms | -- | n/a | 0 | 0 | 70.5 s | [report](runs/txn-interrupt__ft/REPORT.md) |
| 6 | High load | ft | 39217 | 66 | 99.83 % | 100.00 % | 49840 ms | -- | n/a | 0 | 0 | 70.5 s | [report](runs/high-load__ft/REPORT.md) |
| 7 | Application crash | baseline | 11982 | 1200 | 89.98 % | 100.00 % | 57 ms | -- | n/a | 445 | 0 | 70.5 s | [report](runs/app-crash__baseline/REPORT.md) |
| 8 | Database failure | baseline | 7175 | 35 | 99.51 % | 97.78 % | 284 ms | 20358 ms | 10.0 s | 258 | 0 | 70.5 s | [report](runs/db-failure__baseline/REPORT.md) |
| 9 | Network / service timeout | baseline | 8261 | 0 | 100.00 % | 100.00 % | n/a | -- | n/a | 334 | 0 | 70.5 s | [report](runs/net-timeout__baseline/REPORT.md) |
| 10 | Hardware / node failure | baseline | 12469 | 1845 | 85.20 % | 100.00 % | 99 ms | -- | n/a | 305 | 0 | 70.5 s | [report](runs/node-failure__baseline/REPORT.md) |
| 11 | Corrupted / lost transaction | baseline | 12531 | 1084 | 91.35 % | 100.00 % | 12 ms | -- | n/a | 307 | 2 | 70.5 s | [report](runs/txn-interrupt__baseline/REPORT.md) |
| 12 | High load | baseline | 40882 | 96 | 99.77 % | 100.00 % | 49930 ms | -- | n/a | 1561 | 0 | 70.5 s | [report](runs/high-load__baseline/REPORT.md) |
