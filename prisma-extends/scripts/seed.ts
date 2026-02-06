import { createPrisma } from "./prisma-client";

async function main() {
  const prisma = createPrisma();

  try {
    await prisma.withDeleted().post.deleteMany();
    await prisma.withDeleted().user.deleteMany();

    await prisma.withDeleted().user.create({
      data: {
        email: "active@example.com",
        name: "Active User",
        posts: {
          create: [
            {
              title: "Active Post",
              content: "visible in default scope",
            },
            {
              title: "Deleted Post",
              content: "hidden by default scope",
              deletedAt: new Date("2026-01-01T00:00:00.000Z"),
            },
          ],
        },
      },
    });

    await prisma.withDeleted().user.create({
      data: {
        email: "deleted@example.com",
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
        email: "active2@example.com",
        name: "Active User 2",
      },
    });

    console.log("Seed completed.");
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
