import { useEffect, useMemo, useState } from 'react';
import { useFindMany } from 'atoma/react';
import { createClient, createOpContext } from 'atoma';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { Callout } from 'fumadocs-ui/components/callout';
import { cn } from 'fumadocs-ui/utils/cn';

type TodoStatus = 'todo' | 'doing' | 'done';

type Todo = {
  id: string;
  title: string;
  status: TodoStatus;
  order: number;
  createdAt: number;
  updatedAt: number;
  version?: number;
};

type TodosClient = ReturnType<typeof createTodosClient>;

function nowMs() {
  return Date.now();
}

function createTodoId() {
  const cryptoAny = globalThis.crypto as any;
  const uuid = cryptoAny?.randomUUID?.();
  if (typeof uuid === 'string' && uuid) return `t_${uuid}`;
  return `t_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function formatStatus(s: TodoStatus): string {
  if (s === 'todo') return 'Todo';
  if (s === 'doing') return 'Doing';
  return 'Done';
}

function createTodosClient(args: {
  onSyncEvent: (event: any) => void;
  onSyncError: (error: Error) => void;
}) {
  const baseUrl = typeof window !== 'undefined' ? window.location.origin : 'http://localhost';

  const { Store, Sync } = createClient<{ todos: Todo }>({
    http: {
      opsPath: '/api/ops',
    },
    store: {
      type: 'http',
      url: baseUrl,
    },
    sync: {
      sse: '/api/subscribe',
      subscribe: true,
      pullDebounceMs: 200,
      pullIntervalMs: 30_000,
      onEvent: args.onSyncEvent,
      onError: (error) => args.onSyncError(error),
    },
  });

  return {
    Store,
    Sync,
    todosStore: Store('todos').Outbox,
  };
}

export function TodosDemo() {
  const [instance, setInstance] = useState<TodosClient | null>(null);
  const [online, setOnline] = useState<boolean>(() => navigator.onLine);
  const [mode, setMode] = useState<'pull-only' | 'pull+subscribe'>('pull+subscribe');
  const [lastEventType, setLastEventType] = useState<string | null>(null);
  const [syncError, setSyncError] = useState<string | null>(null);

  useEffect(() => {
    const onOnline = () => setOnline(true);
    const onOffline = () => setOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  useEffect(() => {
    if (instance) return;

    const nextInstance = createTodosClient({
      onSyncEvent: (event) => {
        setLastEventType(String((event as any)?.type || ''));
      },
      onSyncError: (error) => {
        setSyncError(error.message || String(error));
      },
    });
    setInstance(nextInstance);
    nextInstance.Sync.start('pull+subscribe');
  }, [instance]);

  if (!instance) {
    return (
      <div className="not-prose w-full rounded-lg border bg-fd-background p-4">
        <div className="text-sm text-fd-muted-foreground">初始化中…</div>
      </div>
    );
  }

  return (
    <TodosDemoBoard
      instance={instance}
      online={online}
      mode={mode}
      setMode={setMode}
      lastEventType={lastEventType}
      syncError={syncError}
    />
  );
}

function TodosDemoBoard(props: {
  instance: TodosClient;
  online: boolean;
  mode: 'pull-only' | 'pull+subscribe';
  setMode: (v: 'pull-only' | 'pull+subscribe') => void;
  lastEventType: string | null;
  syncError: string | null;
}) {
  const { Sync, todosStore } = props.instance;
  const [query, setQuery] = useState('');
  const [title, setTitle] = useState('');
  const [opError, setOpError] = useState<string | null>(null);

  const syncStatusText = (() => {
    const s = Sync.status();
    if (!s.configured) return '未配置';
    return s.started ? '运行中' : '已停止';
  })();

  const { data: todos, loading, error } = useFindMany(todosStore, {
    orderBy: [
      { field: 'status', direction: 'asc' },
      { field: 'order', direction: 'asc' },
    ],
    limit: 1000,
  });

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = (todos as Todo[]) ?? [];
    if (!q) return list;
    return list.filter((t) => String(t.title || '').toLowerCase().includes(q));
  }, [todos, query]);

  const byStatus = useMemo(() => {
    const out: Record<TodoStatus, Todo[]> = { todo: [], doing: [], done: [] };
    for (const t of filtered) {
      const s = (t.status || 'todo') as TodoStatus;
      out[s].push(t);
    }
    out.todo.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    out.doing.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    out.done.sort((a, b) => (a.order - b.order) || a.id.localeCompare(b.id));
    return out;
  }, [filtered]);

  const toggleSubscribe = () => {
    const next = props.mode === 'pull+subscribe' ? 'pull-only' : 'pull+subscribe';
    props.setMode(next);
    Sync.stop();
    Sync.start(next);
  };

  const push = async () => {
    await Sync.push();
  };

  const pull = async () => {
    await Sync.pull();
  };

  const startSync = () => {
    Sync.start(props.mode);
  };

  const stopSync = () => {
    Sync.stop();
  };

  const addTodo = async () => {
    const t = title.trim();
    if (!t) return;

    try {
      const opContext = createOpContext({
        scope: 'docs:todos',
        origin: 'user',
        label: '新增 Todo',
      });

      const n = nowMs();
      const existing = await todosStore.findMany!({
        where: { status: 'todo' },
        orderBy: { field: 'order', direction: 'asc' },
        limit: 1000,
      });
      const lastOrder = existing.data[existing.data.length - 1]?.order ?? 0;

      await todosStore.addOne(
        {
          id: createTodoId(),
          title: t,
          status: 'todo',
          order: lastOrder + 10,
          createdAt: n,
          updatedAt: n,
          version: 1,
        },
        { opContext },
      );

      setTitle('');
      setOpError(null);
    } catch (e: any) {
      setOpError(e?.message || String(e));
    }
  };

  const onEdit = async (id: string, nextTitle: string) => {
    const t = nextTitle.trim();
    if (!t) return;

    try {
      const opContext = createOpContext({
        scope: 'docs:todos',
        origin: 'user',
        label: '编辑 Todo',
      });
      const n = nowMs();
      await todosStore.updateOne(
        id,
        (draft: any) => {
          draft.title = t;
          draft.updatedAt = n;
        },
        { opContext },
      );
      setOpError(null);
    } catch (e: any) {
      setOpError(e?.message || String(e));
    }
  };

  const onDelete = async (id: string) => {
    try {
      const opContext = createOpContext({
        scope: 'docs:todos',
        origin: 'user',
        label: '删除 Todo',
      });
      await todosStore.deleteOneById(id, { force: true, opContext } as any);
      setOpError(null);
    } catch (e: any) {
      setOpError(e?.message || String(e));
    }
  };

  const onMove = async (id: string, toStatus: TodoStatus, beforeId?: string) => {
    try {
      const opContext = createOpContext({
        scope: 'docs:todos',
        origin: 'user',
        label: '移动 Todo',
      });

      const all = await todosStore.findMany!({
        orderBy: [
          { field: 'status', direction: 'asc' },
          { field: 'order', direction: 'asc' },
        ],
        limit: 1000,
      });
      const allTodos = all.data as Todo[];
      const byId = new Map<string, Todo>(allTodos.map((t) => [t.id, t]));
      const moving = byId.get(id);
      if (!moving) return;

      const fromStatus = moving.status;

      const fromList = allTodos.filter((t) => t.status === fromStatus && t.id !== id);
      const toList = allTodos.filter((t) => t.status === toStatus && t.id !== id);

      const insertIndex = (() => {
        if (!beforeId) return toList.length;
        const idx = toList.findIndex((t) => t.id === beforeId);
        return idx >= 0 ? idx : toList.length;
      })();

      toList.splice(insertIndex, 0, { ...moving, status: toStatus });

      const reassignOrders = (list: Todo[]) => {
        let order = 10;
        return list.map((t) => {
          const next = { ...t, order };
          order += 10;
          return next;
        });
      };

      const nextFrom = reassignOrders(fromList);
      const nextTo = reassignOrders(toList);

      const updates: Todo[] = [];
      nextFrom.forEach((t) => updates.push(t));
      nextTo.forEach((t) => updates.push(t));

      for (const u of updates) {
        await todosStore.updateOne(
          u.id,
          (draft: any) => {
            draft.status = u.status;
            draft.order = u.order;
            draft.updatedAt = nowMs();
          },
          { opContext },
        );
      }

      setOpError(null);
    } catch (e: any) {
      setOpError(e?.message || String(e));
    }
  };

  return (
    <div className="not-prose w-full">
      <div className="flex flex-col gap-3 rounded-lg border bg-fd-background p-4">
        <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
          <div className="flex flex-wrap items-center gap-2">
            <div className="text-sm font-medium">状态：</div>
            <div className="text-sm text-fd-muted-foreground">Sync {syncStatusText}</div>
            <div className="text-sm text-fd-muted-foreground">Subscribe {props.mode === 'pull+subscribe' ? '开' : '关'}</div>
            <div className="text-sm text-fd-muted-foreground">{props.online ? 'Online' : 'Offline'}</div>
          </div>

          <div className="flex flex-wrap gap-2">
            <button
              className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
              onClick={toggleSubscribe}
              type="button"
            >
              {props.mode === 'pull+subscribe' ? '关闭 Subscribe' : '开启 Subscribe'}
            </button>
            <button
              className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
              onClick={startSync}
              type="button"
            >
              Start
            </button>
            <button
              className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
              onClick={stopSync}
              type="button"
            >
              Stop
            </button>
            <button
              className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
              onClick={() => void push()}
              type="button"
            >
              Push
            </button>
            <button
              className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
              onClick={() => void pull()}
              type="button"
            >
              Pull
            </button>
          </div>
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input
            className="w-full rounded-md border bg-fd-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-fd-ring md:max-w-md"
            placeholder="搜索标题…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
          />
          <div className="flex-1" />
          <div className="text-xs text-fd-muted-foreground">
            {props.lastEventType ? `事件：${props.lastEventType}` : ''}
            {error ? ` · Load failed: ${error.message}` : ''}
          </div>
        </div>

        <div className="flex flex-col gap-2 md:flex-row md:items-center">
          <input
            className="w-full rounded-md border bg-fd-background px-3 py-2 text-sm outline-none focus:ring-2 focus:ring-fd-ring md:max-w-md"
            placeholder="输入 todo 标题（回车新增）"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                void addTodo();
              }
            }}
          />
          <button
            className={cn(buttonVariants({ color: 'primary', size: 'sm' }))}
            onClick={() => void addTodo()}
            disabled={!title.trim()}
            type="button"
          >
            新增
          </button>
          <div className="text-xs text-fd-muted-foreground">
            {loading ? 'Loading…' : `共 ${((todos as Todo[]) ?? []).length} 条`}
          </div>
        </div>

        {props.syncError ? (
          <Callout type="error" title="Sync 错误">
            {props.syncError}
          </Callout>
        ) : null}
        {opError ? (
          <Callout type="error" title="操作错误">
            {opError}
          </Callout>
        ) : null}
      </div>

      <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-3">
        {(['todo', 'doing', 'done'] as TodoStatus[]).map((status) => (
          <Column
            key={status}
            status={status}
            items={byStatus[status]}
            onMove={onMove}
            onEdit={onEdit}
            onDelete={onDelete}
          />
        ))}
      </div>
    </div>
  );
}

function Column(props: {
  status: TodoStatus;
  items: Todo[];
  onMove: (id: string, to: TodoStatus, beforeId?: string) => Promise<void>;
  onEdit: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { status, items } = props;

  const onDropToColumn = async (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const id = String(parsed?.id || '');
    if (!id) return;
    await props.onMove(id, status);
  };

  return (
    <div
      className="rounded-lg border bg-fd-background"
      onDragOver={(e) => e.preventDefault()}
      onDrop={onDropToColumn}
    >
      <div className="flex items-center justify-between border-b px-3 py-2">
        <div className="text-sm font-medium">{formatStatus(status)}</div>
        <div className="text-xs text-fd-muted-foreground">{items.length}</div>
      </div>
      <div className="flex flex-col gap-2 p-3">
        {items.map((item) => (
          <CardRow
            key={item.id}
            item={item}
            onMove={(id, beforeId) => props.onMove(id, status, beforeId)}
            onEdit={props.onEdit}
            onDelete={props.onDelete}
          />
        ))}
        {!items.length ? (
          <div className="text-xs text-fd-muted-foreground">拖拽到此列</div>
        ) : null}
      </div>
    </div>
  );
}

function CardRow(props: {
  item: Todo;
  onMove: (id: string, beforeId?: string) => Promise<void>;
  onEdit: (id: string, title: string) => Promise<void>;
  onDelete: (id: string) => Promise<void>;
}) {
  const { item } = props;
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(item.title);

  useEffect(() => {
    if (!editing) setTitle(item.title);
  }, [item.title, editing]);

  const onDragStart = (e: React.DragEvent) => {
    e.dataTransfer.setData('application/json', JSON.stringify({ id: item.id }));
    e.dataTransfer.effectAllowed = 'move';
  };

  const onDropBefore = async (e: React.DragEvent) => {
    e.preventDefault();
    const raw = e.dataTransfer.getData('application/json');
    if (!raw) return;
    const parsed = JSON.parse(raw);
    const id = String(parsed?.id || '');
    if (!id) return;
    if (id === item.id) return;
    await props.onMove(id, item.id);
  };

  return (
    <div className="rounded-md border bg-fd-card">
      <div
        className="px-3 py-2"
        draggable
        onDragStart={onDragStart}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDropBefore}
      >
        {editing ? (
          <div className="flex items-center gap-2">
            <input
              className="w-full rounded-md border bg-fd-background px-2 py-1 text-sm outline-none focus:ring-2 focus:ring-fd-ring"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') {
                  e.preventDefault();
                  setEditing(false);
                  void props.onEdit(item.id, title);
                }
                if (e.key === 'Escape') {
                  e.preventDefault();
                  setEditing(false);
                  setTitle(item.title);
                }
              }}
              autoFocus
            />
            <button
              className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
              onClick={() => {
                setEditing(false);
                void props.onEdit(item.id, title);
              }}
              type="button"
            >
              保存
            </button>
          </div>
        ) : (
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <div className="text-sm font-medium break-words">{item.title}</div>
              <div className="text-xs text-fd-muted-foreground">
                #{item.id.slice(0, 6)} · v{item.version ?? '-'}
              </div>
            </div>
            <div className="flex items-center gap-1">
              <button
                className={cn(buttonVariants({ color: 'ghost', size: 'icon-xs' }))}
                onClick={() => setEditing(true)}
                type="button"
                title="编辑"
              >
                ✎
              </button>
              <button
                className={cn(buttonVariants({ color: 'ghost', size: 'icon-xs' }))}
                onClick={() => void props.onDelete(item.id)}
                type="button"
                title="删除"
              >
                ×
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
