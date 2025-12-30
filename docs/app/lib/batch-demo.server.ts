import { createAtomaHandlers, throwError } from 'atoma/server';
import type { IOrmAdapter, OrderByRule, QueryParams, QueryResult, QueryResultOne, WriteOptions } from 'atoma/server';

type ItemRow = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  version: number;
};

type StoreState = {
  items: Map<string, ItemRow>;
};

function normalizeId(value: unknown): string {
  if (typeof value === 'string') return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return String(value ?? '');
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function compareByOrderBy(a: any, b: any, orderBy: OrderByRule[]): number {
  for (const rule of orderBy) {
    const field = rule.field;
    const dir = rule.direction;
    const av = (a as any)?.[field];
    const bv = (b as any)?.[field];
    let cmp = 0;
    if (typeof av === 'number' && typeof bv === 'number') cmp = av - bv;
    else cmp = String(av ?? '').localeCompare(String(bv ?? ''));
    if (cmp !== 0) return dir === 'desc' ? -cmp : cmp;
  }
  return 0;
}

function ensureResource(resource: string) {
  if (String(resource || '') === 'items') return;
  throwError('INVALID_REQUEST', `Unsupported resource: ${resource}`, { kind: 'validation' });
}

function matchesContains(value: unknown, containsValue: unknown): boolean {
  const hay = String(value ?? '');
  const needle = String(containsValue ?? '');
  if (!needle) return true;
  return hay.includes(needle);
}

function filterWhere(rows: ItemRow[], where: Record<string, any> | undefined): ItemRow[] {
  if (!where) return rows;
  const entries = Object.entries(where);
  return rows.filter((row) => {
    for (const [key, cond] of entries) {
      const v = (row as any)[key];

      if (isObject(cond) && typeof (cond as any).contains !== 'undefined') {
        if (!matchesContains(v, (cond as any).contains)) return false;
        continue;
      }

      if (isObject(cond) && Array.isArray((cond as any).in)) {
        const list = (cond as any).in;
        if (!list.map((x: any) => normalizeId(x)).includes(normalizeId(v))) return false;
        continue;
      }

      if (v !== cond) return false;
    }
    return true;
  });
}

function getLimit(params: QueryParams): number | undefined {
  const pAny = params as any;
  const page = isObject(params.page) ? (params.page as any) : undefined;
  const limit = typeof page?.limit === 'number' ? page.limit : typeof pAny?.limit === 'number' ? pAny.limit : undefined;
  if (typeof limit !== 'number' || !Number.isFinite(limit)) return undefined;
  if (limit <= 0) return undefined;
  return Math.floor(limit);
}

function ensureSeedData(state: StoreState) {
  if (state.items.size) return;
  const now = Date.now();
  for (let bucket = 0; bucket < 5; bucket += 1) {
    for (let i = 0; i < 50; i += 1) {
      const t = now - bucket * 1000 - i;
      const id = `seed_${bucket}_${i}`;
      state.items.set(id, {
        id,
        title: `seed_${bucket} item_${i}`,
        createdAt: t,
        updatedAt: t,
        version: 1,
      });
    }
  }
}

function getState(): StoreState {
  const anyGlobal = globalThis as any;
  if (!anyGlobal.__ATOMA_DOCS_BATCH__) {
    anyGlobal.__ATOMA_DOCS_BATCH__ = {
      items: new Map<string, ItemRow>(),
    } satisfies StoreState;
  }
  const state = anyGlobal.__ATOMA_DOCS_BATCH__ as StoreState;
  ensureSeedData(state);
  return state;
}

function createMutex() {
  let chain = Promise.resolve();
  return async <T,>(fn: () => Promise<T>): Promise<T> => {
    const run = async () => fn();
    const next = chain.then(run, run);
    chain = next.then(() => undefined, () => undefined);
    return next;
  };
}

export async function getBatchDemoHandlers() {
  const anyGlobal = globalThis as any;
  if (anyGlobal.__ATOMA_DOCS_BATCH_HANDLERS__) {
    return anyGlobal.__ATOMA_DOCS_BATCH_HANDLERS__;
  }

  const state = getState();
  const withLock = createMutex();

  const orm: IOrmAdapter = {
    transaction: async (fn) => {
      return withLock(async () => {
        return fn({ orm, tx: { kind: 'mem' } as any });
      });
    },
    findMany: async (resource: string, params: QueryParams): Promise<QueryResult> => {
      ensureResource(resource);
      const list = Array.from(state.items.values());

      const where = isObject(params.where) ? (params.where as any) : undefined;
      const filtered = filterWhere(list, where);

      const orderBy = Array.isArray((params as any).orderBy)
        ? ((params as any).orderBy as any)
        : (params as any).orderBy
          ? [(params as any).orderBy as any]
          : [{ field: 'updatedAt', direction: 'desc' }];

      const sorted = filtered.slice().sort((a, b) => compareByOrderBy(a, b, orderBy));

      const limit = getLimit(params);
      const sliced = typeof limit === 'number' ? sorted.slice(0, limit) : sorted;

      const select = isObject(params.select) ? (params.select as any) : undefined;
      const mapRow = (row: ItemRow) => {
        if (!select) return row;
        const out: any = {};
        for (const [k, enabled] of Object.entries(select)) {
          if (enabled) out[k] = (row as any)[k];
        }
        out.id = row.id;
        out.version = row.version;
        return out;
      };

      return { data: sliced.map(mapRow) };
    },
    create: async (resource: string, data: any, _options?: WriteOptions): Promise<QueryResultOne> => {
      ensureResource(resource);
      const id = normalizeId(data?.id);
      if (!id) {
        throwError('INVALID_WRITE', 'Missing id for create', { kind: 'validation', resource: 'items' });
      }
      if (state.items.has(id)) {
        throwError('CONFLICT', 'Duplicate id', { kind: 'conflict', resource: 'items', currentValue: state.items.get(id) });
      }

      const now = Date.now();
      const createdAt = typeof data?.createdAt === 'number' ? data.createdAt : now;
      const updatedAt = typeof data?.updatedAt === 'number' ? data.updatedAt : now;

      const row: ItemRow = {
        id,
        title: String(data?.title ?? ''),
        createdAt,
        updatedAt,
        version: 1,
      };
      state.items.set(id, row);
      return { data: row };
    },
  };

  const handlers = createAtomaHandlers({
    sync: { enabled: false },
    adapter: { orm },
  });

  anyGlobal.__ATOMA_DOCS_BATCH_HANDLERS__ = handlers;
  return handlers;
}

