import type { AppPrismaClient } from "./prisma-client";

export const ACTIVE_USER_EMAIL = "active@example.com";
export const ACTIVE_USER_2_EMAIL = "active2@example.com";
export const DELETED_USER_EMAIL = "deleted@example.com";

export const ACTIVE_POST_TITLE = "Active Post";
export const DELETED_POST_TITLE = "Deleted Post";

export async function resetScenarioData(prisma: AppPrismaClient): Promise<void> {
  await prisma.hardDelete().post.deleteMany();
  await prisma.hardDelete().user.deleteMany();
}

export async function seedScenarioData(prisma: AppPrismaClient): Promise<void> {
  await prisma.withDeleted().user.create({
    data: {
      email: ACTIVE_USER_EMAIL,
      name: "Active User",
      posts: {
        create: [
          {
            title: ACTIVE_POST_TITLE,
            content: "visible in default scope",
          },
          {
            title: DELETED_POST_TITLE,
            content: "hidden by default scope",
            deletedAt: new Date("2026-01-01T00:00:00.000Z"),
          },
        ],
      },
    },
  });

  await prisma.withDeleted().user.create({
    data: {
      email: DELETED_USER_EMAIL,
      name: "Deleted User",
      deletedAt: new Date("2026-01-02T00:00:00.000Z"),
      posts: {
        create: [
          {
            title: "Post from Deleted User",
            content: "still exists in DB",
          },
        ],
      },
    },
  });

  await prisma.withDeleted().user.create({
    data: {
      email: ACTIVE_USER_2_EMAIL,
      name: "Active User 2",
    },
  });
}

export async function resetAndSeedScenarioData(prisma: AppPrismaClient): Promise<void> {
  await resetScenarioData(prisma);
  await seedScenarioData(prisma);
}
