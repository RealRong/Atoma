import { describe, expect, it, vi } from 'vitest'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import type { IDataSource, IndexDefinition } from '../../src/core'

type Post = {
    id: number
    title: string
    createdAt: number
    updatedAt: number
}

function createTestAdapter(): IDataSource<Post> & { findMany: NonNullable<IDataSource<Post>['findMany']> } {
    return {
        name: 'test',
        put: vi.fn(async () => { }),
        bulkPut: vi.fn(async () => { }),
        delete: vi.fn(async () => { }),
        bulkDelete: vi.fn(async () => { }),
        get: vi.fn(async () => undefined),
        bulkGet: vi.fn(async (keys) => keys.map(() => undefined)),
        getAll: vi.fn(async () => []),
        findMany: vi.fn(async () => ({ data: [] }))
    }
}

describe('findMany', () => {
    it('dataSource.findMany 存在且 explain=false 时，不会提前跑本地 evaluateWithIndexes', async () => {
        const adapter = createTestAdapter()
        adapter.findMany = vi.fn(async () => ({
            data: [{ id: 1, title: 'a', createdAt: 0, updatedAt: 0 }]
        }))

        const indexes: Array<IndexDefinition<Post>> = [{ field: 'id', type: 'number' }]

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore(),
            indexes
        })

        const handle = Core.store.getHandle(store)
        expect(handle).not.toBeNull()
        const collectSpy = vi.spyOn(handle!.indexes!, 'collectCandidates')

        await store.findMany()

        expect((adapter.findMany as any).mock.calls.length).toBe(1)
        expect(collectSpy).toHaveBeenCalledTimes(0)
    })

    it('explain=true 时，会执行本地 evaluateWithIndexes 并返回 explain.index/finalize', async () => {
        const adapter = createTestAdapter()
        adapter.findMany = vi.fn(async () => ({
            data: [{ id: 1, title: 'a', createdAt: 0, updatedAt: 0 }]
        }))

        const indexes: Array<IndexDefinition<Post>> = [{ field: 'id', type: 'number' }]

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore(),
            indexes
        })

        const handle = Core.store.getHandle(store)
        expect(handle).not.toBeNull()
        const collectSpy = vi.spyOn(handle!.indexes!, 'collectCandidates')

        const res = await store.findMany({ explain: true } as any)

        expect(collectSpy).toHaveBeenCalledTimes(1)
        expect(res.explain).toBeTruthy()
        expect((res.explain as any).index).toBeTruthy()
        expect((res.explain as any).finalize).toBeTruthy()
    })

    it('dataSource.findMany 失败时，回退到本地缓存数据', async () => {
        const adapter = createTestAdapter()
        adapter.findMany = vi.fn(async () => {
            throw new Error('boom')
        })

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        expect(handle).not.toBeNull()
        const cached: Post = { id: 1, title: 'cached', createdAt: 0, updatedAt: 0 }
        handle!.jotaiStore.set(handle!.atom, new Map([[1, cached]]))

        const res = await store.findMany()
        expect(res.data.length).toBe(1)
        expect(res.data[0]).toBe(cached)
    })

    it('返回值使用 preserveReferenceShallow，避免无谓引用变化', async () => {
        const adapter = createTestAdapter()
        adapter.findMany = vi.fn(async () => ({
            data: [{ id: 1, title: 'a', createdAt: 0, updatedAt: 0 }]
        }))

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        expect(handle).not.toBeNull()

        const existing: Post = { id: 1, title: 'a', createdAt: 0, updatedAt: 0 }
        handle!.jotaiStore.set(handle!.atom, new Map([[1, existing]]))

        const res = await store.findMany()
        expect(res.data[0]).toBe(existing)
        expect(store.getCachedOneById(1)).toBe(existing)
    })
})

