# Experiment log

What happened during the campaign that a reader of the results should know. Times are UTC, from the
container clock.

| When | Event | Effect on the data |
|---|---|---|
| before the campaign | Smoke runs with `--rep 0`: `db-failure` (final), `data-loss` (final, twice). The first `data-loss` smoke run restored the newest backup, which had been taken 11 s **after** the records were destroyed, so the restore brought back nothing (0 of 1 220 payments). The restore tool got a `--before <time>` option and the scenario now passes the time of the loss | Smoke runs are deleted and are not in the results. The finding is discussed in REPORT.md §10.4 |
| final, repetition 1, `high-load` | **Operator error by the experimenter.** The integration test suite (`pytest tests`, which includes a test that stops the database primary) was started by mistake against the stack while the run was being measured. The run recorded a database failover that the scenario does not inject | The run was discarded (results and raw log deleted) and repeated after the rest of the final campaign, with `npm run campaign -- --reps 3 --resume`. No other run overlapped with the test suite: `txn-interrupt` r1 had finished 90 s earlier and `gateway-failure` r1 started its known-state restore after the suite had ended |
