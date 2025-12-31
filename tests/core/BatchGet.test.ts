import { describe, expect, it, vi } from 'vitest'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import type { IDataSource } from '../../src/core'

type Post = {
    id: number
    title: string
    createdAt: number
    updatedAt: number
}

type Deferred<T> = {
    promise: Promise<T>
    resolve: (value: T) => void
    reject: (error: unknown) => void
}

function createDeferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void
    let reject!: (error: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function createTestAdapter() {
    const adapter: IDataSource<Post> = {
        name: 'test',
        applyPatches: vi.fn(async () => { }),
        put: vi.fn(async () => { }),
        bulkPut: vi.fn(async () => { }),
        delete: vi.fn(async () => { }),
        bulkDelete: vi.fn(async () => { }),
        get: vi.fn(async () => undefined),
        bulkGet: vi.fn(async (keys) => keys.map((k) => ({
            id: k as number,
            title: String(k),
            createdAt: 0,
            updatedAt: 0
        }))),
        getAll: vi.fn(async () => [])
    }
    return adapter
}

describe('batchGet', () => {
    it('getOne: 同一微任务内合并 bulkGet，并写入缓存', async () => {
        const adapter = createTestAdapter()
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const p1 = store.getOne(1)
        const p2 = store.getOne(2)
        const [a, b] = await Promise.all([p1, p2])

        expect((adapter.bulkGet as any).mock.calls.length).toBe(1)
        expect((adapter.bulkGet as any).mock.calls[0][0]).toEqual([1, 2])

        expect(a?.id).toBe(1)
        expect(b?.id).toBe(2)
        expect(store.getCachedOneById(1)).toBe(a)
        expect(store.getCachedOneById(2)).toBe(b)
    })

    it('getOne: 相同 id 会去重，但每个调用都会 resolve', async () => {
        const adapter = createTestAdapter()
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const p1 = store.getOne(1)
        const p2 = store.getOne(1)
        const [a, b] = await Promise.all([p1, p2])

        expect((adapter.bulkGet as any).mock.calls.length).toBe(1)
        expect((adapter.bulkGet as any).mock.calls[0][0]).toEqual([1])
        expect(a).toBe(b)
        expect(store.getCachedOneById(1)).toBe(a)
    })

    it('fetchOne: 同一微任务内合并 bulkGet，但不写入缓存', async () => {
        const adapter = createTestAdapter()
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const p1 = store.fetchOne(1)
        const p2 = store.fetchOne(2)
        await Promise.all([p1, p2])

        expect((adapter.bulkGet as any).mock.calls.length).toBe(1)
        expect((adapter.bulkGet as any).mock.calls[0][0]).toEqual([1, 2])
        expect(store.getCachedOneById(1)).toBeUndefined()
        expect(store.getCachedOneById(2)).toBeUndefined()
    })

    it('fetchOne: 多 trace 分组时不串结果', async () => {
        const adapter = createTestAdapter()

        const first: Post = { id: 1, title: 'a', createdAt: 0, updatedAt: 0 }
        const deferred = createDeferred<Array<Post | undefined>>()

        let callIndex = 0
        ;(adapter.bulkGet as any) = vi.fn(() => {
            callIndex += 1
            if (callIndex === 1) return Promise.resolve([first])
            return deferred.promise
        })

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const p1 = store.fetchOne(1, { explain: true } as any)
        const p2 = store.fetchOne(1, { explain: true } as any)

        const r1 = await p1
        expect(r1).toBe(first)

        deferred.resolve([undefined])
        const r2 = await p2
        expect(r2).toBeUndefined()
    })

    it('getOne/fetchOne: bulkGet 失败会 reject', async () => {
        const adapter = createTestAdapter()
        ;(adapter.bulkGet as any) = vi.fn(async () => {
            throw new Error('boom')
        })

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        await expect(store.getOne(1)).rejects.toThrow('boom')
        await expect(store.fetchOne(1)).rejects.toThrow('boom')
    })
})

