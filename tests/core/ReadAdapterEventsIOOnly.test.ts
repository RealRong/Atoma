import { describe, it, expect, vi, afterEach } from 'vitest'
import { atom, createStore } from 'jotai'
import { createDevtoolsBridge } from '../../src/devtools/bridge'
import { createStoreRuntime } from '../../src/core/store/runtime'
import { createBatchGet } from '../../src/core/store/batchGet'
import { createGetAll } from '../../src/core/store/getAll'
import { createGetMultipleByIds } from '../../src/core/store/getMultipleByIds'
import { HTTPAdapter } from '../../src/adapters/HTTPAdapter'
import type { Entity, StoreKey } from '../../src/core/types'

type Item = Entity & { id: StoreKey; name?: string }

const createBatchFetch = (dataFor: (req: any) => any[]) => {
    const fetchFn = vi.fn(async (_input: any, init: any) => {
        const body = JSON.parse(init.body)
        return {
            ok: true,
            status: 200,
            json: async () => ({
                results: body.ops.map((op: any) => ({
                    opId: op.opId,
                    ok: true,
                    data: dataFor(op)
                }))
            })
        }
    })
    return { fetchFn }
}

const dataFromBatchOp = (op: any): any[] => {
    const where = op?.query?.params?.where
    if (!where) return [{ id: 1 }, { id: 2 }]
    const id = where.id
    if (id && typeof id === 'object' && Array.isArray(id.in)) return id.in.map((v: any) => ({ id: v }))
    if (id !== undefined && id !== null && (typeof id === 'string' || typeof id === 'number')) return [{ id }]
    return [{ id: 1 }]
}

describe('read APIs 只在 I/O 时 emit adapter:*', () => {
    afterEach(() => {
        vi.unstubAllGlobals()
    })

    it('getMultipleByIds：cache hit 不发 adapter:* 也不发网络请求', async () => {
        const { fetchFn } = createBatchFetch(dataFromBatchOp)
        vi.stubGlobal('fetch', fetchFn as any)

        const devtools = createDevtoolsBridge({ snapshotIntervalMs: 999999 })
        const debugEvents: any[] = []
        devtools.subscribe(e => {
            if (e.type === 'debug-event') debugEvents.push(e.payload as any)
        })

        const jotaiStore = createStore()
        const mapAtom = atom(new Map<StoreKey, Item>([
            [1, { id: 1, name: 'A' }],
            [2, { id: 2, name: 'B' }]
        ]))

        const adapter = new HTTPAdapter<Item>({ baseURL: 'http://localhost', resourceName: 'items', batch: true })
        const runtime = createStoreRuntime<Item>({
            atom: mapAtom,
            adapter,
            config: {
                store: jotaiStore,
                storeName: 'items',
                devtools,
                debug: { enabled: true, sample: 1 }
            }
        })

        const getMultipleByIds = createGetMultipleByIds(runtime)
        const res = await getMultipleByIds([1, 2], true, { traceId: 't_hit' })
        expect(res).toHaveLength(2)
        expect(fetchFn).toHaveBeenCalledTimes(0)
        expect(debugEvents.filter(e => e.type === 'adapter:request' || e.type === 'adapter:response')).toHaveLength(0)
    })

    it('getMultipleByIds：发生 I/O 时发 adapter:request/response（一次）', async () => {
        const { fetchFn } = createBatchFetch(dataFromBatchOp)
        vi.stubGlobal('fetch', fetchFn as any)

        const devtools = createDevtoolsBridge({ snapshotIntervalMs: 999999 })
        const debugEvents: any[] = []
        devtools.subscribe(e => {
            if (e.type === 'debug-event') debugEvents.push(e.payload as any)
        })

        const jotaiStore = createStore()
        const mapAtom = atom(new Map<StoreKey, Item>([
            [1, { id: 1, name: 'A' }]
        ]))

        const adapter = new HTTPAdapter<Item>({ baseURL: 'http://localhost', resourceName: 'items', batch: true })
        const runtime = createStoreRuntime<Item>({
            atom: mapAtom,
            adapter,
            config: {
                store: jotaiStore,
                storeName: 'items',
                devtools,
                debug: { enabled: true, sample: 1 }
            }
        })

        const getMultipleByIds = createGetMultipleByIds(runtime)
        const res = await getMultipleByIds([1, 2], true, { traceId: 't_io' })
        expect(res.map(i => i.id)).toEqual([1, 2])
        expect(fetchFn).toHaveBeenCalledTimes(1)

        const adapterEvents = debugEvents.filter(e => e.type === 'adapter:request' || e.type === 'adapter:response')
        expect(adapterEvents.map(e => e.type)).toEqual(['adapter:request', 'adapter:response'])
        expect(adapterEvents.every(e => e.traceId === 't_io')).toBe(true)
    })

    it('batchGet.getOneById：cache hit 不发 adapter:* 也不发网络请求', async () => {
        const { fetchFn } = createBatchFetch(dataFromBatchOp)
        vi.stubGlobal('fetch', fetchFn as any)

        const devtools = createDevtoolsBridge({ snapshotIntervalMs: 999999 })
        const debugEvents: any[] = []
        devtools.subscribe(e => {
            if (e.type === 'debug-event') debugEvents.push(e.payload as any)
        })

        const jotaiStore = createStore()
        const mapAtom = atom(new Map<StoreKey, Item>([
            [1, { id: 1, name: 'A' }]
        ]))

        const adapter = new HTTPAdapter<Item>({ baseURL: 'http://localhost', resourceName: 'items', batch: true })
        const runtime = createStoreRuntime<Item>({
            atom: mapAtom,
            adapter,
            config: {
                store: jotaiStore,
                storeName: 'items',
                devtools,
                debug: { enabled: true, sample: 1 }
            }
        })

        const { getOneById } = createBatchGet(runtime)
        const item = await getOneById(1, { traceId: 't_hit' })
        expect(item).toMatchObject({ id: 1 })
        expect(fetchFn).toHaveBeenCalledTimes(0)
        expect(debugEvents.filter(e => e.type === 'adapter:request' || e.type === 'adapter:response')).toHaveLength(0)
    })

    it('batchGet.fetchOneById：发生 I/O 时发 adapter:request/response（一次）', async () => {
        const { fetchFn } = createBatchFetch(dataFromBatchOp)
        vi.stubGlobal('fetch', fetchFn as any)

        const devtools = createDevtoolsBridge({ snapshotIntervalMs: 999999 })
        const debugEvents: any[] = []
        devtools.subscribe(e => {
            if (e.type === 'debug-event') debugEvents.push(e.payload as any)
        })

        const jotaiStore = createStore()
        const mapAtom = atom(new Map<StoreKey, Item>())

        const adapter = new HTTPAdapter<Item>({ baseURL: 'http://localhost', resourceName: 'items', batch: true })
        const runtime = createStoreRuntime<Item>({
            atom: mapAtom,
            adapter,
            config: {
                store: jotaiStore,
                storeName: 'items',
                devtools,
                debug: { enabled: true, sample: 1 }
            }
        })

        const { fetchOneById } = createBatchGet(runtime)
        const item = await fetchOneById(1, { traceId: 't_io' })
        expect(item).toMatchObject({ id: 1 })
        expect(fetchFn).toHaveBeenCalledTimes(1)

        const adapterEvents = debugEvents.filter(e => e.type === 'adapter:request' || e.type === 'adapter:response')
        expect(adapterEvents.map(e => e.type)).toEqual(['adapter:request', 'adapter:response'])
        expect(adapterEvents.every(e => e.traceId === 't_io')).toBe(true)
    })

    it('getAll：发生 I/O 时发 adapter:request/response（一次）', async () => {
        const { fetchFn } = createBatchFetch(dataFromBatchOp)
        vi.stubGlobal('fetch', fetchFn as any)

        const devtools = createDevtoolsBridge({ snapshotIntervalMs: 999999 })
        const debugEvents: any[] = []
        devtools.subscribe(e => {
            if (e.type === 'debug-event') debugEvents.push(e.payload as any)
        })

        const jotaiStore = createStore()
        const mapAtom = atom(new Map<StoreKey, Item>())

        const adapter = new HTTPAdapter<Item>({ baseURL: 'http://localhost', resourceName: 'items', batch: true })
        const runtime = createStoreRuntime<Item>({
            atom: mapAtom,
            adapter,
            config: {
                store: jotaiStore,
                storeName: 'items',
                devtools,
                debug: { enabled: true, sample: 1 }
            }
        })

        const getAll = createGetAll(runtime)
        const items = await getAll(undefined, undefined, { traceId: 't_io' })
        expect(items.length).toBeGreaterThan(0)
        expect(fetchFn).toHaveBeenCalledTimes(1)

        const adapterEvents = debugEvents.filter(e => e.type === 'adapter:request' || e.type === 'adapter:response')
        expect(adapterEvents.map(e => e.type)).toEqual(['adapter:request', 'adapter:response'])
        expect(adapterEvents.every(e => e.traceId === 't_io')).toBe(true)
    })
})
