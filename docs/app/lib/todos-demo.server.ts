import { applyPatches } from 'immer';
import { createAtomaHandlers, throwError } from 'atoma/server';
import type { AtomaChange, IdempotencyResult, IOrmAdapter, ISyncAdapter, OrderByRule, QueryParams, QueryResult, QueryResultOne, WriteOptions } from 'atoma/server';

type TodoRow = {
  id: string;
  title: string;
  status: string;
  order: number;
  createdAt: number;
  updatedAt: number;
  version: number;
};

type IdempotencyRow = {
  status: number;
  body: unknown;
  expiresAt?: number;
};

type Waiter = {
  cursor: number;
  resolve: (changes: AtomaChange[]) => void;
  timer: ReturnType<typeof setTimeout>;
};

type StoreState = {
  nextCursor: number;
  todos: Map<string, TodoRow>;
  changes: AtomaChange[];
  idempotency: Map<string, IdempotencyRow>;
  waiters: Waiter[];
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

function filterWhere(rows: TodoRow[], where: Record<string, any> | undefined): TodoRow[] {
  if (!where) return rows;
  const entries = Object.entries(where);
  return rows.filter((row) => {
    for (const [key, cond] of entries) {
      const v = (row as any)[key];
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

function getState(): StoreState {
  const anyGlobal = globalThis as any;
  if (!anyGlobal.__ATOMA_DOCS_TODOS__) {
    anyGlobal.__ATOMA_DOCS_TODOS__ = {
      nextCursor: 1,
      todos: new Map<string, TodoRow>(),
      changes: [],
      idempotency: new Map<string, IdempotencyRow>(),
      waiters: [],
    } satisfies StoreState;
  }
  return anyGlobal.__ATOMA_DOCS_TODOS__ as StoreState;
}

function notifyWaiters(state: StoreState) {
  if (!state.waiters.length) return;
  const pending = state.waiters.slice();
  state.waiters = [];

  for (const w of pending) {
    clearTimeout(w.timer);
    const changes = pullChangesFromState(state, w.cursor, 200);
    w.resolve(changes);
  }
}

function appendChangeToState(state: StoreState, change: Omit<AtomaChange, 'cursor'>): AtomaChange {
  const cursor = state.nextCursor++;
  const row: AtomaChange = {
    cursor,
    resource: String(change.resource || ''),
    id: normalizeId(change.id),
    kind: change.kind,
    serverVersion: change.serverVersion,
    changedAt: change.changedAt,
  };
  state.changes.push(row);
  notifyWaiters(state);
  return row;
}

function pullChangesFromState(state: StoreState, cursor: number, limit: number): AtomaChange[] {
  const start = Math.max(0, Math.floor(cursor));
  const max = Math.max(0, Math.floor(limit));
  if (max <= 0) return [];
  const out: AtomaChange[] = [];
  for (const c of state.changes) {
    if (c.cursor > start) out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

function ensureResource(resource: string) {
  if (String(resource || '') === 'todos') return;
  throwError('INVALID_REQUEST', `Unsupported resource: ${resource}`, { kind: 'validation' });
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

export async function getTodosDemoHandlers() {
  const anyGlobal = globalThis as any;
  if (anyGlobal.__ATOMA_DOCS_TODOS_HANDLERS__) {
    return anyGlobal.__ATOMA_DOCS_TODOS_HANDLERS__;
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
      const list = Array.from(state.todos.values());

      const where = isObject(params.where) ? (params.where as any) : undefined;
      const filtered = filterWhere(list, where);

      const orderBy = Array.isArray(params.orderBy)
        ? (params.orderBy as any)
        : params.orderBy
          ? [params.orderBy as any]
          : [{ field: 'id', direction: 'asc' }];

      const sorted = filtered.slice().sort((a, b) => compareByOrderBy(a, b, orderBy));

      const select = isObject(params.select) ? (params.select as any) : undefined;
      const mapRow = (row: TodoRow) => {
        if (!select) return row;
        const out: any = {};
        for (const [k, enabled] of Object.entries(select)) {
          if (enabled) out[k] = (row as any)[k];
        }
        out.id = row.id;
        out.version = row.version;
        return out;
      };

      return { data: sorted.map(mapRow) };
    },
    create: async (resource: string, data: any, _options?: WriteOptions): Promise<QueryResultOne> => {
      ensureResource(resource);
      const id = normalizeId(data?.id);
      if (!id) {
        throwError('INVALID_WRITE', 'Missing id for create', { kind: 'validation', resource: 'todos' });
      }
      if (state.todos.has(id)) {
        throwError('CONFLICT', 'Duplicate id', {
          kind: 'conflict',
          resource: 'todos',
          currentVersion: state.todos.get(id)?.version,
          currentValue: state.todos.get(id),
        });
      }

      const now = Date.now();
      const createdAt = typeof data?.createdAt === 'number' ? data.createdAt : now;
      const updatedAt = typeof data?.updatedAt === 'number' ? data.updatedAt : now;

      const row: TodoRow = {
        ...data,
        id,
        status: String(data?.status ?? 'todo'),
        order: typeof data?.order === 'number' ? data.order : 10,
        createdAt,
        updatedAt,
        version: 1,
      };
      state.todos.set(id, row);
      return { data: row };
    },
    patch: async (
      resource: string,
      item: { id: any; patches: any[]; baseVersion?: number; timestamp?: number },
      _options?: WriteOptions,
    ): Promise<QueryResultOne> => {
      ensureResource(resource);
      const id = normalizeId(item?.id);
      if (!id) throw new Error('patch requires id');

      const base = state.todos.get(id);
      if (!base) {
        throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource: 'todos' });
      }

      const currentVersion = (base as TodoRow).version;
      const baseVersion = item.baseVersion;
      if (typeof baseVersion === 'number' && Number.isFinite(baseVersion) && currentVersion !== baseVersion) {
        throwError('CONFLICT', 'Version conflict', {
          kind: 'conflict',
          resource: 'todos',
          currentVersion,
          currentValue: base,
        });
      }

      const patches = Array.isArray(item.patches) ? item.patches : [];
      const normalized = patches.map((patch: any) => {
        const path = Array.isArray(patch?.path) ? patch.path : [];
        if (!path.length) return patch;
        const [head, ...rest] = path;
        // 宽松比较以兼容字符串/数字 id
        if (head == id) return { ...patch, path: rest };
        return patch;
      });
      const nextRaw = applyPatches(base as any, normalized as any) as any;
      if (!nextRaw || typeof nextRaw !== 'object' || Array.isArray(nextRaw)) {
        throwError('INVALID_WRITE', 'Patch result invalid', { kind: 'validation', resource: 'todos' });
      }

      const updatedAt = typeof item.timestamp === 'number' && Number.isFinite(item.timestamp)
        ? item.timestamp
        : Date.now();

      const next: TodoRow = {
        ...(nextRaw as any),
        id,
        updatedAt,
        version: currentVersion + 1,
      };

      state.todos.set(id, next);
      return { data: next };
    },
    delete: async (resource: string, whereOrId: any, _options?: WriteOptions): Promise<QueryResultOne> => {
      ensureResource(resource);
      const baseVersion = (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId))
        ? (whereOrId as any).baseVersion
        : undefined;
      const id = normalizeId((whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId)) ? (whereOrId as any).id : whereOrId);
      if (!id) throw new Error('delete requires id');

      const current = state.todos.get(id);
      if (!current) {
        throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource: 'todos' });
      }

      if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
        const currentVersion = (current as TodoRow).version;
        if (currentVersion !== baseVersion) {
          throwError('CONFLICT', 'Version conflict', {
            kind: 'conflict',
            resource: 'todos',
            currentVersion,
            currentValue: current,
          });
        }
      }

      state.todos.delete(id);
      return { data: undefined };
    },
  };

  const sync: ISyncAdapter = {
    getIdempotency: async (key: string): Promise<IdempotencyResult> => {
      const row = state.idempotency.get(key);
      if (!row) return { hit: false };
      const expiresAt = row.expiresAt;
      if (typeof expiresAt === 'number' && Number.isFinite(expiresAt) && expiresAt <= Date.now()) {
        state.idempotency.delete(key);
        return { hit: false };
      }
      return { hit: true, status: row.status, body: row.body };
    },
    putIdempotency: async (key: string, value: { status: number; body: unknown }, ttlMs?: number): Promise<void> => {
      const ttl = (typeof ttlMs === 'number' && Number.isFinite(ttlMs) && ttlMs > 0) ? ttlMs : 0;
      const expiresAt = ttl ? Date.now() + ttl : undefined;
      state.idempotency.set(key, { status: value.status, body: value.body, ...(expiresAt ? { expiresAt } : {}) });
    },
    appendChange: async (change: Omit<AtomaChange, 'cursor'>): Promise<AtomaChange> => {
      return appendChangeToState(state, change);
    },
    getLatestCursor: async () => {
      const last = state.changes[state.changes.length - 1];
      return last ? last.cursor : 0;
    },
    pullChanges: async (cursor: number, limit: number) => {
      return pullChangesFromState(state, cursor, limit);
    },
    waitForChanges: async (cursor: number, timeoutMs: number) => {
      const immediate = pullChangesFromState(state, cursor, 200);
      if (immediate.length) return immediate;

      const maxMs = Math.max(0, Math.floor(timeoutMs));
      if (maxMs <= 0) return [];

      return new Promise<AtomaChange[]>((resolve) => {
        const timer = setTimeout(() => {
          state.waiters = state.waiters.filter((w) => w.resolve !== resolve);
          resolve([]);
        }, maxMs);
        state.waiters.push({ cursor, resolve, timer });
      });
    },
  };

  const handlers = createAtomaHandlers({
    meta: { name: 'atoma-docs', env: 'development' },
    adapter: { orm, sync },
    sync: { enabled: true },
  });

  anyGlobal.__ATOMA_DOCS_TODOS_HANDLERS__ = handlers;
  return handlers;
}
