import { describe, expect, it } from 'vitest'
import { defineEntities } from '../../src'
import { Core } from '../../src/core'
import { Backend } from '#backend'

type Post = {
    id: string
    title: string
    createdAt: number
    updatedAt: number
}

describe('CLIENT_API_STORE_SYNC_SPLIT (handle-first)', () => {
    it('Store(name) 与 Sync.Store(name) 共享同一个 handle，且 Sync.Store 不暴露 server-assigned create', async () => {
        const client = defineEntities<{ posts: Post }>()
            .defineStores({})
            .defineClient()
            .store.backend.custom({
                role: 'remote',
                backend: { id: 'remote', opsClient: new Backend.MemoryOpsClient() }
            })
            .build()

        const direct = client.Store('posts')
        const sync = client.Sync.Store('posts')

        expect(Core.store.getHandle(direct)).toBe(Core.store.getHandle(sync as any))
        expect(sync.name).toBe('posts')
        expect((sync as any).createServerAssignedOne).toBeUndefined()
        expect((sync as any).createServerAssignedMany).toBeUndefined()
    })

    it('Store(name) 禁止 outbox persist（必须显式使用 Sync.Store）', async () => {
        const client = defineEntities<{ posts: Post }>()
            .defineStores({})
            .defineClient()
            .store.backend.custom({
                role: 'remote',
                backend: { id: 'remote', opsClient: new Backend.MemoryOpsClient() }
            })
            .build()

        const direct = client.Store('posts')

        expect(() => {
            direct.addOne({ title: 'x' } as any, { __atoma: { persist: 'outbox' } } as any)
        }).toThrow('Sync.Store')
    })

    it('Sync.Store.updateOne 在缓存缺失时禁止隐式补读', async () => {
        const client = defineEntities<{ posts: Post }>()
            .defineStores({})
            .defineClient()
            .store.backend.custom({
                role: 'remote',
                backend: { id: 'remote', opsClient: new Backend.MemoryOpsClient() }
            })
            .build()

        const sync = client.Sync.Store('posts')

        await expect(
            sync.updateOne('missing', () => {
                // noop
            })
        ).rejects.toThrow('禁止补读')
    })
})
