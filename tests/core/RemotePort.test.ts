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

function createAdapter() {
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

describe('core remote port (phase 5): remoteAck settles tickets + emits event', () => {
    it('outbox/enqueued + remoteAck: strict 写入会被确认并返回', async () => {
        const adapter = createAdapter()
        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource: adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')

        handle.services.mutation.hooks.middleware.beforePersist.use(async () => {
            return { mode: 'custom', status: 'enqueued' }
        })

        const remoteAckSpy = vi.fn()
        handle.services.mutation.hooks.events.remoteAck.on(remoteAckSpy)

        handle.services.mutation.hooks.events.planned.on((e: any) => {
            const key = e.operations?.[0]?.ticket?.idempotencyKey
            if (typeof key !== 'string' || !key) return
            handle.services.mutation.control.remoteAck({
                storeName: 'posts',
                idempotencyKey: key,
                ack: { ok: true }
            })
        })

        const created = await store.addOne({ title: 'hello' } as any, { confirmation: 'strict', timeoutMs: 200 })
        expect(created.title).toBe('hello')
        expect(remoteAckSpy.mock.calls.length).toBe(1)
    })
})
