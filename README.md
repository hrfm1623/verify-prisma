# prisma-skipduplicates-test

Prisma v6.19 で `createMany({ skipDuplicates: true })` を各 DB に対して実行し、実際に流れるクエリを確認するための最小セットです。

## 確認手順

前提:
- Docker が使えること
- Node.js 18+ が入っていること

1. DB コンテナ起動
   ```bash
   docker compose up -d postgres mysql mariadb mongo
   ```
2. Prisma 実行（エンジンキャッシュの書き込み権限をローカルに向ける）
   ```bash
   CACHE_DIR=$PWD/.prisma-cache npm run run
   ```
   - `scripts/run-all.js` が各 `prisma/schema.*.prisma` を使って `createMany({ skipDuplicates: true })` を流し、Prisma のクエリログを標準出力に表示します。
   - 標準ログ例:
     - PostgreSQL: `INSERT ... ON CONFLICT DO NOTHING`
     - MySQL/MariaDB: `INSERT IGNORE ...`
     - SQLite: v6.19 では `skipDuplicates` が非対応（`Unknown argument skipDuplicates`）
     - MongoDB: `skipDuplicates` 未対応。さらに単一ノードではトランザクション不可で `deleteMany` が失敗（レプリカセットが必要）

補足:
- エンジンのキャッシュ権限で失敗する環境では、必ず `CACHE_DIR=$PWD/.prisma-cache` を指定してください。

## index 判断のための PostgreSQL ベンチ

`read/create/update` がインデックス有無でどの程度変わるかを、同じデータ量で比較するスクリプトを追加しています。

### 目的
- `baseline`: 主キーのみ
- `selective_indexes`: 選択性が高い列のみ index
- `over_indexed`: 低選択性や用途不明の列にも index

上記3パターンで、次を計測します。
- `pointReadByEmail`（1件検索）
- `selectiveReadByTenantStatus`（選択性中）
- `lowSelectivityReadByStatus`（低選択性）
- `selectiveUpdateByTenantStatus`
- `createMany`（一括 insert）

### 実行手順

前提:
- Docker が使えること
- Node.js 18+ が入っていること

1. PostgreSQL 起動
   ```bash
   docker compose up -d postgres
   ```
2. 依存インストール
   ```bash
   npm install
   ```
3. ベンチ実行
   ```bash
   CACHE_DIR=$PWD/.prisma-cache npm run benchmark:index
   ```
4. 結果確認
   - `artifacts/index-benchmark-*.json`
   - `artifacts/index-benchmark-*.md`

### パラメータ調整（任意）

- `INDEX_BENCH_SIZES=20000,100000` データ件数
- `INDEX_BENCH_RUNS=15` 計測回数
- `INDEX_BENCH_WARMUPS=3` ウォームアップ回数
- `INDEX_BENCH_WRITE_BATCH=1000` `createMany` 1回あたり件数
- `INDEX_BENCH_INSERT_BATCH=1000` 初期データ投入のバッチサイズ

例:
```bash
INDEX_BENCH_SIZES=50000,200000 INDEX_BENCH_RUNS=20 CACHE_DIR=$PWD/.prisma-cache npm run benchmark:index
```

### index を張る判断式

ベンチ結果から次で判断できます。

`read_gain_ms * read_qps > write_penalty_ms * write_qps`

- `read_gain_ms`: indexありで減った read レイテンシ
- `write_penalty_ms`: indexありで増えた create/update レイテンシ

式が正なら、全体として index の価値が高いと判断しやすいです。
