import { applyPatches } from 'immer';
import { createAtomaHandlers, throwError } from 'atoma/server';
import type { IOrmAdapter, OrderByRule, QueryParams, QueryResult, QueryResultOne, WriteOptions } from 'atoma/server';

type UserRow = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  version: number;
};

type PostRow = {
  id: string;
  title: string;
  authorId: string;
  createdAt: number;
  updatedAt: number;
  version: number;
};

type CommentRow = {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  version: number;
};

type StoreState = {
  users: Map<string, UserRow>;
  posts: Map<string, PostRow>;
  comments: Map<string, CommentRow>;
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

function getState(): StoreState {
  const anyGlobal = globalThis as any;
  if (!anyGlobal.__ATOMA_DOCS_RELATIONS__) {
    const now = Date.now();
    const users = new Map<string, UserRow>();
    users.set('u_1', { id: 'u_1', name: '王宇', createdAt: now - 14 * 86_400_000, updatedAt: now - 14 * 86_400_000, version: 1 });
    users.set('u_2', { id: 'u_2', name: '李晴', createdAt: now - 12 * 86_400_000, updatedAt: now - 12 * 86_400_000, version: 1 });
    users.set('u_3', { id: 'u_3', name: '陈昊', createdAt: now - 11 * 86_400_000, updatedAt: now - 11 * 86_400_000, version: 1 });
    users.set('u_4', { id: 'u_4', name: '周一凡', createdAt: now - 9 * 86_400_000, updatedAt: now - 9 * 86_400_000, version: 1 });
    users.set('u_5', { id: 'u_5', name: '赵可', createdAt: now - 8 * 86_400_000, updatedAt: now - 8 * 86_400_000, version: 1 });

    const posts = new Map<string, PostRow>();
    posts.set('p_1', { id: 'p_1', title: '周报：移动端列表渲染优化', authorId: 'u_2', createdAt: now - 6 * 86_400_000, updatedAt: now - 2 * 86_400_000, version: 1 });
    posts.set('p_2', { id: 'p_2', title: '需求评审：通知通道与一致性边界', authorId: 'u_1', createdAt: now - 5 * 86_400_000, updatedAt: now - 5 * 86_400_000, version: 1 });
    posts.set('p_3', { id: 'p_3', title: 'Bugfix：评论排序偶发错乱', authorId: 'u_4', createdAt: now - 4 * 86_400_000, updatedAt: now - 4 * 86_400_000 + 9_000, version: 1 });
    posts.set('p_4', { id: 'p_4', title: '复盘：一次发布导致的脏读', authorId: 'u_3', createdAt: now - 3 * 86_400_000, updatedAt: now - 3 * 86_400_000 + 18_000, version: 1 });
    posts.set('p_5', { id: 'p_5', title: '讨论：多实体 include 的 UI 设计', authorId: 'u_5', createdAt: now - 2 * 86_400_000, updatedAt: now - 2 * 86_400_000 + 25_000, version: 1 });

    const comments = new Map<string, CommentRow>();
    let seq = 1;
    const seed = (postId: string, authorId: string, body: string, deltaMs: number) => {
      const t = now - deltaMs;
      const id = `c_${seq++}`;
      comments.set(id, { id, postId, authorId, body, createdAt: t, updatedAt: t, version: 1 });
    };

    seed('p_1', 'u_4', '列表页首屏白屏时间下降明显，建议把 skeleton 保留。', 1 * 86_400_000 + 12_000);
    seed('p_1', 'u_2', '我把虚拟列表的 overscan 调小了，滚动更稳。', 1 * 86_400_000 + 9_000);
    seed('p_1', 'u_3', '注意 include 关系时的预取请求数，最好能合批。', 1 * 86_400_000 + 8_000);

    seed('p_2', 'u_1', '通知通道不保证送达，数据一致性只靠 pull。', 2 * 86_400_000 + 20_000);
    seed('p_2', 'u_5', '那前端就要做 debounce + in-flight 合并，不然会抖。', 2 * 86_400_000 + 16_000);

    seed('p_3', 'u_4', 'createdAt 相同时要有稳定排序，不然 Top-N 会跳。', 3 * 86_400_000 + 33_000);
    seed('p_3', 'u_2', '同意，最好用 id 作为 tie-break。', 3 * 86_400_000 + 30_000);
    seed('p_3', 'u_1', '回头补个测试用例，覆盖同 timestamp 的场景。', 3 * 86_400_000 + 28_000);

    seed('p_4', 'u_3', '当 fetchPolicy=local-then-remote 时，UI 要避免闪回旧快照。', 4 * 86_400_000 + 11_000);

    seed('p_5', 'u_5', 'include 关掉时就只渲染 posts 基本字段，体验更快。', 5 * 86_400_000 + 15_000);
    seed('p_5', 'u_2', 'comments 只展示 Top-2，点进去再分页加载。', 5 * 86_400_000 + 12_000);

    anyGlobal.__ATOMA_DOCS_RELATIONS__ = { users, posts, comments } satisfies StoreState;
  }
  return anyGlobal.__ATOMA_DOCS_RELATIONS__ as StoreState;
}

function ensureResource(resource: string) {
  const r = String(resource || '');
  if (r === 'users' || r === 'posts' || r === 'comments') return;
  throwError('INVALID_REQUEST', `Unsupported resource: ${resource}`, { kind: 'validation' });
}

function getMap(state: StoreState, resource: string): Map<string, any> {
  if (resource === 'users') return state.users;
  if (resource === 'posts') return state.posts;
  return state.comments;
}

function filterWhere(rows: any[], where: Record<string, any> | undefined): any[] {
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
      if (isObject(cond) && typeof (cond as any).eq !== 'undefined') {
        if (normalizeId((cond as any).eq) !== normalizeId(v)) return false;
        continue;
      }
      if (isObject(cond) && typeof (cond as any).contains !== 'undefined') {
        const needle = String((cond as any).contains ?? '');
        const hay = String(v ?? '');
        if (!hay.includes(needle)) return false;
        continue;
      }
      if (normalizeId(cond) !== normalizeId(v)) return false;
    }
    return true;
  });
}

function applySelect(row: any, select: Record<string, boolean> | undefined) {
  if (!select) return row;
  const out: any = {};
  for (const [k, enabled] of Object.entries(select)) {
    if (enabled) out[k] = row?.[k];
  }
  out.id = row?.id;
  out.version = row?.version;
  return out;
}

function applyOffsetPaging<T>(rows: T[], page: any) {
  const limit = typeof page?.limit === 'number' && Number.isFinite(page.limit) ? Math.max(0, Math.floor(page.limit)) : 50;
  const offset = typeof page?.offset === 'number' && Number.isFinite(page.offset) ? Math.max(0, Math.floor(page.offset)) : 0;
  return rows.slice(offset, offset + limit);
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

function normalizePatchesForId(id: string, patches: any[]) {
  const list = Array.isArray(patches) ? patches : [];
  return list.map((patch: any) => {
    const path = Array.isArray(patch?.path) ? patch.path : [];
    if (!path.length) return patch;
    const [head, ...rest] = path;
    if (head == id) return { ...patch, path: rest };
    return patch;
  });
}

export async function getRelationsDemoHandlers() {
  const anyGlobal = globalThis as any;
  if (anyGlobal.__ATOMA_DOCS_RELATIONS_HANDLERS__) {
    return anyGlobal.__ATOMA_DOCS_RELATIONS_HANDLERS__;
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
      const map = getMap(state, resource);
      const list = Array.from(map.values());

      const where = isObject(params.where) ? (params.where as any) : undefined;
      const filtered = filterWhere(list, where);

      const orderBy = Array.isArray(params.orderBy)
        ? (params.orderBy as any)
        : params.orderBy
          ? [params.orderBy as any]
          : [{ field: 'updatedAt', direction: 'desc' }];

      const sorted = filtered.slice().sort((a, b) => compareByOrderBy(a, b, orderBy));
      const page = isObject(params.page) ? (params.page as any) : { mode: 'offset', limit: 50 };

      const data = page?.mode === 'offset' ? applyOffsetPaging(sorted, page) : sorted;
      const select = isObject(params.select) ? (params.select as any) : undefined;

      const includeTotal = page?.mode === 'offset' ? (page?.includeTotal !== false) : false;
      const pageInfo = includeTotal ? { total: sorted.length } : undefined;

      return { data: data.map((row) => applySelect(row, select)), ...(pageInfo ? { pageInfo } : {}) };
    },
    create: async (resource: string, data: any, _options?: WriteOptions): Promise<QueryResultOne> => {
      ensureResource(resource);
      const map = getMap(state, resource);
      const id = normalizeId(data?.id);
      if (!id) throwError('INVALID_WRITE', 'Missing id for create', { kind: 'validation', resource });
      if (map.has(id)) {
        throwError('CONFLICT', 'Duplicate id', { kind: 'conflict', resource, currentValue: map.get(id) });
      }

      const now = Date.now();
      const createdAt = typeof data?.createdAt === 'number' ? data.createdAt : now;
      const updatedAt = typeof data?.updatedAt === 'number' ? data.updatedAt : now;

      const row = { ...data, id, createdAt, updatedAt, version: 1 };
      map.set(id, row);
      return { data: row };
    },
    patch: async (
      resource: string,
      item: { id: any; patches: any[]; baseVersion?: number; timestamp?: number },
      _options?: WriteOptions,
    ): Promise<QueryResultOne> => {
      ensureResource(resource);
      const map = getMap(state, resource);
      const id = normalizeId(item?.id);
      if (!id) throw new Error('patch requires id');

      const base = map.get(id);
      if (!base) {
        throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource });
      }

      const currentVersion = (base as any).version;
      const baseVersion = item.baseVersion;
      if (typeof baseVersion === 'number' && Number.isFinite(baseVersion) && currentVersion !== baseVersion) {
        throwError('CONFLICT', 'Version conflict', { kind: 'conflict', resource, currentVersion, currentValue: base });
      }

      const normalized = normalizePatchesForId(id, item.patches);
      const nextRaw = applyPatches(base as any, normalized as any) as any;
      if (!nextRaw || typeof nextRaw !== 'object' || Array.isArray(nextRaw)) {
        throwError('INVALID_WRITE', 'Patch result invalid', { kind: 'validation', resource });
      }

      const updatedAt = typeof item.timestamp === 'number' && Number.isFinite(item.timestamp) ? item.timestamp : Date.now();
      const next = { ...(nextRaw as any), id, updatedAt, version: currentVersion + 1 };
      map.set(id, next);
      return { data: next };
    },
    delete: async (resource: string, whereOrId: any, _options?: WriteOptions): Promise<QueryResultOne> => {
      ensureResource(resource);
      const map = getMap(state, resource);
      const baseVersion = (whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId)) ? (whereOrId as any).baseVersion : undefined;
      const id = normalizeId((whereOrId && typeof whereOrId === 'object' && !Array.isArray(whereOrId)) ? (whereOrId as any).id : whereOrId);
      if (!id) throw new Error('delete requires id');

      const current = map.get(id);
      if (!current) {
        throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource });
      }

      if (typeof baseVersion === 'number' && Number.isFinite(baseVersion)) {
        const currentVersion = (current as any).version;
        if (currentVersion !== baseVersion) {
          throwError('CONFLICT', 'Version conflict', { kind: 'conflict', resource, currentVersion, currentValue: current });
        }
      }

      map.delete(id);
      return { data: undefined };
    },
  };

  const handlers = createAtomaHandlers({
    adapter: { orm },
    sync: { enabled: false },
  });

  anyGlobal.__ATOMA_DOCS_RELATIONS_HANDLERS__ = handlers;
  return handlers;
}
