import { AsyncLocalStorage } from "node:async_hooks";
import { Prisma, PrismaClient } from "@prisma/client";

type ModelName = Prisma.ModelName;
type PlainObject = Record<string, unknown>;

type RelationFieldMeta = {
  isList: boolean;
  targetModel: ModelName;
};

type SoftDeleteContext = {
  hardDelete: boolean;
  includeDeleted: boolean;
};

type ModelDelegateContext = {
  $name: ModelName;
  $parent: Record<string, unknown>;
  update: (args: unknown) => Promise<unknown>;
  updateMany: (args: unknown) => Promise<unknown>;
};

const SOFT_DELETE_FIELD = "deletedAt";

const ROOT_SCOPED_OPERATIONS = new Set<string>([
  "aggregate",
  "count",
  "findFirst",
  "findFirstOrThrow",
  "findMany",
  "findUnique",
  "findUniqueOrThrow",
  "groupBy",
]);

const UNIQUE_READ_OPERATIONS = new Set<string>(["findUnique", "findUniqueOrThrow"]);

const LOGICAL_OPERATORS = new Set(["AND", "OR", "NOT"]);

const softDeleteContextStorage = new AsyncLocalStorage<SoftDeleteContext>();

const withDeletedProxyCache = new WeakMap<object, object>();
const hardDeleteProxyCache = new WeakMap<object, object>();

const { relationFieldsByModel, softDeleteModels } = buildModelMetadata();

function buildModelMetadata() {
  const relationFieldsByModel = new Map<ModelName, Map<string, RelationFieldMeta>>();
  const softDeleteModels = new Set<ModelName>();

  for (const model of Prisma.dmmf.datamodel.models) {
    const modelName = model.name as ModelName;
    const relations = new Map<string, RelationFieldMeta>();

    for (const field of model.fields) {
      if (field.name === SOFT_DELETE_FIELD) {
        softDeleteModels.add(modelName);
      }

      if (field.kind !== "object") {
        continue;
      }

      relations.set(field.name, {
        isList: field.isList,
        targetModel: field.type as ModelName,
      });
    }

    relationFieldsByModel.set(modelName, relations);
  }

  return { relationFieldsByModel, softDeleteModels };
}

function isPlainObject(value: unknown): value is PlainObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }

  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function deepCloneValue<T>(value: T): T {
  if (Array.isArray(value)) {
    return value.map((item) => deepCloneValue(item)) as T;
  }

  if (isPlainObject(value)) {
    const clone: PlainObject = {};
    for (const [key, nestedValue] of Object.entries(value)) {
      clone[key] = deepCloneValue(nestedValue);
    }
    return clone as T;
  }

  return value;
}

function getSoftDeleteContext(): SoftDeleteContext {
  return softDeleteContextStorage.getStore() ?? { hardDelete: false, includeDeleted: false };
}

function runWithSoftDeleteContext<T>(context: Partial<SoftDeleteContext>, fn: () => T): T {
  const current = getSoftDeleteContext();
  return softDeleteContextStorage.run({ ...current, ...context }, fn);
}

function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    "then" in value &&
    typeof (value as { then?: unknown }).then === "function"
  );
}

function toDelegateName(modelName: string): string {
  return modelName[0].toLowerCase() + modelName.slice(1);
}

function mergeDeletedAtWithAnd(where: unknown): PlainObject {
  if (where == null) {
    return { [SOFT_DELETE_FIELD]: null };
  }

  return { AND: [where, { [SOFT_DELETE_FIELD]: null }] };
}

function mergeDeletedAtForUniqueWhere(where: unknown): PlainObject {
  const uniqueWhere = isPlainObject(where) ? { ...where } : {};
  uniqueWhere[SOFT_DELETE_FIELD] = null;
  return uniqueWhere;
}

function scopeLogicalOperator(modelName: ModelName, value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => scopeWhere(modelName, item));
  }

  if (isPlainObject(value)) {
    return scopeWhere(modelName, value);
  }

  return deepCloneValue(value);
}

function scopeListRelationFilter(targetModel: ModelName, relationFilter: PlainObject): PlainObject {
  const scopedFilter = deepCloneValue(relationFilter);

  for (const operator of ["some", "none", "every"] as const) {
    if (!(operator in relationFilter)) {
      continue;
    }

    const rawValue = relationFilter[operator];
    const scopedValue = scopeWhere(targetModel, rawValue);

    if (!softDeleteModels.has(targetModel)) {
      scopedFilter[operator] = scopedValue;
      continue;
    }

    if (operator === "every") {
      scopedFilter[operator] = {
        OR: [{ [SOFT_DELETE_FIELD]: { not: null } }, isPlainObject(scopedValue) ? scopedValue : {}],
      };
      continue;
    }

    scopedFilter[operator] = mergeDeletedAtWithAnd(scopedValue);
  }

  return scopedFilter;
}

function scopeToOneRelationFilter(targetModel: ModelName, relationFilter: PlainObject): PlainObject {
  const scopedFilter = deepCloneValue(relationFilter);
  let hasExplicitIsOperator = false;

  if ("is" in relationFilter) {
    hasExplicitIsOperator = true;
    const scopedIs = scopeWhere(targetModel, relationFilter.is);
    scopedFilter.is = softDeleteModels.has(targetModel) ? mergeDeletedAtWithAnd(scopedIs) : scopedIs;
  }

  if ("isNot" in relationFilter) {
    hasExplicitIsOperator = true;
    scopedFilter.isNot = scopeWhere(targetModel, relationFilter.isNot);
  }

  if (hasExplicitIsOperator) {
    return scopedFilter;
  }

  const scopedShorthand = scopeWhere(targetModel, relationFilter);
  if (!softDeleteModels.has(targetModel)) {
    return isPlainObject(scopedShorthand) ? scopedShorthand : {};
  }

  return mergeDeletedAtWithAnd(scopedShorthand);
}

function scopeWhere(modelName: ModelName, where: unknown): unknown {
  if (!isPlainObject(where)) {
    return deepCloneValue(where);
  }

  const scopedWhere: PlainObject = {};
  const relationFields = relationFieldsByModel.get(modelName);

  for (const [key, value] of Object.entries(where)) {
    if (LOGICAL_OPERATORS.has(key)) {
      scopedWhere[key] = scopeLogicalOperator(modelName, value);
      continue;
    }

    const relation = relationFields?.get(key);
    if (!relation || !isPlainObject(value)) {
      scopedWhere[key] = deepCloneValue(value);
      continue;
    }

    scopedWhere[key] = relation.isList
      ? scopeListRelationFilter(relation.targetModel, value)
      : scopeToOneRelationFilter(relation.targetModel, value);
  }

  return scopedWhere;
}

function scopeCountSelection(modelName: ModelName, relationContainer: PlainObject): void {
  const relationFields = relationFieldsByModel.get(modelName);
  if (!relationFields) {
    return;
  }

  const countSelection = relationContainer._count;
  if (!isPlainObject(countSelection)) {
    return;
  }

  const countSelect = countSelection.select;
  if (!isPlainObject(countSelect)) {
    return;
  }

  for (const [fieldName, fieldSelection] of Object.entries(countSelect)) {
    const relation = relationFields.get(fieldName);
    if (!relation || !relation.isList || !softDeleteModels.has(relation.targetModel)) {
      continue;
    }

    if (fieldSelection === true) {
      countSelect[fieldName] = { where: { [SOFT_DELETE_FIELD]: null } };
      continue;
    }

    if (!isPlainObject(fieldSelection)) {
      continue;
    }

    const scopedWhere = scopeWhere(relation.targetModel, fieldSelection.where);
    fieldSelection.where = mergeDeletedAtWithAnd(scopedWhere);
  }
}

function scopeNestedRelationSelections(modelName: ModelName, args: PlainObject): void {
  const relationFields = relationFieldsByModel.get(modelName);
  if (!relationFields) {
    return;
  }

  for (const key of ["include", "select"] as const) {
    const relationContainer = args[key];
    if (!isPlainObject(relationContainer)) {
      continue;
    }

    scopeCountSelection(modelName, relationContainer);

    for (const [relationName, relationSelection] of Object.entries(relationContainer)) {
      const relation = relationFields.get(relationName);
      if (!relation) {
        continue;
      }

      if (relationSelection === true) {
        if (relation.isList && softDeleteModels.has(relation.targetModel)) {
          relationContainer[relationName] = { where: { [SOFT_DELETE_FIELD]: null } };
        }
        continue;
      }

      if (!isPlainObject(relationSelection)) {
        continue;
      }

      const hasWhere =
        Object.prototype.hasOwnProperty.call(relationSelection, "where") &&
        relationSelection.where !== undefined;
      const scopedWhere = hasWhere ? scopeWhere(relation.targetModel, relationSelection.where) : undefined;

      if (relation.isList && softDeleteModels.has(relation.targetModel)) {
        relationSelection.where = mergeDeletedAtWithAnd(scopedWhere);
      } else if (hasWhere) {
        relationSelection.where = scopedWhere;
      }

      scopeNestedRelationSelections(relation.targetModel, relationSelection);
    }
  }
}

function scopeReadArgs(modelName: ModelName, operation: string, args: unknown): unknown {
  const scopedArgs = isPlainObject(args) ? deepCloneValue(args) : {};

  if (Object.prototype.hasOwnProperty.call(scopedArgs, "where") && scopedArgs.where !== undefined) {
    scopedArgs.where = scopeWhere(modelName, scopedArgs.where);
  }
  scopeNestedRelationSelections(modelName, scopedArgs);

  if (!softDeleteModels.has(modelName) || !ROOT_SCOPED_OPERATIONS.has(operation)) {
    return scopedArgs;
  }

  const existingWhere =
    Object.prototype.hasOwnProperty.call(scopedArgs, "where") && scopedArgs.where !== undefined
      ? scopedArgs.where
      : undefined;

  scopedArgs.where = UNIQUE_READ_OPERATIONS.has(operation)
    ? mergeDeletedAtForUniqueWhere(existingWhere)
    : mergeDeletedAtWithAnd(existingWhere);

  return scopedArgs;
}

function getParentDelegate(context: ModelDelegateContext): Record<string, unknown> {
  return context.$parent[toDelegateName(context.$name)] as Record<string, unknown>;
}

function buildSoftDeleteUpdateData(existingData: unknown): PlainObject {
  const nextData = isPlainObject(existingData) ? deepCloneValue(existingData) : {};
  nextData[SOFT_DELETE_FIELD] = new Date();
  return nextData;
}

async function handleDeleteOperation(
  extensionThis: unknown,
  operation: "delete" | "deleteMany",
  args: unknown,
) {
  const context = Prisma.getExtensionContext(extensionThis) as ModelDelegateContext;
  const parentDelegate = getParentDelegate(context);
  const runtimeContext = getSoftDeleteContext();
  const normalizedArgs = isPlainObject(args) ? deepCloneValue(args) : {};

  if (runtimeContext.hardDelete || !softDeleteModels.has(context.$name)) {
    const hardDelete = parentDelegate[operation];
    if (typeof hardDelete !== "function") {
      throw new Error(`Model '${context.$name}' does not support ${operation}.`);
    }
    return Reflect.apply(hardDelete, parentDelegate, [normalizedArgs]);
  }

  if (operation === "delete") {
    return context.update({
      ...normalizedArgs,
      data: buildSoftDeleteUpdateData(normalizedArgs.data),
    });
  }

  return context.updateMany({
    ...normalizedArgs,
    data: buildSoftDeleteUpdateData(normalizedArgs.data),
  });
}

function getContextProxy<T extends object>(
  target: T,
  context: Partial<SoftDeleteContext>,
  cache: WeakMap<object, object>,
): T {
  const cached = cache.get(target);
  if (cached) {
    return cached as T;
  }

  const proxy = new Proxy(target, {
    get(originalTarget, property, receiver) {
      if (property === "withDeleted") {
        return () => getContextProxy(target, { includeDeleted: true }, withDeletedProxyCache);
      }

      if (property === "hardDelete") {
        return () => getContextProxy(target, { hardDelete: true, includeDeleted: true }, hardDeleteProxyCache);
      }

      const value = Reflect.get(originalTarget, property, receiver);

      if (typeof value === "function") {
        return (...args: unknown[]) =>
          runWithSoftDeleteContext(context, () => {
            const result = Reflect.apply(value, originalTarget, args);
            if (!isPromiseLike(result)) {
              return result;
            }
            return (async () => await result)();
          });
      }

      if (value && typeof value === "object") {
        return getContextProxy(value as object, context, cache);
      }

      return value;
    },
  });

  cache.set(target, proxy);
  return proxy;
}

function extendWithSoftDelete(baseClient: PrismaClient) {
  return baseClient
    .$extends({
      name: "soft-delete-read-scope",
      query: {
        $allModels: {
          async $allOperations({ model, operation, args, query }) {
            if (!model || getSoftDeleteContext().includeDeleted) {
              return query(args);
            }

            return query(scopeReadArgs(model as ModelName, operation, args) as never);
          },
        },
      },
    })
    .$extends({
      name: "soft-delete-write-transform",
      model: {
        $allModels: {
          async delete(this: unknown, args: unknown) {
            return handleDeleteOperation(this, "delete", args);
          },
          async deleteMany(this: unknown, args: unknown) {
            return handleDeleteOperation(this, "deleteMany", args);
          },
        },
      },
    })
    .$extends({
      name: "soft-delete-client-controls",
      client: {
        withDeleted(this: object): any {
          return getContextProxy(this, { includeDeleted: true }, withDeletedProxyCache);
        },
        hardDelete(this: object): any {
          return getContextProxy(
            this,
            { hardDelete: true, includeDeleted: true },
            hardDeleteProxyCache,
          );
        },
      },
    });
}

type InternalClient = ReturnType<typeof extendWithSoftDelete>;

export type AppPrismaClient = InternalClient & {
  withDeleted(): AppPrismaClient;
  hardDelete(): AppPrismaClient;
};

export function createPrisma(): AppPrismaClient {
  const baseClient = new PrismaClient();
  return extendWithSoftDelete(baseClient) as AppPrismaClient;
}
