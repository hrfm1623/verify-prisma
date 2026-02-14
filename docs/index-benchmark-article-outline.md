# Prisma/PostgreSQL で index 判断を検証する記事アウトライン

## 1. 問題設定
- index を増やすと read は速くなるが、create/update は遅くなる可能性がある。
- 実際にどの条件で better かを、同じデータ量・同じクエリで比較する。

## 2. 検証環境
- DB: PostgreSQL
- ORM: Prisma v6.19
- 比較シナリオ:
  - `baseline`
  - `selective_indexes`
  - `over_indexed`

## 3. 計測項目
- `pointReadByEmail`
- `selectiveReadByTenantStatus`
- `lowSelectivityReadByStatus`
- `selectiveUpdateByTenantStatus`
- `createMany`

## 4. 実験結果の見せ方
- データ件数ごとに table を作る（例: 20k / 100k / 200k）
- 指標:
  - `avgMs`, `p50Ms`, `p95Ms`
  - baseline 比 (`baseline_avg / scenario_avg`)
- 補足として `EXPLAIN (ANALYZE)` の `Node Type` を掲載

## 5. 判断基準
- 意思決定式:
  - `read_gain_ms * read_qps > write_penalty_ms * write_qps`
- 追加で見るべきポイント:
  - 選択性（ヒット率）
  - テーブル件数の増加率
  - 更新頻度（特に index 対象列の更新）

## 6. まとめ
- 高選択性 + read比率が高いなら index は有効
- 低選択性や過剰 index は write コストを押し上げやすい
- 定期的に再計測し、使われていない index を棚卸しする

## 実行コマンド

```bash
docker compose up -d postgres
npm install
CACHE_DIR=$PWD/.prisma-cache npm run benchmark:index
```
