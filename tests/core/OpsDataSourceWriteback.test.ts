import { describe, expect, it } from 'vitest'
import { createStore as createJotaiStore } from 'jotai/vanilla'
import { Core } from '../../src/core'
import { OpsDataSource } from '../../src/datasources'
import { Backend } from '../../src/backend'

type Post = {
    id: string
    title: string
    createdAt: number
    updatedAt: number
    version?: number
}

class FakeOpsClient extends Backend.OpsClient {
    private readonly versionById = new Map<string, number>()

    async executeOps(input: any): Promise<any> {
        const op = input?.ops?.[0]
        if (!op || op.kind !== 'write') {
            throw new Error('FakeOpsClient only supports write ops')
        }

        const action = op.write?.action
        const items = Array.isArray(op.write?.items) ? op.write.items : []

        const results = items.map((item: any, index: number) => {
            const entityId = item?.entityId

            if (action === 'create') {
                const id = String(entityId ?? (item?.value as any)?.id ?? `s_${index}`)
                const nextVersion = 1
                this.versionById.set(id, nextVersion)
                const data = { ...(item?.value ?? {}), id, version: nextVersion }
                return { index, ok: true, entityId: id, version: nextVersion, data }
            }

            if (action === 'update') {
                const id = String(entityId)
                const baseVersion = item?.baseVersion
                const nextVersion = (typeof baseVersion === 'number' ? baseVersion : (this.versionById.get(id) ?? 0)) + 1
                this.versionById.set(id, nextVersion)
                const data = { ...(item?.value ?? {}), id, version: nextVersion }
                return { index, ok: true, entityId: id, version: nextVersion, data }
            }

            if (action === 'upsert') {
                const id = String(entityId)
                const baseVersion = item?.baseVersion
                const nextVersion = (typeof baseVersion === 'number' ? baseVersion : (this.versionById.get(id) ?? 0)) + 1
                this.versionById.set(id, nextVersion)
                const data = { ...(item?.value ?? {}), id, version: nextVersion }
                return { index, ok: true, entityId: id, version: nextVersion, data }
            }

            if (action === 'delete') {
                const id = String(entityId)
                const baseVersion = item?.baseVersion
                const nextVersion = (typeof baseVersion === 'number' ? baseVersion : (this.versionById.get(id) ?? 0)) + 1
                this.versionById.set(id, nextVersion)
                return { index, ok: true, entityId: id, version: nextVersion }
            }

            throw new Error(`Unsupported action: ${String(action)}`)
        })

        return {
            results: [{
                opId: op.opId,
                ok: true,
                data: { results }
            }]
        }
    }
}

describe('OpsDataSource returning writeback', () => {
    it('writes back version after updateOne', async () => {
        const dataSource = new OpsDataSource<Post>({
            opsClient: new FakeOpsClient(),
            resourceName: 'posts',
            batch: false
        })

        const store = Core.store.createStore<Post>({
            name: 'posts',
            dataSource,
            store: createJotaiStore()
        })

        await store.addOne({ id: 'p1', title: 'a' } as any)
        expect(store.getCachedOneById('p1')?.version).toBe(1)

        const updated = await store.updateOne('p1', (draft) => {
            draft.title = 'b'
        })

        expect(updated.version).toBe(2)
        expect(store.getCachedOneById('p1')?.version).toBe(2)
    })
})
