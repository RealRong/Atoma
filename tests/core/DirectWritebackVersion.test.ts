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

function createTestAdapter() {
    const adapter: IDataSource<Post> = {
        name: 'test',
        put: vi.fn(async () => { }),
        bulkPut: vi.fn(async () => { }),
        bulkCreate: vi.fn(async () => undefined),
        delete: vi.fn(async () => { }),
        bulkDelete: vi.fn(async () => { }),
        get: vi.fn(async () => undefined),
        bulkGet: vi.fn(async (keys) => keys.map(() => undefined)),
        getAll: vi.fn(async () => [])
    }
    return { adapter }
}

describe('direct writeback', () => {
    it('writes back versionUpdates to store and returned payload', async () => {
        const { adapter } = createTestAdapter()
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('Missing store handle')

        handle.services.mutation.hooks.middleware.beforePersist.use(async (ctx, next) => {
            const result = await next(ctx)
            return {
                ...result,
                writeback: {
                    versionUpdates: [{ key: 'p1', version: 2 }]
                }
            }
        })

        await store.addOne({ id: 'p1', title: 'a', version: 1 } as any)

        const updated = await store.updateOne('p1', draft => {
            draft.title = 'b'
        })

        expect(updated.id).toBe('p1')
        expect(updated.title).toBe('b')
        expect(updated.version).toBe(2)
        expect(store.getCachedOneById('p1')?.version).toBe(2)
    })
})

