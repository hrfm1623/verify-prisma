# prisma-extends soft delete playground

`Prisma Client` の `extends` で、`findMany` に `deletedAt: null` を自動適用しつつ、例外的に削除済みデータも取得できることを確認する最小リポジトリです。

## 検証ポイント

- デフォルトの `findMany` は `deletedAt: null` でスコープされる
- `include` を使った関連取得でもデフォルトスコープが効く
- 例外的に `prisma.withDeleted()` を使うと削除済みも取得できる

## 主要ファイル

- `prisma/schema.prisma`
- `scripts/prisma-client.ts`
- `scripts/seed.ts`
- `scripts/verify.ts`

## 実行手順

```bash
pnpm install
pnpm prisma:generate
pnpm check
```

`pnpm check` では以下を順番に実行します。

1. スキーマ反映 (`prisma db push`)
2. シード投入
3. 検証スクリプト実行

## API イメージ

```ts
const prisma = createPrisma();

// デフォルト: deletedAt = null が入る
await prisma.user.findMany({ include: { posts: true } });

// 例外: 削除済みを含めて取得
await prisma.withDeleted().user.findMany({
  where: { deletedAt: { not: null } },
});
```
