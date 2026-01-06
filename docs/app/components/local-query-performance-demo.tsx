import { useEffect, useMemo, useRef, useState } from 'react'
import { createClient } from 'atoma'
import { useFindMany } from 'atoma/react'
import { buttonVariants } from 'fumadocs-ui/components/ui/button'
import { Callout } from 'fumadocs-ui/components/callout'
import { cn } from 'fumadocs-ui/utils/cn'
import { faker } from '@faker-js/faker'

type Book = {
    id: string
    title: string
    author: string
    genre: string
    createdAt: number
    updatedAt: number
}

type Sample = {
    ms: number
    at: number
}

function now() {
    return Date.now()
}

function clampInt(value: number, min: number, max: number) {
    if (!Number.isFinite(value)) return min
    return Math.max(min, Math.min(max, Math.floor(value)))
}

function percentile(samples: Sample[], q: number): number | undefined {
    if (!samples.length) return undefined
    const sorted = samples.map(s => s.ms).slice().sort((a, b) => a - b)
    const idx = clampInt((sorted.length - 1) * q, 0, sorted.length - 1)
    return sorted[idx]
}

function generateBooks(count: number, seed: number): Book[] {
    faker.seed(seed)

    const nowMs = now()
    const minUpdatedAt = nowMs - 30 * 24 * 60 * 60 * 1000

    const out: Book[] = new Array(count)
    for (let i = 0; i < count; i++) {
        const id = `b_${seed.toString(16)}_${i.toString(36)}_${faker.string.alphanumeric(6).toLowerCase()}`

        const updatedAt = faker.number.int({ min: minUpdatedAt, max: nowMs })
        const createdAt = faker.number.int({ min: minUpdatedAt, max: updatedAt })

        const title = faker.book.title()
        const author = faker.book.author()
        const genre = faker.book.genre()

        out[i] = {
            id,
            title,
            author,
            genre,
            createdAt,
            updatedAt
        }
    }

    return out
}

export function LocalQueryPerformanceDemo() {
    const [seed, setSeed] = useState(1)
    const [dataset, setDataset] = useState<Book[] | null>(null)
    const datasetRef = useRef<Book[] | null>(null)
    const [loadingDataset, setLoadingDataset] = useState(false)
    const [seedError, setSeedError] = useState<string | null>(null)
    const [lastSeedMs, setLastSeedMs] = useState<number | null>(null)
    const [lastGenerateMs, setLastGenerateMs] = useState<number | null>(null)

    const [indexesEnabled, setIndexesEnabled] = useState(true)
    const [instanceId, setInstanceId] = useState(1)

    const [titleQ, setTitleQ] = useState('')
    const [authorQ, setAuthorQ] = useState('')
    const [titleOp, setTitleOp] = useState<'and' | 'or'>('or')
    const [authorOp, setAuthorOp] = useState<'and' | 'or'>('or')
    const [selectedGenres, setSelectedGenres] = useState<string[]>([])
    const [windowDays, setWindowDays] = useState(30)
    const [limit, setLimit] = useState(50)

    const [seeding, setSeeding] = useState(false)
    const [seededCount, setSeededCount] = useState(0)
    const [mutating, setMutating] = useState(false)
    const [lastUpsert, setLastUpsert] = useState<{ total: number; ok: number; err: number } | null>(null)

    const [samples, setSamples] = useState<Sample[]>([])
    const pendingStartRef = useRef<number | null>(null)
    const querySeqRef = useRef(0)

    const client = useMemo(() => {
        const stores: any = {
            books: {
                ...(indexesEnabled
                    ? {
                        indexes: [
                            { field: 'updatedAt', type: 'number' },
                            { field: 'genre', type: 'string' },
                            { field: 'title', type: 'text', options: { minTokenLength: 2 } },
                            { field: 'author', type: 'text', options: { minTokenLength: 2 } }
                        ]
                    }
                    : {})
            }
        }

        return createClient<{ books: Book }>(
            {
                store: {
                    type: 'memory',
                    seed: { books: datasetRef.current ?? [] }
                }
            },
            stores
        )
    }, [indexesEnabled, instanceId])

    const store = client.Store('books')

    useEffect(() => {
        setSeededCount(store.getCachedAll().length)
        setSamples([])
        pendingStartRef.current = null
        querySeqRef.current = 0
    }, [store])

    const where = useMemo(() => {
        const out: any = {}

        const tq = titleQ.trim()
        if (tq) {
            out.title = { match: { q: tq, op: titleOp, minTokenLength: 2 } }
        }

        const aq = authorQ.trim()
        if (aq) {
            out.author = { match: { q: aq, op: authorOp, minTokenLength: 2 } }
        }

        if (selectedGenres.length) {
            out.genre = { in: selectedGenres.slice() }
        }

        if (windowDays > 0) {
            const gte = now() - windowDays * 24 * 60 * 60 * 1000
            out.updatedAt = { gte }
        }

        return out
    }, [titleQ, titleOp, authorQ, authorOp, selectedGenres, windowDays])

    const queryKey = useMemo(() => {
        return JSON.stringify({
            where,
            limit
        })
    }, [where, limit])

    const { data, loading, error } = useFindMany(store, {
        where,
        orderBy: { field: 'updatedAt', direction: 'desc' },
        limit,
        fetchPolicy: 'local'
    })

    useEffect(() => {
        setSeededCount(store.getCachedAll().length)
    }, [store, data])

    useEffect(() => {
        if (!seededCount) return
        if (pendingStartRef.current === null) return

        const startedAt = pendingStartRef.current
        pendingStartRef.current = null
        const dt = performance.now() - startedAt
        setSamples((prev) => {
            const next = [...prev, { ms: dt, at: now() }]
            return next.slice(-200)
        })
    }, [data, seededCount, queryKey])

    const startMeasure = () => {
        querySeqRef.current += 1
        pendingStartRef.current = performance.now()
    }

    const p50 = percentile(samples, 0.5)
    const p95 = percentile(samples, 0.95)

    const hasDataset = Boolean(dataset?.length)
    const canSeed = hasDataset && !seeding

    const generateAndSeed = async () => {
        setSeedError(null)
        setLoadingDataset(true)
        setSeeding(true)
        setSamples([])
        pendingStartRef.current = null
        querySeqRef.current = 0

        try {
            const genStart = performance.now()
            const generated = generateBooks(100_000, seed)
            datasetRef.current = generated
            setDataset(generated)
            setLastGenerateMs(performance.now() - genStart)

            const seedStart = performance.now()
            await store.fetchAll?.()
            setLastSeedMs(performance.now() - seedStart)

            setSeededCount(store.getCachedAll().length)
            const genres = Array.from(new Set(generated.map(b => b.genre))).slice(0, 12)
            setSelectedGenres(genres.slice(0, 3))
            setSeedError(null)
        } catch (e: any) {
            setSeedError(e?.message || String(e))
        } finally {
            setLoadingDataset(false)
            setSeeding(false)
        }
    }

    const reseedOnly = async () => {
        if (!canSeed) return
        setSeedError(null)
        setSeeding(true)
        setSamples([])
        pendingStartRef.current = null
        querySeqRef.current = 0
        try {
            const seedStart = performance.now()
            await store.fetchAll?.()
            setLastSeedMs(performance.now() - seedStart)
            setSeededCount(store.getCachedAll().length)
            const current = datasetRef.current ?? []
            const genres = Array.from(new Set(current.map(b => b.genre))).slice(0, 12)
            setSelectedGenres((prev) => prev.length ? prev : genres.slice(0, 3))
        } catch (e: any) {
            setSeedError(e?.message || String(e))
        } finally {
            setSeeding(false)
        }
    }

    const bumpRandom = async (count: number) => {
        if (mutating) return
        if (!seededCount) return
        setMutating(true)
        setLastUpsert(null)
        try {
            const upsertMany = (store as any)?.upsertMany as undefined | ((items: any[], options?: any) => Promise<any>)
            if (typeof upsertMany !== 'function') {
                setSeedError('当前 atoma 构建未包含 upsertMany（请先运行 npm run dev:lib 或 npm run build）')
                return
            }

            const all = store.getCachedAll() as Book[]
            const n = Math.min(all.length, Math.max(1, Math.floor(count)))

            const picked: Book[] = new Array(n)
            for (let i = 0; i < n; i++) {
                faker.seed(seed + i + 1)
                picked[i] = all[faker.number.int({ min: 0, max: all.length - 1 })]
            }

            const patch = picked.map((a, i) => {
                const add = i % 2 === 0 ? ' revised' : ' updated'
                return {
                    id: a.id,
                    title: a.title.includes(add.trim()) ? a.title : `${a.title}${add}`,
                    author: a.author
                } as any
            })

            const res = await upsertMany(patch as any, { merge: true } as any)
            const list = Array.isArray(res) ? res : []
            const ok = list.filter((x: any) => x?.ok === true).length
            const err = list.filter((x: any) => x?.ok === false).length
            setLastUpsert({ total: list.length, ok, err })
        } finally {
            setMutating(false)
        }
    }

    const resetInstance = () => {
        setInstanceId((v) => v + 1)
        setSamples([])
        pendingStartRef.current = null
        querySeqRef.current = 0
    }

    const onChangeTitle = (v: string) => {
        startMeasure()
        setTitleQ(v)
    }

    const onChangeAuthor = (v: string) => {
        startMeasure()
        setAuthorQ(v)
    }

    const onChangeWindowDays = (v: number) => {
        startMeasure()
        setWindowDays(v)
    }

    const onChangeLimit = (v: number) => {
        startMeasure()
        setLimit(v)
    }

    const onChangeTitleOp = (v: 'and' | 'or') => {
        startMeasure()
        setTitleOp(v)
    }

    const onChangeAuthorOp = (v: 'and' | 'or') => {
        startMeasure()
        setAuthorOp(v)
    }

    const onToggleIndexes = () => {
        setIndexesEnabled((v) => !v)
        resetInstance()
    }

    const canRunQuery = seededCount > 0

    const genres = useMemo(() => {
        const current = datasetRef.current ?? []
        if (!current.length) return [] as string[]
        return Array.from(new Set(current.map(b => b.genre))).slice(0, 12)
    }, [dataset, seededCount])

    return (
        <div className='not-prose w-full'>
            <div className='rounded-lg border bg-fd-background p-4'>
                <div className='flex flex-col gap-3'>
                    <div className='flex flex-col gap-2 md:flex-row md:items-center md:justify-between'>
                        <div className='text-sm font-medium'>本地索引与查询性能（10 万条）</div>
                        <div className='flex flex-wrap gap-2'>
                            <button
                                className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                                onClick={onToggleIndexes}
                                type='button'
                            >
                                索引：{indexesEnabled ? 'ON' : 'OFF'}
                            </button>
                            <button
                                className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                                onClick={resetInstance}
                                type='button'
                            >
                                重置本地缓存
                            </button>
                        </div>
                    </div>

                    <div className='grid grid-cols-1 gap-3 lg:grid-cols-3'>
                        <div className='rounded-md border p-3'>
                            <div className='text-xs text-fd-muted-foreground'>数据</div>
                            <div className='mt-2 flex flex-col gap-2 text-sm'>
                                <div>dataset：{dataset ? `${dataset.length}` : '未生成'}</div>
                                <div>cache：{seededCount}</div>
                                <div className='text-xs text-fd-muted-foreground'>
                                    生成耗时：{lastGenerateMs !== null ? `${lastGenerateMs.toFixed(0)}ms` : '-'}，写入耗时：{lastSeedMs !== null ? `${lastSeedMs.toFixed(0)}ms` : '-'}
                                </div>
                                <div className='flex flex-wrap items-center gap-2'>
                                    <button
                                        className={cn(buttonVariants({ color: 'primary', size: 'sm' }))}
                                        onClick={() => void generateAndSeed()}
                                        type='button'
                                        disabled={loadingDataset || seeding || mutating}
                                    >
                                        生成并写入（seed={seed}）
                                    </button>
                                    <button
                                        className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                                        onClick={() => void reseedOnly()}
                                        type='button'
                                        disabled={!hasDataset || seeding || mutating}
                                    >
                                        仅写入（复用 dataset）
                                    </button>
                                    <button
                                        className={cn(buttonVariants({ color: 'outline', size: 'sm' }))}
                                        onClick={() => void bumpRandom(1000)}
                                        type='button'
                                        disabled={!seededCount || seeding || mutating}
                                    >
                                        随机 upsertMany 1000 条
                                    </button>
                                </div>
                                {lastUpsert ? (
                                    <div className='text-xs text-fd-muted-foreground'>
                                        upsertMany：total={lastUpsert.total} ok={lastUpsert.ok} err={lastUpsert.err}
                                    </div>
                                ) : null}
                                <div className='flex items-center gap-2'>
                                    <span className='text-xs text-fd-muted-foreground'>seed</span>
                                    <input
                                        className='w-full rounded border bg-fd-background px-2 py-1 text-sm'
                                        value={String(seed)}
                                        onChange={(e) => setSeed(clampInt(Number(e.target.value), 0, 1_000_000_000))}
                                        disabled={loadingDataset || seeding || mutating}
                                    />
                                </div>
                            </div>
                        </div>

                        <div className='rounded-md border p-3'>
                            <div className='text-xs text-fd-muted-foreground'>筛选</div>
                            <div className='mt-2 flex flex-col gap-2 text-sm'>
                                <label className='flex flex-col gap-1'>
                                    <span className='text-xs text-fd-muted-foreground'>title.match（minTokenLength=2）</span>
                                    <input
                                        className='w-full rounded border bg-fd-background px-2 py-1 text-sm'
                                        value={titleQ}
                                        onChange={(e) => onChangeTitle(e.target.value)}
                                        disabled={!canRunQuery}
                                    />
                                </label>

                                <label className='flex items-center justify-between gap-2'>
                                    <span className='text-xs text-fd-muted-foreground'>title.match.op</span>
                                    <select
                                        className='rounded border bg-fd-background px-2 py-1 text-sm'
                                        value={titleOp}
                                        onChange={(e) => onChangeTitleOp(e.target.value as any)}
                                        disabled={!canRunQuery}
                                    >
                                        <option value='and'>and</option>
                                        <option value='or'>or</option>
                                    </select>
                                </label>

                                <label className='flex flex-col gap-1'>
                                    <span className='text-xs text-fd-muted-foreground'>author.match（minTokenLength=2）</span>
                                    <input
                                        className='w-full rounded border bg-fd-background px-2 py-1 text-sm'
                                        value={authorQ}
                                        onChange={(e) => onChangeAuthor(e.target.value)}
                                        disabled={!canRunQuery}
                                    />
                                </label>

                                <label className='flex items-center justify-between gap-2'>
                                    <span className='text-xs text-fd-muted-foreground'>author.match.op</span>
                                    <select
                                        className='rounded border bg-fd-background px-2 py-1 text-sm'
                                        value={authorOp}
                                        onChange={(e) => onChangeAuthorOp(e.target.value as any)}
                                        disabled={!canRunQuery}
                                    >
                                        <option value='and'>and</option>
                                        <option value='or'>or</option>
                                    </select>
                                </label>

                                <div className='flex flex-wrap gap-2'>
                                    {genres.map((g) => (
                                        <label key={g} className='flex items-center gap-2 rounded border px-2 py-1'>
                                            <input
                                                type='checkbox'
                                                checked={selectedGenres.includes(g)}
                                                onChange={() => {
                                                    startMeasure()
                                                    setSelectedGenres((prev) => {
                                                        const has = prev.includes(g)
                                                        if (has) return prev.filter(x => x !== g)
                                                        return [...prev, g]
                                                    })
                                                }}
                                                disabled={!canRunQuery}
                                            />
                                            <span className='text-sm'>{g}</span>
                                        </label>
                                    ))}
                                </div>

                                <label className='flex items-center justify-between gap-2'>
                                    <span className='text-xs text-fd-muted-foreground'>updatedAt 窗口</span>
                                    <select
                                        className='rounded border bg-fd-background px-2 py-1 text-sm'
                                        value={String(windowDays)}
                                        onChange={(e) => onChangeWindowDays(Number(e.target.value))}
                                        disabled={!canRunQuery}
                                    >
                                        <option value='1'>最近 1 天</option>
                                        <option value='7'>最近 7 天</option>
                                        <option value='30'>最近 30 天</option>
                                    </select>
                                </label>

                                <label className='flex items-center justify-between gap-2'>
                                    <span className='text-xs text-fd-muted-foreground'>limit</span>
                                    <select
                                        className='rounded border bg-fd-background px-2 py-1 text-sm'
                                        value={String(limit)}
                                        onChange={(e) => onChangeLimit(Number(e.target.value))}
                                        disabled={!canRunQuery}
                                    >
                                        <option value='20'>20</option>
                                        <option value='50'>50</option>
                                        <option value='200'>200</option>
                                    </select>
                                </label>
                            </div>
                        </div>

                        <div className='rounded-md border p-3'>
                            <div className='text-xs text-fd-muted-foreground'>指标</div>
                            <div className='mt-2 text-sm'>
                                <div>loading：{String(loading || seeding || loadingDataset || mutating)}</div>
                                <div>结果：{Array.isArray(data) ? data.length : 0}</div>
                                <div>samples：{samples.length}</div>
                                <div className='mt-2'>
                                    <div>p50：{p50 !== undefined ? `${p50.toFixed(1)}ms` : '-'}</div>
                                    <div>p95：{p95 !== undefined ? `${p95.toFixed(1)}ms` : '-'}</div>
                                </div>
                            </div>
                        </div>
                    </div>

                    {seedError ? (
                        <Callout type='error' title='初始化失败'>
                            {seedError}
                        </Callout>
                    ) : null}

                    {error ? (
                        <Callout type='error' title='查询失败'>
                            {error.message}
                        </Callout>
                    ) : null}
                </div>
            </div>

            <div className='mt-4 rounded-lg border bg-fd-background p-4'>
                <div className='text-sm font-medium'>结果预览</div>
                <div className='mt-3 flex flex-col gap-2'>
                    {(Array.isArray(data) ? (data as Book[]) : []).slice(0, 20).map((a) => (
                        <div key={a.id} className='rounded-md border p-3'>
                            <div className='text-sm font-medium'>{a.title}</div>
                            <div className='mt-1 text-xs text-fd-muted-foreground'>
                                id={a.id} author={a.author} genre={a.genre} updatedAt={new Date(a.updatedAt).toISOString()}
                            </div>
                        </div>
                    ))}
                    {!seededCount ? (
                        <div className='text-sm text-fd-muted-foreground'>先点击“生成并写入”初始化 10 万条数据。</div>
                    ) : null}
                    {seededCount && Array.isArray(data) && data.length === 0 ? (
                        <div className='text-sm text-fd-muted-foreground'>当前筛选无结果。</div>
                    ) : null}
                </div>
            </div>
        </div>
    )
}
