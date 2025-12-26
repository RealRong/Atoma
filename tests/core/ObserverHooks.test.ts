import { describe, expect, it, vi } from 'vitest'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import type { IAdapter } from '../../src/core'

type Post = {
    id: number
    title: string
    createdAt: number
    updatedAt: number
}

function createOkAdapter() {
    const adapter: IAdapter<Post> = {
        name: 'ok',
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

function createFailAdapter() {
    const adapter: IAdapter<Post> = {
        name: 'fail',
        applyPatches: vi.fn(async () => {
            throw new Error('persist failed')
        }),
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

describe('core mutation hooks (phase 4): planned/committed/rolledBack observers', () => {
    it('planned + committed: 写入成功时会触发', async () => {
        const adapter = createOkAdapter()
        const store = Core.store.createCoreStore<Post>({
            name: 'posts',
            adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')

        const plannedSpy = vi.fn()
        const committedSpy = vi.fn()

        handle.services.mutation.hooks.events.planned.on(plannedSpy)
        handle.services.mutation.hooks.events.committed.on(committedSpy)

        await store.addOne({ title: 'hello' } as any, { confirmation: 'strict', timeoutMs: 50 })

        expect(plannedSpy.mock.calls.length).toBe(1)
        expect(committedSpy.mock.calls.length).toBe(1)

        const plannedPayload = plannedSpy.mock.calls[0][0] as any
        expect(plannedPayload.storeName).toBe('posts')
        expect(Array.isArray(plannedPayload.operations)).toBe(true)

        const committedPayload = committedSpy.mock.calls[0][0] as any
        expect(committedPayload.storeName).toBe('posts')
        expect(committedPayload.persistResult.status).toBe('confirmed')
    })

    it('rolledBack: 持久化失败会触发 rollback 事件', async () => {
        const adapter = createFailAdapter()
        const store = Core.store.createCoreStore<Post>({
            name: 'posts',
            adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')

        const rolledBackSpy = vi.fn()
        handle.services.mutation.hooks.events.rolledBack.on(rolledBackSpy)

        await expect(store.addOne({ title: 'hello' } as any, { confirmation: 'strict', timeoutMs: 50 }))
            .rejects.toThrow('persist failed')

        expect(rolledBackSpy.mock.calls.length).toBe(1)
        const payload = rolledBackSpy.mock.calls[0][0] as any
        expect(payload.storeName).toBe('posts')
        expect(payload.error).toBeInstanceOf(Error)
    })
})

