import { Prisma, PrismaClient } from "@prisma/client";

type RelationMeta = {
  isList: boolean;
  targetModel: Prisma.ModelName;
};

const SOFT_DELETE_MODELS = new Set<Prisma.ModelName>(
  Prisma.dmmf.datamodel.models
    .filter((model) => model.fields.some((field) => field.name === "deletedAt"))
    .map((model) => model.name as Prisma.ModelName),
);

const RELATION_META = new Map<Prisma.ModelName, Map<string, RelationMeta>>(
  Prisma.dmmf.datamodel.models.map((model) => {
    const fields = new Map<string, RelationMeta>();

    for (const field of model.fields) {
      if (field.kind !== "object") {
        continue;
      }

      fields.set(field.name, {
        isList: field.isList,
        targetModel: field.type as Prisma.ModelName,
      });
    }

    return [model.name as Prisma.ModelName, fields];
  }),
);

function addNotDeletedWhere(where: unknown): Record<string, unknown> {
  if (where == null) {
    return { deletedAt: null };
  }

  return { AND: [where, { deletedAt: null }] };
}

function scopeNestedRelations(modelName: Prisma.ModelName, args: Record<string, unknown>) {
  const relationFields = RELATION_META.get(modelName);
  if (!relationFields) {
    return;
  }

  for (const key of ["include", "select"] as const) {
    const relationContainer = args[key];
    if (!relationContainer || typeof relationContainer !== "object") {
      continue;
    }

    for (const [fieldName, fieldValue] of Object.entries(relationContainer)) {
      const relation = relationFields.get(fieldName);
      if (!relation) {
        continue;
      }

      if (fieldValue === true) {
        if (relation.isList && SOFT_DELETE_MODELS.has(relation.targetModel)) {
          (relationContainer as Record<string, unknown>)[fieldName] = {
            where: { deletedAt: null },
          };
        }
        continue;
      }

      if (!fieldValue || typeof fieldValue !== "object") {
        continue;
      }

      const nestedArgs = fieldValue as Record<string, unknown>;

      if (relation.isList && SOFT_DELETE_MODELS.has(relation.targetModel)) {
        nestedArgs.where = addNotDeletedWhere(nestedArgs.where);
      }

      scopeNestedRelations(relation.targetModel, nestedArgs);
    }
  }
}

function withSoftDeleteScope(baseClient: PrismaClient) {
  return baseClient
    .$extends({
      name: "soft-delete-scope",
      query: {
        $allModels: {
          async findMany({ model, args, query }) {
            const modelName = model as Prisma.ModelName;
            const scopedArgs = { ...(args ?? {}) } as Record<string, unknown>;

            if (SOFT_DELETE_MODELS.has(modelName)) {
              scopedArgs.where = addNotDeletedWhere(scopedArgs.where);
            }

            scopeNestedRelations(modelName, scopedArgs);

            return query(scopedArgs);
          },
        },
      },
    })
    .$extends({
      name: "soft-delete-exception",
      client: {
        withDeleted() {
          return baseClient;
        },
      },
    });
}

export function createPrisma() {
  const baseClient = new PrismaClient();
  return withSoftDeleteScope(baseClient);
}

export type AppPrismaClient = ReturnType<typeof createPrisma>;
