import { describe, expect, it, vi } from 'vitest'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import type { IAdapter, OperationContext } from '../../src/core'

type Post = {
    id: number
    title: string
    createdAt: number
    updatedAt: number
}

function createTestAdapter() {
    const adapter: IAdapter<Post> = {
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

describe('core mutation hooks (phase 3): beforeDispatch middleware', () => {
    it('reject: 直接拒绝写入，不入队、不改 map、不触发 adapter', async () => {
        const adapter = createTestAdapter()
        const store = Core.store.createCoreStore<Post>({
            name: 'posts',
            adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')

        handle.services.mutation.hooks.middleware.beforeDispatch.use(async (ctx) => {
            if (!ctx.event.opContext) {
                return { kind: 'reject', error: new Error('missing opContext') }
            }
            return { kind: 'proceed' }
        })

        await expect(store.addOne({ title: 'hello' } as any)).rejects.toThrow('missing opContext')
        expect(store.getCachedAll().length).toBe(0)
        expect((adapter.applyPatches as any).mock.calls.length).toBe(0)
    })

    it('transform: 注入 opContext 后写入正常进行', async () => {
        const adapter = createTestAdapter()
        const store = Core.store.createCoreStore<Post>({
            name: 'posts',
            adapter,
            store: createJotaiStore()
        })

        const handle = Core.store.getHandle(store)
        if (!handle) throw new Error('missing handle')

        const injected: OperationContext = {
            scope: 'default',
            origin: 'user',
            actionId: 'test-action',
            timestamp: Date.now()
        }

        handle.services.mutation.hooks.middleware.beforeDispatch.use(async (ctx, next) => {
            if (ctx.event.opContext) return next(ctx)
            return {
                kind: 'transform',
                event: { ...ctx.event, opContext: injected }
            }
        })

        const created = await store.addOne({ title: 'hello' } as any, { confirmation: 'strict', timeoutMs: 50 })
        expect(created.title).toBe('hello')
        expect(store.getCachedAll().length).toBe(1)
        expect((adapter.applyPatches as any).mock.calls.length).toBe(1)
    })
})

