# Performance

Measured on an Apple M1 Max with Node 22 and synthetic data. PostgreSQL 16 ran in Docker on the same machine with two processors and default settings, including `fsync`. Run `DATABASE_URL=postgres://… npm run bench` to measure your own hardware, or omit the variable to measure the memory store.

20,000 accounts:

| Store | One at a time | In batches of 100 | Through the write queue | Reading one subject's links |
| --- | --- | --- | --- | --- |
| Memory | 28,700 observations/s | 13,800/s | 16,900/s | 0.02 ms |
| PostgreSQL | 183 observations/s | 1,900/s | 3,600/s | 2.7 ms |

PostgreSQL writes are serialized by an advisory lock. The write queue combines the visits that browsers report at one time into one transaction.

The figures are of observations written by the engine. An entry of `record` is a transaction of its own and also writes a receipt, which these figures leave out.

Large graphs, five edges per account, with `DATABASE_URL=postgres://… npm run bench -- scale 1000000 5000000 10000000`. Cells show time and peak memory:

| Edges | On disk | `rebuild` | `verify` | Observation, one subject's links |
| --- | --- | --- | --- | --- |
| 1 million | 420 MB | 7 s, 159 MB | 6 s, 150 MB | 6.6 ms, 2.3 ms |
| 5 million | 2.1 GB | 45 s, 198 MB | 40 s, 206 MB | 8.1 ms, 2.9 ms |
| 10 million | 4.3 GB | 94 s, 291 MB | 85 s, 402 MB | 10.7 ms, 3.7 ms |

The last column is the median of 300 sequential runs. Other tests used the database during the two larger runs, so those times are upper estimates.
