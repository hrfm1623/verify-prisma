# PostgreSQL 18 Index Benchmark Summary (JA)

- generated: 2026-02-14T18:29:56.937Z
- source report: `artifacts/postgres18/index-benchmark-2026-02-14T18-29-23-505Z.json`
- db version: PostgreSQL 18.2

## PostgreSQL 18 の要点

### dataset=20,000
- selective_indexes: pointRead 0.423ms (2.41x), createMany 20.054ms (0.88x)
- over_indexed: pointRead 0.357ms (2.86x), createMany 23.638ms (0.74x)
- break-even (pointRead per createMany): selective=4.18, over_indexed=9.17

### dataset=100,000
- selective_indexes: pointRead 0.417ms (7.01x), createMany 23.091ms (0.84x)
- over_indexed: pointRead 0.374ms (7.82x), createMany 23.44ms (0.83x)
- break-even (pointRead per createMany): selective=1.44, over_indexed=1.55

## PostgreSQL 16 vs 18 (参考)

### dataset=20,000
- selective pointRead: pg16=0.377ms / pg18=0.423ms
- selective createMany: pg16=19.63ms / pg18=20.054ms
- over-indexed pointRead: pg16=0.415ms / pg18=0.357ms
- over-indexed createMany: pg16=21.907ms / pg18=23.638ms

### dataset=100,000
- selective pointRead: pg16=0.385ms / pg18=0.417ms
- selective createMany: pg16=20.851ms / pg18=23.091ms
- over-indexed pointRead: pg16=0.428ms / pg18=0.374ms
- over-indexed createMany: pg16=21.873ms / pg18=23.44ms

## 記事用の短い結論

- 100k件では selective index で pointRead と selectiveRead が大きく改善。
- createMany は index 追加で一貫して悪化し、over_indexed で悪化幅が大きい。
- 「read改善量 × read頻度」が「write悪化量 × write頻度」を超える時に index を採用する。

