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

function createTestAdapter() {
    const adapter: IDataSource<Post> = {
        name: 'test',
        applyPatches: vi.fn(async () => { }),
        put: vi.fn(async () => { }),
        bulkPut: vi.fn(async () => { }),
        delete: vi.fn(async () => { }),
        bulkDelete: vi.fn(async () => { }),
        get: vi.fn(async () => undefined),
        bulkGet: vi.fn(async (keys) => keys.map(() => undefined)),
        getAll: vi.fn(async () => [])
    }
    return adapter
}

describe('Scheduler: 默认 opContext（actionId）自动合并', () => {
    it('同一轮事件循环内多次 addOne：只触发一次 adapter.bulkPut', async () => {
        const adapter = createTestAdapter()
        let nextId = 1

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            idGenerator: () => nextId++,
            store: createJotaiStore()
        })

        const writes = Array.from({ length: 10 }).map((_, i) => {
            return store.addOne({ title: `t_${i}` } as any)
        })
        await Promise.all(writes)

        expect((adapter.bulkPut as any).mock.calls.length).toBe(1)
        expect(store.getCachedAll().length).toBe(10)
    })
})
