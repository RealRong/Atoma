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

describe('core mutation hooks (phase 2): beforePersist middleware', () => {
    it('beforePersist short-circuit: 不触发 adapter 持久化，但会 enqueued（strict 会超时）', async () => {
        const adapter = createTestAdapter()
        const store = Core.store.createCoreStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')

        const afterPersistSpy = vi.fn()
        handle.services.mutation.hooks.events.afterPersist.on(afterPersistSpy)

        handle.services.mutation.hooks.middleware.beforePersist.use(async () => {
            return { mode: 'custom', status: 'enqueued' }
        })

        await expect(
            store.addOne({ title: 'hello' } as any, { confirmation: 'strict', timeoutMs: 20 })
        ).rejects.toMatchObject({ name: 'WriteTimeoutError' })

        expect((adapter.applyPatches as any).mock.calls.length).toBe(0)
        expect(store.getCachedAll().length).toBe(1)
        expect(afterPersistSpy.mock.calls.length).toBe(1)

        const payload = afterPersistSpy.mock.calls[0][0] as any
        expect(payload.result.status).toBe('enqueued')
        expect(payload.result.mode).toBe('custom')
    })

    it('默认 direct：会触发 adapter 持久化，并立即 confirmed（strict 直接通过）', async () => {
        const adapter = createTestAdapter()
        const store = Core.store.createCoreStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const created = await store.addOne({ title: 'hello' } as any, { confirmation: 'strict', timeoutMs: 50 })
        expect(created.title).toBe('hello')
        expect((adapter.applyPatches as any).mock.calls.length).toBe(1)
    })
})
