import assert from "node:assert/strict";
import { after, beforeEach, test } from "node:test";
import { createPrisma } from "../scripts/prisma-client";
import {
  ACTIVE_POST_TITLE,
  ACTIVE_USER_2_EMAIL,
  ACTIVE_USER_EMAIL,
  DELETED_POST_TITLE,
  DELETED_USER_EMAIL,
  resetAndSeedScenarioData,
} from "../scripts/scenario";

const prisma = createPrisma();

beforeEach(async () => {
  await resetAndSeedScenarioData(prisma);
});

after(async () => {
  await prisma.$disconnect();
});

test("findMany applies default scope on root and include", async () => {
  const users = await prisma.user.findMany({
    orderBy: { id: "asc" },
    include: { posts: { orderBy: { id: "asc" } } },
  });

  assert.deepEqual(
    users.map((user) => user.email),
    [ACTIVE_USER_EMAIL, ACTIVE_USER_2_EMAIL],
  );
  assert.ok(users.every((user) => user.deletedAt === null));

  const activeUser = users.find((user) => user.email === ACTIVE_USER_EMAIL);
  assert.ok(activeUser);
  assert.equal(activeUser.posts.length, 1);
  assert.equal(activeUser.posts[0].title, ACTIVE_POST_TITLE);
});

test("findFirst/findUnique/count/aggregate/groupBy are scoped by default", async () => {
  const deletedByFirst = await prisma.user.findFirst({
    where: { email: DELETED_USER_EMAIL },
  });
  assert.equal(deletedByFirst, null);

  const deletedByUnique = await prisma.user.findUnique({
    where: { email: DELETED_USER_EMAIL },
  });
  assert.equal(deletedByUnique, null);

  await assert.rejects(
    prisma.user.findUniqueOrThrow({
      where: { email: DELETED_USER_EMAIL },
    }),
  );

  const userCount = await prisma.user.count();
  assert.equal(userCount, 2);

  const aggregate = await prisma.user.aggregate({
    _count: { _all: true },
  });
  assert.equal(aggregate._count._all, 2);

  const grouped = await prisma.user.groupBy({
    by: ["deletedAt"],
    _count: { _all: true },
    orderBy: { deletedAt: "asc" },
  });
  assert.equal(grouped.length, 1);
  assert.equal(grouped[0].deletedAt, null);
  assert.equal(grouped[0]._count._all, 2);
});

test("withDeleted bypasses read scope and keeps other client extensions", async () => {
  const prismaWithExtra = prisma.$extends({
    client: {
      marker() {
        return "ok";
      },
    },
  });

  assert.equal(prismaWithExtra.withDeleted().marker(), "ok");

  const deletedUsers = await prismaWithExtra.withDeleted().user.findMany({
    where: { deletedAt: { not: null } },
  });
  assert.equal(deletedUsers.length, 1);
  assert.equal(deletedUsers[0].email, DELETED_USER_EMAIL);

  const activeUser = await prismaWithExtra.withDeleted().user.findFirst({
    where: { email: ACTIVE_USER_EMAIL },
    include: { posts: { orderBy: { id: "asc" } } },
  });
  assert.ok(activeUser);
  assert.equal(activeUser.posts.length, 2);
  assert.equal(activeUser.posts[1].title, DELETED_POST_TITLE);
});

test("delete/deleteMany are transformed to soft delete", async () => {
  const deletedResult = await prisma.user.delete({
    where: { email: ACTIVE_USER_2_EMAIL },
  });
  assert.notEqual(deletedResult.deletedAt, null);

  const hiddenInDefault = await prisma.user.findUnique({
    where: { email: ACTIVE_USER_2_EMAIL },
  });
  assert.equal(hiddenInDefault, null);

  const visibleWithDeleted = await prisma.withDeleted().user.findUnique({
    where: { email: ACTIVE_USER_2_EMAIL },
  });
  assert.ok(visibleWithDeleted);
  assert.notEqual(visibleWithDeleted.deletedAt, null);

  const deleteManyResult = await prisma.user.deleteMany({
    where: { email: ACTIVE_USER_EMAIL },
  });
  assert.equal(deleteManyResult.count, 1);

  const countAfterDeleteMany = await prisma.user.count();
  assert.equal(countAfterDeleteMany, 0);

  const withDeletedCount = await prisma.withDeleted().user.count();
  assert.equal(withDeletedCount, 3);
});

test("hardDelete bypasses soft delete transformation", async () => {
  await prisma.hardDelete().user.delete({
    where: { email: ACTIVE_USER_2_EMAIL },
  });

  const hardDeleted = await prisma.withDeleted().user.findUnique({
    where: { email: ACTIVE_USER_2_EMAIL },
  });
  assert.equal(hardDeleted, null);
});

test("relation where filters apply soft-delete scope for some/every/none", async () => {
  const someDefault = await prisma.user.findMany({
    where: {
      email: ACTIVE_USER_EMAIL,
      posts: { some: { title: DELETED_POST_TITLE } },
    },
  });
  assert.equal(someDefault.length, 0);

  const someWithDeleted = await prisma.withDeleted().user.findMany({
    where: {
      email: ACTIVE_USER_EMAIL,
      posts: { some: { title: DELETED_POST_TITLE } },
    },
  });
  assert.equal(someWithDeleted.length, 1);

  const everyDefault = await prisma.user.findMany({
    where: {
      email: ACTIVE_USER_EMAIL,
      posts: { every: { title: ACTIVE_POST_TITLE } },
    },
  });
  assert.equal(everyDefault.length, 1);

  const noneDefault = await prisma.user.findMany({
    where: {
      email: ACTIVE_USER_EMAIL,
      posts: { none: { title: DELETED_POST_TITLE } },
    },
  });
  assert.equal(noneDefault.length, 1);
});

test("_count relation is scoped by default and bypassed by withDeleted", async () => {
  const defaultCounted = await prisma.user.findUniqueOrThrow({
    where: { email: ACTIVE_USER_EMAIL },
    include: {
      _count: {
        select: { posts: true },
      },
    },
  });
  assert.equal(defaultCounted._count.posts, 1);

  const withDeletedCounted = await prisma.withDeleted().user.findUniqueOrThrow({
    where: { email: ACTIVE_USER_EMAIL },
    include: {
      _count: {
        select: { posts: true },
      },
    },
  });
  assert.equal(withDeletedCounted._count.posts, 2);
});

test("query args object is not mutated by extension", async () => {
  const options = {
    include: {
      posts: {
        where: { title: { contains: "Post" } },
      },
    },
    where: {
      posts: {
        some: {
          title: ACTIVE_POST_TITLE,
        },
      },
    },
  };
  const original = structuredClone(options);

  await prisma.user.findMany(options);
  await prisma.user.findMany(options);

  assert.deepEqual(options, original);
});

test("create/update still work with soft-delete scope", async () => {
  const created = await prisma.user.create({
    data: {
      email: "runtime@example.com",
      name: "Runtime User",
    },
  });

  const updated = await prisma.user.update({
    where: { id: created.id },
    data: { name: "Runtime User Updated" },
  });
  assert.equal(updated.name, "Runtime User Updated");
});

test("update with include returns scoped relations by default", async () => {
  const activeUser = await prisma.user.findFirstOrThrow({
    where: { email: ACTIVE_USER_EMAIL },
  });

  const updated = await prisma.user.update({
    where: { id: activeUser.id },
    data: { name: "Updated Name" },
    include: { posts: { orderBy: { id: "asc" } } },
  });

  assert.equal(updated.name, "Updated Name");
  assert.equal(updated.posts.length, 1);
  assert.equal(updated.posts[0].title, ACTIVE_POST_TITLE);

  const updatedWithDeleted = await prisma.withDeleted().user.update({
    where: { id: activeUser.id },
    data: { name: "Updated Again" },
    include: { posts: { orderBy: { id: "asc" } } },
  });

  assert.equal(updatedWithDeleted.posts.length, 2);
  assert.equal(updatedWithDeleted.posts[1].title, DELETED_POST_TITLE);
});

test("create with include returns scoped relations by default", async () => {
  const created = await prisma.user.create({
    data: {
      email: "include-test@example.com",
      name: "Include Test User",
      posts: {
        create: [
          { title: "Visible Post", content: "visible" },
          { title: "Hidden Post", content: "hidden", deletedAt: new Date() },
        ],
      },
    },
    include: { posts: { orderBy: { id: "asc" } } },
  });

  assert.equal(created.posts.length, 1);
  assert.equal(created.posts[0].title, "Visible Post");

  const createdWithDeleted = await prisma.withDeleted().user.findUniqueOrThrow({
    where: { id: created.id },
    include: { posts: { orderBy: { id: "asc" } } },
  });
  assert.equal(createdWithDeleted.posts.length, 2);
});

test("upsert scopes include but NOT where clause (known limitation)", async () => {
  // upsert with an active user: include is scoped, so only active posts are returned
  const upserted = await prisma.user.upsert({
    where: { email: ACTIVE_USER_EMAIL },
    update: { name: "Upserted Active" },
    create: { email: ACTIVE_USER_EMAIL, name: "Created Active" },
    include: { posts: true },
  });

  assert.equal(upserted.name, "Upserted Active");
  assert.equal(upserted.posts.length, 1);
  assert.equal(upserted.posts[0].title, ACTIVE_POST_TITLE);

  // upsert with a non-existent email: falls through to create
  const upsertedNew = await prisma.user.upsert({
    where: { email: "upsert-new@example.com" },
    update: { name: "Should Not Happen" },
    create: { email: "upsert-new@example.com", name: "Newly Created" },
  });
  assert.equal(upsertedNew.name, "Newly Created");

  // KNOWN LIMITATION: upsert's where clause is NOT scoped by deletedAt.
  // Because "upsert" is not in ROOT_SCOPED_OPERATIONS, the soft-deleted user
  // is still found by Prisma's internal unique lookup, causing the update path
  // to execute instead of the create path.
  const upsertDeleted = await prisma.user.upsert({
    where: { email: DELETED_USER_EMAIL },
    update: { name: "Updated Deleted User" },
    create: { email: DELETED_USER_EMAIL, name: "Re-created" },
  });
  assert.equal(upsertDeleted.name, "Updated Deleted User");
});

test("sequential $transaction applies default soft-delete scope", async () => {
  const [users, userCount] = await prisma.$transaction([
    prisma.user.findMany({ orderBy: { id: "asc" } }),
    prisma.user.count(),
  ]);

  assert.equal(users.length, 2);
  assert.ok(users.every((u) => u.deletedAt === null));
  assert.equal(userCount, 2);
});

test("sequential $transaction with withDeleted breaks PrismaPromise (known limitation)", async () => {
  // KNOWN LIMITATION: The Proxy created by withDeleted() wraps PrismaPromise
  // return values in a regular Promise via `(async () => await result)()`.
  // Prisma's sequential $transaction requires PrismaPromise instances in the
  // array, so passing proxied promises causes a runtime error.
  try {
    await prisma.withDeleted().$transaction([
      prisma.withDeleted().user.findMany({ orderBy: { id: "asc" } }),
      prisma.withDeleted().user.count(),
    ]);
    assert.fail("Expected error was not thrown");
  } catch (err) {
    assert.ok(err instanceof Error);
    assert.match(err.message, /Prisma Client promises/);
  }
});

test("interactive $transaction propagates soft-delete context", async () => {
  const result = await prisma.$transaction(async (tx) => {
    const users = await tx.user.findMany({ orderBy: { id: "asc" } });
    const count = await tx.user.count();
    return { users, count };
  });

  assert.equal(result.users.length, 2);
  assert.ok(result.users.every((u) => u.deletedAt === null));
  assert.equal(result.count, 2);

  const withDeletedResult = await prisma.withDeleted().$transaction(async (tx) => {
    const users = await tx.user.findMany({ orderBy: { id: "asc" } });
    const count = await tx.user.count();
    return { users, count };
  });

  assert.equal(withDeletedResult.users.length, 3);
  assert.equal(withDeletedResult.count, 3);
});

test("concurrent requests have isolated soft-delete context", async () => {
  const [defaultResult, withDeletedResult] = await Promise.all([
    prisma.user.findMany({ orderBy: { id: "asc" } }),
    prisma.withDeleted().user.findMany({ orderBy: { id: "asc" } }),
  ]);

  assert.equal(defaultResult.length, 2);
  assert.ok(defaultResult.every((u) => u.deletedAt === null));
  assert.equal(withDeletedResult.length, 3);

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) =>
      i % 2 === 0
        ? prisma.user.count()
        : prisma.withDeleted().user.count(),
    ),
  );

  for (let i = 0; i < results.length; i++) {
    if (i % 2 === 0) {
      assert.equal(results[i], 2, `default scope count at index ${i}`);
    } else {
      assert.equal(results[i], 3, `withDeleted count at index ${i}`);
    }
  }
});

test("nested connectOrCreate in update respects soft-delete scope", async () => {
  const activeUser = await prisma.user.findFirstOrThrow({
    where: { email: ACTIVE_USER_EMAIL },
  });

  const updated = await prisma.user.update({
    where: { id: activeUser.id },
    data: {
      posts: {
        connectOrCreate: {
          where: { id: 999999 },
          create: { title: "ConnectOrCreate Post", content: "test" },
        },
      },
    },
    include: { posts: { orderBy: { id: "asc" } } },
  });

  assert.equal(updated.posts.length, 2);
  assert.ok(updated.posts.some((p) => p.title === "ConnectOrCreate Post"));
  assert.ok(updated.posts.every((p) => p.deletedAt === null));
});
