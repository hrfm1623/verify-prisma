# prisma-extends soft delete playground

`Prisma Client` の `extends` で soft delete を実装し、読み取りスコープ・例外取得・書き込み変換を検証する最小リポジトリです。

## 検証ポイント

- デフォルトの `findMany / findFirst / findUnique / count / aggregate / groupBy` は `deletedAt: null` でスコープされる
- `include` を使った関連取得でもデフォルトスコープが効く
- `where` 内の relation filter (`some / every / none`) にもスコープが効く
- `_count` の relation 件数もデフォルトでスコープされる
- 例外的に `prisma.withDeleted()` を使うと削除済みも取得できる（他 extension を保持）
- `delete / deleteMany` はソフトデリート (`update / updateMany`) に変換される
- 物理削除したい場合は `prisma.hardDelete()` を使える

## 主要ファイル

- `prisma/schema.prisma`
- `scripts/prisma-client.ts`
- `scripts/scenario.ts`
- `scripts/seed.ts`
- `tests/soft-delete-extension.test.ts`

## 実行手順

```bash
pnpm install
pnpm prisma:generate
pnpm test
pnpm check
```

`pnpm check` では以下を順番に実行します。

1. スキーマ反映 (`prisma db push`)
2. テスト実行
3. TypeScript 型チェック

## API イメージ

```ts
const prisma = createPrisma();

// デフォルト: deletedAt = null が入る
await prisma.user.findMany({ include: { posts: true } });

// delete はソフトデリートに変換される
await prisma.user.delete({ where: { email: "a@example.com" } });

// 例外: 削除済みを含めて取得
await prisma.withDeleted().user.findMany({
  where: { deletedAt: { not: null } },
});

// 物理削除が必要な場合だけ使う
await prisma.hardDelete().user.deleteMany();
```
