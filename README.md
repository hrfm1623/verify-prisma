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
