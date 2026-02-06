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
