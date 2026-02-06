const { execSync } = require("child_process");
const path = require("path");

const datasets = [
  { email: "alice@example.com", name: "Alice 1" },
  { email: "bob@example.com", name: "Bob" },
  { email: "alice@example.com", name: "Alice duplicate" },
];

const cases = [
  {
    name: "postgres",
    schema: "prisma/schema.postgres.prisma",
    clientPath: "../generated/postgres",
    url: "postgresql://prisma:prisma@localhost:5432/prisma?connection_limit=1",
  },
  {
    name: "mysql",
    schema: "prisma/schema.mysql.prisma",
    clientPath: "../generated/mysql",
    url: "mysql://prisma:prisma@localhost:3306/prisma",
  },
  {
    name: "mariadb",
    schema: "prisma/schema.mariadb.prisma",
    clientPath: "../generated/mariadb",
    url: "mysql://prisma:prisma@localhost:3307/prisma",
  },
  {
    name: "sqlite",
    schema: "prisma/schema.sqlite.prisma",
    clientPath: "../generated/sqlite",
    url: "file:./prisma/dev.db",
  },
  {
    name: "mongo",
    schema: "prisma/schema.mongo.prisma",
    clientPath: "../generated/mongo",
    url: "mongodb://prisma:prisma@localhost:27017/prisma?authSource=admin",
  },
];

const run = async () => {
  const cacheDir = path.join(process.cwd(), ".prisma-cache");

  for (const cfg of cases) {
    console.log(`\n=== ${cfg.name.toUpperCase()} ===`);
    const env = { ...process.env, DATABASE_URL: cfg.url, CACHE_DIR: cacheDir };

    try {
      execSync(`npx prisma generate --schema ${cfg.schema}`, {
        stdio: "inherit",
        env,
      });
      execSync(`npx prisma db push --skip-generate --schema ${cfg.schema}`, {
        stdio: "inherit",
        env,
      });
    } catch (err) {
      console.error(`db push/generate failed for ${cfg.name}:`, err.message);
      continue;
    }

    // Prisma Client reads DATABASE_URL at runtime as well.
    process.env.DATABASE_URL = cfg.url;

    // Import the generated client fresh per provider.
    const { PrismaClient } = require(path.join(__dirname, cfg.clientPath));
    const client = new PrismaClient({
      log: [{ emit: "stdout", level: "query" }],
    });

    try {
      await client.user.deleteMany();
      const res = await client.user.createMany({
        data: datasets,
        skipDuplicates: true,
      });
      console.log("createMany result:", res);
    } catch (err) {
      console.error(`createMany failed for ${cfg.name}:`, err.message);
    } finally {
      await client.$disconnect();
    }
  }
};

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
