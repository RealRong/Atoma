import { useEffect, useMemo, useState } from 'react';
import { createHttpClient } from 'atoma';
import { useFindMany } from 'atoma/react';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { Callout } from 'fumadocs-ui/components/callout';
import { cn } from 'fumadocs-ui/utils/cn';

type User = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  version?: number;
};

type Post = {
  id: string;
  title: string;
  authorId: string;
  createdAt: number;
  updatedAt: number;
  version?: number;
};

type Comment = {
  id: string;
  postId: string;
  authorId: string;
  body: string;
  createdAt: number;
  updatedAt: number;
  version?: number;
};

type RelationsClient = ReturnType<typeof createRelationsClient>;

function createRelationsClient(_backendKey: string) {
  const client = createHttpClient<{ users: User; posts: Post; comments: Comment }>(
    {
      url: typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
      opsPath: '/api/demos/relations/ops',
    },
    {
      posts: {
        indexes: [
          { field: 'authorId', type: 'string' },
          { field: 'updatedAt', type: 'number' },
        ],
        relations: {
          author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' },
          comments: {
            type: 'hasMany',
            to: 'comments',
            foreignKey: 'postId',
            options: { orderBy: { field: 'createdAt', direction: 'desc' }, limit: 2 },
          },
        },
      },
      comments: {
        indexes: [
          { field: 'postId', type: 'string' },
          { field: 'authorId', type: 'string' },
          { field: 'createdAt', type: 'number' },
        ],
        relations: {
          author: { type: 'belongsTo', to: 'users', foreignKey: 'authorId' },
        },
      },
    },
  );

  return {
    client,
    usersStore: client.Store('users'),
    postsStore: client.Store('posts'),
    commentsStore: client.Store('comments'),
  };
}

export function RelationsProjectionDemo() {
  const [instanceId, setInstanceId] = useState(1);
  const instance: RelationsClient = useMemo(() => {
    return createRelationsClient(`docs:relations:simple:${instanceId}`);
  }, [instanceId]);

  const { postsStore, usersStore, commentsStore } = instance;

  const [includeAuthor, setIncludeAuthor] = useState(true);
  const [includeComments, setIncludeComments] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setError(null);
    void postsStore.findMany!({ orderBy: { field: 'updatedAt', direction: 'desc' }, limit: 20 } as any).catch((e: any) => {
      setError(e?.message || String(e));
    });
  }, [postsStore]);

  const include = useMemo(() => {
    const out: any = {};
    if (includeAuthor) out.author = true;
    if (includeComments) out.comments = true;
    return out;
  }, [includeAuthor, includeComments]);

  const { data: posts, loading, error: hookError, refetch } = useFindMany(postsStore, {
    orderBy: { field: 'updatedAt', direction: 'desc' },
    limit: 20,
    fetchPolicy: 'local',
    include,
  } as any);

  useEffect(() => {
    setError(hookError ? (hookError.message || String(hookError)) : null);
  }, [hookError]);

  const counts = useMemo(() => {
    return {
      users: usersStore.getCachedAll().length,
      posts: postsStore.getCachedAll().length,
      comments: commentsStore.getCachedAll().length,
    };
  }, [usersStore, postsStore, commentsStore, posts]);

  return (
    <div className="not-prose w-full">
      <div className="rounded-lg border bg-fd-background p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="text-sm font-medium">多实体 + Relations 投影</div>
            <div className="flex flex-wrap gap-2">
              <button
                className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                onClick={() => setInstanceId((v) => v + 1)}
                type="button"
              >
                重置本地缓存
              </button>
              <button
                className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                onClick={() => void refetch()}
                type="button"
              >
                Refetch
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-fd-muted-foreground">include</div>
              <div className="mt-2 flex flex-col gap-2 text-sm">
                <label className="flex items-center justify-between gap-2">
                  <span>author</span>
                  <input type="checkbox" checked={includeAuthor} onChange={(e) => setIncludeAuthor(e.target.checked)} />
                </label>
                <label className="flex items-center justify-between gap-2">
                  <span>comments（Top 2）</span>
                  <input type="checkbox" checked={includeComments} onChange={(e) => setIncludeComments(e.target.checked)} />
                </label>
              </div>
              <div className="mt-3 text-xs text-fd-muted-foreground">
                点击开关可以看到投影字段（author/comments）出现或消失。
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="text-xs text-fd-muted-foreground">缓存</div>
              <div className="mt-2 text-sm">
                <div>cache.users：{counts.users}</div>
                <div>cache.posts：{counts.posts}</div>
                <div>cache.comments：{counts.comments}</div>
              </div>
              <div className="mt-3 text-xs text-fd-muted-foreground">状态</div>
              <div className="mt-1 text-sm">loading：{String(loading)}</div>
            </div>

            <div className="rounded-md border p-3">
              <div className="text-xs text-fd-muted-foreground">当前 include</div>
              <pre className="mt-2 overflow-x-auto rounded-md border bg-fd-background p-2 text-xs">
                {JSON.stringify(include, null, 2)}
              </pre>
            </div>
          </div>

          {error ? (
            <Callout type="error" title="执行失败">
              {error}
            </Callout>
          ) : null}
        </div>
      </div>

      <div className="mt-4 rounded-lg border bg-fd-background p-4">
        <div className="text-sm font-medium">Posts（投影结果）</div>
        <div className="mt-3 flex flex-col gap-3">
          {(posts as any[]).map((p) => (
            <div key={p.id} className="rounded-md border p-3">
              <div className="text-sm font-medium">{p.title}</div>
              <div className="mt-1 text-xs text-fd-muted-foreground">id={p.id} authorId={p.authorId}</div>
              {includeAuthor ? (
                <div className="mt-2 text-sm">
                  author：{p.author ? `${p.author.name} (${p.author.id})` : 'null'}
                </div>
              ) : null}
              {includeComments ? (
                <div className="mt-2">
                  <div className="text-xs text-fd-muted-foreground">comments（createdAt desc, limit 2）</div>
                  <div className="mt-1 flex flex-col gap-1">
                    {Array.isArray(p.comments) && p.comments.length ? p.comments.map((c: any) => (
                      <div key={c.id} className="rounded border px-2 py-1 text-sm">
                        <div className="text-xs text-fd-muted-foreground">c.id={c.id} authorId={c.authorId}</div>
                        <div>{c.body}</div>
                      </div>
                    )) : (
                      <div className="text-sm text-fd-muted-foreground">（无）</div>
                    )}
                  </div>
                </div>
              ) : null}
            </div>
          ))}
          {!posts.length ? (
            <div className="text-sm text-fd-muted-foreground">暂无数据</div>
          ) : null}
        </div>
      </div>
    </div>
  );
}
