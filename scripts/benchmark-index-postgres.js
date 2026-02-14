const { execFileSync } = require("child_process");
const fs = require("fs");
const path = require("path");

const ROOT_DIR = path.resolve(__dirname, "..");
const SCHEMA_PATH = path.join(ROOT_DIR, "prisma", "schema.postgres.prisma");
const OUTPUT_DIR = path.join(
  ROOT_DIR,
  process.env.INDEX_BENCH_OUTPUT_DIR || "artifacts",
);
const CACHE_DIR = path.join(ROOT_DIR, ".prisma-cache");
const DATABASE_URL =
  process.env.DATABASE_URL ||
  "postgresql://prisma:prisma@localhost:5432/prisma?connection_limit=1";

const DEFAULT_DATASET_SIZES = [20000, 100000];
const DATASET_SIZES = parseIntegerList(
  process.env.INDEX_BENCH_SIZES,
  DEFAULT_DATASET_SIZES,
);
const RUNS = parseInteger(process.env.INDEX_BENCH_RUNS, 15);
const WARMUPS = parseInteger(process.env.INDEX_BENCH_WARMUPS, 3);
const WRITE_BATCH_SIZE = parseInteger(process.env.INDEX_BENCH_WRITE_BATCH, 1000);
const INSERT_BATCH_SIZE = parseInteger(process.env.INDEX_BENCH_INSERT_BATCH, 1000);

const TENANT_CARDINALITY = 200;
const STATUS_CHUNK = 10;
const HOT_STATUS = 1;
const COLD_STATUS = 0;
const PAYLOAD = "x".repeat(120);

const SCENARIOS = [
  {
    name: "baseline",
    description: "id(primary key) のみ",
    statements: [],
  },
  {
    name: "selective_indexes",
    description: "選択性が高い列だけ index",
    statements: [
      'CREATE INDEX IF NOT EXISTS "idx_br_email" ON "BenchmarkRecord" ("email")',
      'CREATE INDEX IF NOT EXISTS "idx_br_tenant_status" ON "BenchmarkRecord" ("tenantId","status")',
      'CREATE INDEX IF NOT EXISTS "idx_bi_email" ON "BenchmarkInsert" ("email")',
      'CREATE INDEX IF NOT EXISTS "idx_bi_tenant_status" ON "BenchmarkInsert" ("tenantId","status")',
    ],
  },
  {
    name: "over_indexed",
    description: "低選択性や用途不明の列にも追加",
    statements: [
      'CREATE INDEX IF NOT EXISTS "idx_br_email" ON "BenchmarkRecord" ("email")',
      'CREATE INDEX IF NOT EXISTS "idx_br_tenant_status" ON "BenchmarkRecord" ("tenantId","status")',
      'CREATE INDEX IF NOT EXISTS "idx_br_status" ON "BenchmarkRecord" ("status")',
      'CREATE INDEX IF NOT EXISTS "idx_br_score" ON "BenchmarkRecord" ("score")',
      'CREATE INDEX IF NOT EXISTS "idx_br_created_at" ON "BenchmarkRecord" ("createdAt")',
      'CREATE INDEX IF NOT EXISTS "idx_bi_email" ON "BenchmarkInsert" ("email")',
      'CREATE INDEX IF NOT EXISTS "idx_bi_tenant_status" ON "BenchmarkInsert" ("tenantId","status")',
      'CREATE INDEX IF NOT EXISTS "idx_bi_status" ON "BenchmarkInsert" ("status")',
      'CREATE INDEX IF NOT EXISTS "idx_bi_score" ON "BenchmarkInsert" ("score")',
      'CREATE INDEX IF NOT EXISTS "idx_bi_created_at" ON "BenchmarkInsert" ("createdAt")',
    ],
  },
];

const ALL_INDEX_NAMES = [
  "idx_br_email",
  "idx_br_tenant_status",
  "idx_br_status",
  "idx_br_score",
  "idx_br_created_at",
  "idx_bi_email",
  "idx_bi_tenant_status",
  "idx_bi_status",
  "idx_bi_score",
  "idx_bi_created_at",
];

function parseInteger(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function parseIntegerList(value, fallback) {
  if (!value) {
    return fallback;
  }

  const parsed = value
    .split(",")
    .map((entry) => Number.parseInt(entry.trim(), 10))
    .filter((entry) => Number.isFinite(entry) && entry > 0);

  return parsed.length > 0 ? parsed : fallback;
}

function createRng(seed) {
  let current = seed >>> 0;
  return () => {
    current = (current * 1664525 + 1013904223) >>> 0;
    return current / 0x100000000;
  };
}

function nowMs() {
  return Number(process.hrtime.bigint()) / 1_000_000;
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function average(values) {
  if (values.length === 0) {
    return 0;
  }
  const total = values.reduce((sum, value) => sum + value, 0);
  return total / values.length;
}

function percentile(values, ratio) {
  if (values.length === 0) {
    return 0;
  }

  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.max(
    0,
    Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * ratio)),
  );
  return sorted[index];
}

function summarizeDurations(samples) {
  return {
    samples: samples.length,
    minMs: round(Math.min(...samples)),
    maxMs: round(Math.max(...samples)),
    avgMs: round(average(samples)),
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
  };
}

function toRowsPerSec(rowsPerOp, avgMs) {
  if (!avgMs) {
    return null;
  }
  return round((rowsPerOp / avgMs) * 1000);
}

async function measureOperation({
  warmups,
  runs,
  beforeEach,
  task,
  afterEach,
}) {
  for (let i = 0; i < warmups; i += 1) {
    if (beforeEach) {
      await beforeEach(i, true);
    }
    await task(i, true);
    if (afterEach) {
      await afterEach(i, true);
    }
  }

  const durations = [];
  const numericResults = [];

  for (let i = 0; i < runs; i += 1) {
    if (beforeEach) {
      await beforeEach(i, false);
    }

    const started = nowMs();
    const result = await task(i, false);
    const ended = nowMs();

    if (afterEach) {
      await afterEach(i, false);
    }

    durations.push(ended - started);
    if (typeof result === "number") {
      numericResults.push(result);
    }
  }

  const summary = summarizeDurations(durations);
  if (numericResults.length > 0) {
    summary.resultAvg = round(average(numericResults));
    summary.resultMin = Math.min(...numericResults);
    summary.resultMax = Math.max(...numericResults);
  }
  return summary;
}

function benchmarkRecordData(index, scenarioName) {
  const tenantId = index % TENANT_CARDINALITY;
  const statusBlock = Math.floor(index / TENANT_CARDINALITY) % STATUS_CHUNK;
  const status = statusBlock < STATUS_CHUNK / 2 ? HOT_STATUS : COLD_STATUS;
  return {
    tenantId,
    status,
    score: (index * 17) % 10000,
    email: `${scenarioName}-user-${index}@example.com`,
    payload: PAYLOAD,
  };
}

function benchmarkInsertData(index, runId, scenarioName, sizeTag) {
  return {
    tenantId: (index + runId) % TENANT_CARDINALITY,
    status: (index + runId) % STATUS_CHUNK < STATUS_CHUNK / 2 ? HOT_STATUS : COLD_STATUS,
    score: (index * 31 + runId) % 10000,
    email: `${scenarioName}-${sizeTag}-run-${runId}-insert-${index}@example.com`,
    payload: PAYLOAD,
  };
}

async function seedBenchmarkRecord(prisma, datasetSize, scenarioName) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "BenchmarkRecord" RESTART IDENTITY CASCADE',
  );

  for (let offset = 0; offset < datasetSize; offset += INSERT_BATCH_SIZE) {
    const rows = [];
    const end = Math.min(offset + INSERT_BATCH_SIZE, datasetSize);
    for (let i = offset; i < end; i += 1) {
      rows.push(benchmarkRecordData(i, scenarioName));
    }
    await prisma.benchmarkRecord.createMany({ data: rows });
  }
}

async function resetInsertTable(prisma) {
  await prisma.$executeRawUnsafe(
    'TRUNCATE TABLE "BenchmarkInsert" RESTART IDENTITY CASCADE',
  );
}

async function dropAllIndexes(prisma) {
  for (const indexName of ALL_INDEX_NAMES) {
    await prisma.$executeRawUnsafe(`DROP INDEX IF EXISTS "${indexName}"`);
  }
}

async function applyScenarioIndexes(prisma, scenario) {
  for (const statement of scenario.statements) {
    await prisma.$executeRawUnsafe(statement);
  }
}

async function explainSummary(prisma, query, params = []) {
  const rows = await prisma.$queryRawUnsafe(query, ...params);
  const rawPlan = rows?.[0]?.["QUERY PLAN"];
  if (!rawPlan) {
    return null;
  }

  let parsed = rawPlan;
  if (typeof rawPlan === "string") {
    parsed = JSON.parse(rawPlan);
  }
  if (!Array.isArray(parsed) || parsed.length === 0) {
    return null;
  }

  const planRoot = parsed[0];
  return {
    rootNodeType: planRoot?.Plan?.["Node Type"] ?? null,
    planningTimeMs: round(planRoot?.["Planning Time"] ?? 0),
    executionTimeMs: round(planRoot?.["Execution Time"] ?? 0),
  };
}

function compareWithBaseline(currentAvgMs, baselineAvgMs) {
  if (!baselineAvgMs || !currentAvgMs) {
    return null;
  }
  return round(baselineAvgMs / currentAvgMs);
}

function formatMs(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${value.toFixed(3)}ms`;
}

function formatRatio(value) {
  if (value === null || value === undefined) {
    return "-";
  }
  return `${value.toFixed(2)}x`;
}

function buildMarkdownReport(report) {
  const lines = [];
  lines.push("# PostgreSQL Index Benchmark Report");
  lines.push("");
  lines.push(`Generated at: ${report.generatedAt}`);
  lines.push(`Database URL: \`${report.database.url}\``);
  lines.push("");
  lines.push("## Setup");
  lines.push("");
  lines.push(`- dataset sizes: ${report.config.datasetSizes.join(", ")}`);
  lines.push(`- warmups: ${report.config.warmups}`);
  lines.push(`- measured runs: ${report.config.runs}`);
  lines.push(`- create batch size: ${report.config.writeBatchSize}`);
  lines.push("");
  lines.push("## Scenario Definitions");
  lines.push("");
  for (const scenario of SCENARIOS) {
    lines.push(`- \`${scenario.name}\`: ${scenario.description}`);
  }
  lines.push("");

  for (const block of report.results) {
    lines.push(`## Dataset: ${block.datasetSize.toLocaleString()} rows`);
    lines.push("");
    lines.push("| Metric | baseline | selective_indexes | over_indexed |");
    lines.push("|---|---:|---:|---:|");

    const baseline = block.scenarios.find((entry) => entry.scenario === "baseline");
    for (const metric of Object.keys(block.scenarios[0].metrics)) {
      const baselineAvg = baseline?.metrics?.[metric]?.avgMs ?? null;
      const cells = [];
      for (const scenarioName of ["baseline", "selective_indexes", "over_indexed"]) {
        const scenario = block.scenarios.find((entry) => entry.scenario === scenarioName);
        const metricValue = scenario?.metrics?.[metric] ?? null;
        if (!metricValue) {
          cells.push("-");
          continue;
        }

        const ratio = compareWithBaseline(metricValue.avgMs, baselineAvg);
        if (scenarioName === "baseline") {
          cells.push(`${formatMs(metricValue.avgMs)}`);
          continue;
        }
        cells.push(`${formatMs(metricValue.avgMs)} (${formatRatio(ratio)})`);
      }
      lines.push(`| ${metric} | ${cells[0]} | ${cells[1]} | ${cells[2]} |`);
    }

    lines.push("");
    lines.push("### EXPLAIN (ANALYZE) Highlights");
    lines.push("");
    lines.push("| Query | baseline node | selective node | over_indexed node |");
    lines.push("|---|---|---|---|");

    for (const queryName of ["pointReadByEmail", "selectiveReadByTenantStatus", "lowSelectivityReadByStatus"]) {
      const nodes = [];
      for (const scenarioName of ["baseline", "selective_indexes", "over_indexed"]) {
        const scenario = block.scenarios.find((entry) => entry.scenario === scenarioName);
        const explain = scenario?.explain?.[queryName];
        nodes.push(explain?.rootNodeType || "-");
      }
      lines.push(`| ${queryName} | ${nodes[0]} | ${nodes[1]} | ${nodes[2]} |`);
    }
    lines.push("");
  }

  lines.push("## Index Decision Formula");
  lines.push("");
  lines.push("- index should be kept when: `read_gain_ms * read_qps > write_penalty_ms * write_qps`");
  lines.push("- use this benchmark's `avgMs` to estimate the gain/penalty side.");
  lines.push("");
  return `${lines.join("\n")}\n`;
}

function ensurePrismaClient() {
  const prismaShim = path.join(ROOT_DIR, "node_modules", ".bin", "prisma");
  const prismaJsEntry = path.join(
    ROOT_DIR,
    "node_modules",
    "prisma",
    "build",
    "index.js",
  );

  const env = {
    ...process.env,
    DATABASE_URL,
    CACHE_DIR,
    PRISMA_HIDE_UPDATE_MESSAGE: "1",
  };

  if (fs.existsSync(prismaShim)) {
    execFileSync(prismaShim, ["generate", "--schema", SCHEMA_PATH], {
      stdio: "inherit",
      env,
    });
    execFileSync(
      prismaShim,
      ["db", "push", "--skip-generate", "--schema", SCHEMA_PATH],
      {
        stdio: "inherit",
        env,
      },
    );
    return;
  }

  if (fs.existsSync(prismaJsEntry)) {
    execFileSync(process.execPath, [prismaJsEntry, "generate", "--schema", SCHEMA_PATH], {
      stdio: "inherit",
      env,
    });
    execFileSync(
      process.execPath,
      [prismaJsEntry, "db", "push", "--skip-generate", "--schema", SCHEMA_PATH],
      {
        stdio: "inherit",
        env,
      },
    );
    return;
  }

  throw new Error(
    `Prisma CLI not found. Expected either ${prismaShim} or ${prismaJsEntry}. Run: npm install`,
  );
}

async function runBenchmark(prisma, scenario, datasetSize) {
  await dropAllIndexes(prisma);
  await applyScenarioIndexes(prisma, scenario);
  await seedBenchmarkRecord(prisma, datasetSize, scenario.name);
  await resetInsertTable(prisma);

  const rng = createRng(datasetSize * 97 + scenario.name.length * 31);
  const randomTenantId = () => Math.floor(rng() * TENANT_CARDINALITY);
  const randomEmail = () =>
    `${scenario.name}-user-${Math.floor(rng() * datasetSize)}@example.com`;

  const metrics = {};
  metrics.pointReadByEmail = await measureOperation({
    warmups: WARMUPS,
    runs: RUNS,
    task: async () => {
      await prisma.benchmarkRecord.findFirst({
        where: { email: randomEmail() },
        select: { id: true, email: true },
      });
    },
  });

  metrics.selectiveReadByTenantStatus = await measureOperation({
    warmups: WARMUPS,
    runs: RUNS,
    task: async () => {
      await prisma.benchmarkRecord.count({
        where: { tenantId: randomTenantId(), status: HOT_STATUS },
      });
    },
  });

  metrics.lowSelectivityReadByStatus = await measureOperation({
    warmups: WARMUPS,
    runs: RUNS,
    task: async () => {
      await prisma.benchmarkRecord.count({
        where: { status: HOT_STATUS },
      });
    },
  });

  metrics.selectiveUpdateByTenantStatus = await measureOperation({
    warmups: WARMUPS,
    runs: RUNS,
    task: async () => {
      const result = await prisma.benchmarkRecord.updateMany({
        where: { tenantId: randomTenantId(), status: HOT_STATUS },
        data: { score: { increment: 1 } },
      });
      return result.count;
    },
  });

  metrics.createMany = await measureOperation({
    warmups: WARMUPS,
    runs: RUNS,
    beforeEach: async () => {
      await resetInsertTable(prisma);
    },
    task: async (runId) => {
      const rows = [];
      for (let i = 0; i < WRITE_BATCH_SIZE; i += 1) {
        rows.push(benchmarkInsertData(i, runId, scenario.name, datasetSize));
      }
      const result = await prisma.benchmarkInsert.createMany({ data: rows });
      return result.count;
    },
  });
  metrics.createMany.rowsPerSec = toRowsPerSec(
    WRITE_BATCH_SIZE,
    metrics.createMany.avgMs,
  );

  const explain = {
    pointReadByEmail: await explainSummary(
      prisma,
      'EXPLAIN (ANALYZE, FORMAT JSON) SELECT id, email FROM "BenchmarkRecord" WHERE "email" = $1 LIMIT 1',
      [`${scenario.name}-user-${Math.floor(datasetSize / 2)}@example.com`],
    ),
    selectiveReadByTenantStatus: await explainSummary(
      prisma,
      'EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM "BenchmarkRecord" WHERE "tenantId" = $1 AND "status" = $2',
      [42, HOT_STATUS],
    ),
    lowSelectivityReadByStatus: await explainSummary(
      prisma,
      'EXPLAIN (ANALYZE, FORMAT JSON) SELECT count(*) FROM "BenchmarkRecord" WHERE "status" = $1',
      [HOT_STATUS],
    ),
  };

  return {
    scenario: scenario.name,
    description: scenario.description,
    indexes: scenario.statements,
    metrics,
    explain,
  };
}

async function main() {
  fs.mkdirSync(OUTPUT_DIR, { recursive: true });
  fs.mkdirSync(CACHE_DIR, { recursive: true });

  ensurePrismaClient();
  process.env.DATABASE_URL = DATABASE_URL;
  const { PrismaClient } = require(path.join(ROOT_DIR, "generated", "postgres"));
  const prisma = new PrismaClient();

  const report = {
    generatedAt: new Date().toISOString(),
    database: {
      provider: "postgresql",
      url: DATABASE_URL,
    },
    config: {
      datasetSizes: DATASET_SIZES,
      warmups: WARMUPS,
      runs: RUNS,
      writeBatchSize: WRITE_BATCH_SIZE,
      insertBatchSize: INSERT_BATCH_SIZE,
    },
    results: [],
  };

  try {
    for (const datasetSize of DATASET_SIZES) {
      console.log(`\n[dataset=${datasetSize}] start`);
      const block = {
        datasetSize,
        scenarios: [],
      };

      for (const scenario of SCENARIOS) {
        console.log(`  - scenario=${scenario.name}: preparing`);
        const scenarioResult = await runBenchmark(prisma, scenario, datasetSize);
        block.scenarios.push(scenarioResult);

        const pointRead = scenarioResult.metrics.pointReadByEmail.avgMs;
        const createMany = scenarioResult.metrics.createMany.avgMs;
        console.log(
          `  - scenario=${scenario.name}: pointRead=${pointRead}ms createMany=${createMany}ms`,
        );
      }
      report.results.push(block);
    }
  } finally {
    await dropAllIndexes(prisma);
    await prisma.$disconnect();
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const jsonPath = path.join(OUTPUT_DIR, `index-benchmark-${timestamp}.json`);
  const markdownPath = path.join(OUTPUT_DIR, `index-benchmark-${timestamp}.md`);

  fs.writeFileSync(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  fs.writeFileSync(markdownPath, buildMarkdownReport(report), "utf8");

  console.log(`\nWrote JSON report: ${jsonPath}`);
  console.log(`Wrote Markdown report: ${markdownPath}`);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
