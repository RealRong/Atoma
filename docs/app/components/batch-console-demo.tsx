import { useEffect, useMemo, useRef, useState } from 'react';
import { defineEntities } from 'atoma';
import { buttonVariants } from 'fumadocs-ui/components/ui/button';
import { Callout } from 'fumadocs-ui/components/callout';
import { cn } from 'fumadocs-ui/utils/cn';

type Item = {
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
  version?: number;
};

type BatchMode = 'on' | 'off';

type ReqStat = {
  id: string;
  atMs: number;
  opsCount: number;
  queryOps: number;
  writeOps: number;
  bytes: number;
  durationMs?: number;
  ok?: boolean;
};

function nowMs() {
  return Date.now();
}

function createId(prefix: string) {
  const cryptoAny = globalThis.crypto as any;
  const uuid = cryptoAny?.randomUUID?.();
  if (typeof uuid === 'string' && uuid) return `${prefix}_${uuid}`;
  return `${prefix}_${Date.now().toString(36)}_${Math.random().toString(16).slice(2)}`;
}

function tryParseOpsCount(bodyText: string): { opsCount: number; queryOps: number; writeOps: number } {
  try {
    const json = JSON.parse(bodyText);
    const ops = Array.isArray(json?.ops) ? json.ops : [];
    let queryOps = 0;
    let writeOps = 0;
    for (const op of ops) {
      const k = String(op?.kind || '');
      if (k === 'query') queryOps += 1;
      else if (k === 'write') writeOps += 1;
    }
    return { opsCount: ops.length, queryOps, writeOps };
  } catch {
    return { opsCount: 0, queryOps: 0, writeOps: 0 };
  }
}

export function BatchConsoleDemo() {
  const [batchMode, setBatchMode] = useState<BatchMode>('on');
  const [flushIntervalMs, setFlushIntervalMs] = useState(0);
  const [maxBatchSize, setMaxBatchSize] = useState<number | ''>('');
  const [queryCount, setQueryCount] = useState(20);
  const [writeCount, setWriteCount] = useState(10);

  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ReqStat[]>([]);

  const startsAtByRequest = useRef(new WeakMap<Request, number>());
  const statIdByRequest = useRef(new WeakMap<Request, string>());
  const runIdRef = useRef(0);

  const client = useMemo(() => {
    const runId = runIdRef.current + 1;
    runIdRef.current = runId;

    const startedAt = startsAtByRequest.current;
    const statIdByReq = statIdByRequest.current;

    const client = defineEntities<{ items: Item }>()
      .defineStores({})
      .defineClient({
        backend: {
          key: `docs:batch:${runId}`,
          http: {
            baseURL: typeof window !== 'undefined' ? window.location.origin : 'http://localhost',
            opsPath: '/api/demos/batch/ops',
            onRequest: async (request) => {
              try {
                startedAt.set(request, nowMs());
                const cloned = request.clone();
                const text = await cloned.text();
                const counts = tryParseOpsCount(text);
                const bytes = text.length;
                const id = createId('req');
                statIdByReq.set(request, id);
                setStats((prev) => [
                  ...prev,
                  {
                    id,
                    atMs: nowMs(),
                    bytes,
                    opsCount: counts.opsCount,
                    queryOps: counts.queryOps,
                    writeOps: counts.writeOps,
                  },
                ]);
              } catch {
                // ignore
              }
              return request;
            },
            onResponse: (ctx) => {
              try {
                const started = startedAt.get(ctx.request);
                const durationMs = typeof started === 'number' ? nowMs() - started : undefined;
                const ok = Boolean((ctx.envelope as any)?.ok);
                const statId = statIdByReq.get(ctx.request);
                setStats((prev) => {
                  if (!statId) return prev;
                  const idx = prev.findIndex((s) => s.id === statId);
                  if (idx < 0) return prev;
                  const next = prev.slice();
                  next[idx] = { ...next[idx], durationMs, ok };
                  return next;
                });
              } catch {
                // ignore
              }
            },
          },
        },
        remote: {
          batch: batchMode === 'on'
            ? {
              enabled: true,
              flushIntervalMs,
              ...(typeof maxBatchSize === 'number' ? { maxBatchSize } : {}),
              devWarnings: false,
            }
            : false,
        },
        sync: false,
      });

    return client;
  }, [batchMode, flushIntervalMs, maxBatchSize]);

  const store = client.Store('items');

  useEffect(() => {
    setStats([]);
    setError(null);
  }, [client]);

  const summary = useMemo(() => {
    const totalRequests = stats.length;
    const totalOps = stats.reduce((sum, s) => sum + (s.opsCount || 0), 0);
    const totalBytes = stats.reduce((sum, s) => sum + (s.bytes || 0), 0);
    const totalQueryOps = stats.reduce((sum, s) => sum + (s.queryOps || 0), 0);
    const totalWriteOps = stats.reduce((sum, s) => sum + (s.writeOps || 0), 0);
    const avgOpsPerReq = totalRequests ? (totalOps / totalRequests) : 0;
    const durations = stats.map(s => s.durationMs).filter((v): v is number => typeof v === 'number' && Number.isFinite(v));
    durations.sort((a, b) => a - b);
    const p = (q: number) => {
      if (!durations.length) return undefined;
      const idx = Math.min(durations.length - 1, Math.max(0, Math.floor((durations.length - 1) * q)));
      return durations[idx];
    };
    return {
      totalRequests,
      totalOps,
      totalBytes,
      totalQueryOps,
      totalWriteOps,
      avgOpsPerReq,
      p50: p(0.5),
      p95: p(0.95),
    };
  }, [stats]);

  const clear = () => {
    setStats([]);
    setError(null);
  };

  const runQueries = async () => {
    setRunning(true);
    setError(null);
    try {
      const n = Math.max(1, Math.floor(queryCount));
      const promises: Array<Promise<any>> = [];
      for (let i = 0; i < n; i++) {
        const bucket = String(i % 5);
        promises.push(
          store.findMany!({
            where: { title: { contains: `seed_${bucket}` } } as any,
            orderBy: { field: 'updatedAt', direction: 'desc' },
            limit: 10,
          } as any),
        );
      }
      await Promise.all(promises);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const runWrites = async () => {
    setRunning(true);
    setError(null);
    try {
      const n = Math.max(1, Math.floor(writeCount));
      const promises: Array<Promise<any>> = [];
      for (let i = 0; i < n; i++) {
        const t = nowMs();
        promises.push(
          store.addOne(
            {
              id: createId('i'),
              title: `write_${t}_${i}`,
              createdAt: t,
              updatedAt: t,
              version: 1,
            },
            {},
          ) as any,
        );
      }
      await Promise.all(promises);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  const runMixed = async () => {
    setRunning(true);
    setError(null);
    try {
      const q = Math.max(1, Math.floor(queryCount));
      const w = Math.max(1, Math.floor(writeCount));
      const promises: Array<Promise<any>> = [];
      for (let i = 0; i < q; i++) {
        const bucket = String(i % 5);
        promises.push(
          store.findMany!({
            where: { title: { contains: `seed_${bucket}` } } as any,
            orderBy: { field: 'updatedAt', direction: 'desc' },
            limit: 10,
          } as any),
        );
      }
      for (let i = 0; i < w; i++) {
        const t = nowMs();
        promises.push(
          store.addOne(
            {
              id: createId('i'),
              title: `write_${t}_${i}`,
              createdAt: t,
              updatedAt: t,
              version: 1,
            },
            {},
          ) as any,
        );
      }
      await Promise.all(promises);
    } catch (e: any) {
      setError(e?.message || String(e));
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="not-prose w-full">
      <div className="rounded-lg border bg-fd-background p-4">
        <div className="flex flex-col gap-3">
          <div className="flex flex-col gap-2 md:flex-row md:items-center md:justify-between">
            <div className="text-sm font-medium">Batch 控制台</div>
            <div className="flex flex-wrap gap-2">
              <button
                className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                onClick={clear}
                type="button"
              >
                清空指标
              </button>
            </div>
          </div>

          <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
            <div className="rounded-md border p-3">
              <div className="text-xs text-fd-muted-foreground">Batch</div>
              <div className="mt-2 flex gap-2">
                <button
                  className={cn(buttonVariants({ color: batchMode === 'on' ? 'primary' : 'outline', size: 'sm' }))}
                  onClick={() => setBatchMode('on')}
                  disabled={running}
                  type="button"
                >
                  开
                </button>
                <button
                  className={cn(buttonVariants({ color: batchMode === 'off' ? 'primary' : 'outline', size: 'sm' }))}
                  onClick={() => setBatchMode('off')}
                  disabled={running}
                  type="button"
                >
                  关
                </button>
              </div>
              <div className="mt-3 text-xs text-fd-muted-foreground">flushIntervalMs</div>
              <select
                className="mt-1 w-full rounded-md border bg-fd-background px-2 py-1 text-sm"
                value={String(flushIntervalMs)}
                onChange={(e) => setFlushIntervalMs(Number(e.target.value))}
                disabled={running || batchMode === 'off'}
              >
                <option value="0">0（同 tick 合并）</option>
                <option value="10">10</option>
                <option value="50">50</option>
                <option value="200">200</option>
              </select>
              <div className="mt-3 text-xs text-fd-muted-foreground">maxBatchSize（写 op items 上限）</div>
              <select
                className="mt-1 w-full rounded-md border bg-fd-background px-2 py-1 text-sm"
                value={maxBatchSize === '' ? '' : String(maxBatchSize)}
                onChange={(e) => {
                  const v = e.target.value;
                  if (!v) setMaxBatchSize('');
                  else setMaxBatchSize(Number(v));
                }}
                disabled={running || batchMode === 'off'}
              >
                <option value="">不限制</option>
                <option value="10">10</option>
                <option value="50">50</option>
                <option value="200">200</option>
              </select>
            </div>

            <div className="rounded-md border p-3">
              <div className="text-xs text-fd-muted-foreground">压测规模</div>
              <div className="mt-2 grid grid-cols-2 gap-2">
                <label className="text-xs text-fd-muted-foreground">
                  Query 数
                  <input
                    className="mt-1 w-full rounded-md border bg-fd-background px-2 py-1 text-sm"
                    type="number"
                    min={1}
                    value={queryCount}
                    onChange={(e) => setQueryCount(Number(e.target.value))}
                    disabled={running}
                  />
                </label>
                <label className="text-xs text-fd-muted-foreground">
                  Write 数
                  <input
                    className="mt-1 w-full rounded-md border bg-fd-background px-2 py-1 text-sm"
                    type="number"
                    min={1}
                    value={writeCount}
                    onChange={(e) => setWriteCount(Number(e.target.value))}
                    disabled={running}
                  />
                </label>
              </div>
              <div className="mt-3 flex flex-wrap gap-2">
                <button
                  className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                  onClick={() => void runQueries()}
                  disabled={running}
                  type="button"
                >
                  Run Queries
                </button>
                <button
                  className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                  onClick={() => void runWrites()}
                  disabled={running}
                  type="button"
                >
                  Run Writes
                </button>
                <button
                  className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                  onClick={() => void runMixed()}
                  disabled={running}
                  type="button"
                >
                  Run Mixed
                </button>
              </div>
              <div className="mt-2 text-xs text-fd-muted-foreground">
                说明：这些操作会在同一轮 microtask 内并发触发；Batch 开启时应明显减少请求数。
              </div>
            </div>

            <div className="rounded-md border p-3">
              <div className="text-xs text-fd-muted-foreground">指标</div>
              <div className="mt-2 text-sm">
                <div>requests.count：{summary.totalRequests}</div>
                <div>ops.count：{summary.totalOps}</div>
                <div>ops.avgPerReq：{summary.avgOpsPerReq.toFixed(2)}</div>
                <div>ops.query：{summary.totalQueryOps}</div>
                <div>ops.write：{summary.totalWriteOps}</div>
                <div>payload.bytes：{summary.totalBytes}</div>
                <div>latency.p50：{summary.p50 ?? '-'}</div>
                <div>latency.p95：{summary.p95 ?? '-'}</div>
              </div>
            </div>
          </div>

          {error ? (
            <Callout type="error" title="执行失败">
              {error}
            </Callout>
          ) : null}
        </div>
      </div>

      <div className="mt-4 overflow-x-auto rounded-lg border">
        <table className="w-full text-sm">
          <thead className="bg-fd-muted/30">
            <tr>
              <th className="px-3 py-2 text-left">#</th>
              <th className="px-3 py-2 text-left">ops</th>
              <th className="px-3 py-2 text-left">query</th>
              <th className="px-3 py-2 text-left">write</th>
              <th className="px-3 py-2 text-left">bytes</th>
              <th className="px-3 py-2 text-left">ms</th>
              <th className="px-3 py-2 text-left">ok</th>
            </tr>
          </thead>
          <tbody>
            {stats.map((s, idx) => (
              <tr key={s.id} className={idx % 2 ? 'bg-transparent' : 'bg-fd-muted/10'}>
                <td className="px-3 py-2">{idx + 1}</td>
                <td className="px-3 py-2">{s.opsCount}</td>
                <td className="px-3 py-2">{s.queryOps}</td>
                <td className="px-3 py-2">{s.writeOps}</td>
                <td className="px-3 py-2">{s.bytes}</td>
                <td className="px-3 py-2">{typeof s.durationMs === 'number' ? s.durationMs : '-'}</td>
                <td className="px-3 py-2">{s.ok === undefined ? '-' : s.ok ? 'true' : 'false'}</td>
              </tr>
            ))}
            {!stats.length ? (
              <tr>
                <td className="px-3 py-6 text-fd-muted-foreground" colSpan={7}>
                  还没有请求记录。点击 Run 按钮开始。
                </td>
              </tr>
            ) : null}
          </tbody>
        </table>
      </div>
    </div>
  );
}
