import { describe, expect, it, vi } from 'vitest'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import type { IDataSource } from '../../src/core'

type Post = {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    version?: number
}

function createDeferred<T>() {
    let resolve!: (value: T) => void
    let reject!: (reason?: unknown) => void
    const promise = new Promise<T>((res, rej) => {
        resolve = res
        reject = rej
    })
    return { promise, resolve, reject }
}

function createTestAdapter() {
    const bulkCreateServerAssignedDeferred = createDeferred<Post[] | void>()
    const bulkCreateServerAssignedCalled = createDeferred<void>()

    const adapter: IDataSource<Post> = {
        name: 'test',
        put: vi.fn(async () => { }),
        bulkPut: vi.fn(async () => { }),
        bulkCreate: vi.fn(async () => undefined),
        bulkCreateServerAssigned: vi.fn(async () => {
            bulkCreateServerAssignedCalled.resolve(undefined)
            return bulkCreateServerAssignedDeferred.promise
        }),
        delete: vi.fn(async () => { }),
        bulkDelete: vi.fn(async () => { }),
        get: vi.fn(async () => undefined),
        bulkGet: vi.fn(async (keys) => keys.map(() => undefined)),
        getAll: vi.fn(async () => [])
    }

    return { adapter, bulkCreateServerAssignedDeferred, bulkCreateServerAssignedCalled }
}

describe('core createServerAssigned*', () => {
    it('does not write to atom before persist resolves, then writes created result after', async () => {
        const { adapter, bulkCreateServerAssignedDeferred, bulkCreateServerAssignedCalled } = createTestAdapter()
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const p = store.createServerAssignedOne({ title: 'hello' } as any)

        await bulkCreateServerAssignedCalled.promise

        expect(store.getCachedAll().length).toBe(0)
        expect((adapter.bulkCreateServerAssigned as any).mock.calls.length).toBe(1)

        const now = Date.now()
        bulkCreateServerAssignedDeferred.resolve([{
            id: 's1',
            title: 'hello',
            createdAt: now,
            updatedAt: now,
            version: 1
        }])

        const created = await p
        expect(created.id).toBe('s1')
        expect(store.getCachedAll().length).toBe(1)
        expect(store.getCachedAll()[0].id).toBe('s1')
    })

    it('rejects when input includes id', async () => {
        const { adapter } = createTestAdapter()
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        await expect(store.createServerAssignedOne({ id: 'x', title: 'hello' } as any)).rejects.toThrow(/不允许传入 id/)
    })
})
