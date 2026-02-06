import assert from "node:assert/strict";
import { createPrisma } from "./prisma-client";
import {
  ACTIVE_POST_TITLE,
  ACTIVE_USER_EMAIL,
  DELETED_USER_EMAIL,
  resetAndSeedScenarioData,
} from "./scenario";

async function main() {
  const prisma = createPrisma();

  try {
    await resetAndSeedScenarioData(prisma);

    const defaultScoped = await prisma.user.findMany({
      orderBy: { id: "asc" },
      include: {
        posts: {
          orderBy: { id: "asc" },
        },
      },
    });

    assert.equal(defaultScoped.length, 2, "default scope should hide deleted users");
    assert.ok(
      defaultScoped.every((user) => user.deletedAt === null),
      "default scope should only return users with deletedAt = null",
    );

    const activeUser = defaultScoped.find((user) => user.email === ACTIVE_USER_EMAIL);
    assert.ok(activeUser, "active user should exist in default scope");
    assert.equal(
      activeUser.posts.length,
      1,
      "include should also be scoped and hide deleted posts",
    );
    assert.equal(activeUser.posts[0].title, ACTIVE_POST_TITLE);

    const deletedOnlyInDefault = await prisma.user.findMany({
      where: { deletedAt: { not: null } },
    });
    assert.equal(
      deletedOnlyInDefault.length,
      0,
      "default scope should block explicit deletedAt: { not: null }",
    );

    const withDeleted = await prisma.withDeleted().user.findMany({
      orderBy: { id: "asc" },
      include: {
        posts: {
          orderBy: { id: "asc" },
        },
      },
    });

    assert.equal(withDeleted.length, 3, "withDeleted should return deleted users too");
    const deletedUser = withDeleted.find((user: any) => user.email === DELETED_USER_EMAIL);
    assert.ok(deletedUser, "deleted user should be visible via withDeleted");
    assert.notEqual(deletedUser.deletedAt, null);

    const deletedOnly = await prisma.withDeleted().user.findMany({
      where: { deletedAt: { not: null } },
      orderBy: { id: "asc" },
    });
    assert.equal(deletedOnly.length, 1, "withDeleted should allow deletedAt filtering");

    const activeUserWithDeletedPosts = withDeleted.find((user: any) => user.email === ACTIVE_USER_EMAIL);
    assert.ok(activeUserWithDeletedPosts, "active user should exist via withDeleted");
    assert.equal(
      activeUserWithDeletedPosts.posts.length,
      2,
      "withDeleted include should return deleted posts too",
    );

    console.log("All verification checks passed.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
