import { describe, it, expect } from 'vitest'
import { createAtomaServer } from '../../src/server'

describe('/sync/push transaction binding', () => {
    it('不会丢失 orm.transaction 的 this 绑定', async () => {
        const orm: any = {
            dataSource: { ok: true },
            transaction: async function <T>(fn: any): Promise<T> {
                if (!this || this.dataSource !== orm.dataSource) {
                    throw new Error('transaction called without correct this')
                }
                return fn({ orm, tx: undefined })
            },
            findMany: async () => ({ data: [{ id: 380968771776512, version: 0 }] }),
            patch: async (_resource: string, _item: any) => ({ data: { id: 380968771776512, version: 1 } })
        }

        let cursor = 0
        const sync: any = {
            getIdempotency: async () => ({ hit: false }),
            putIdempotency: async () => {},
            appendChange: async (change: any) => {
                cursor += 1
                return { ...change, cursor }
            },
            pullChanges: async () => [],
            waitForChanges: async () => []
        }

        const handler = createAtomaServer({
            adapter: { orm, sync },
            authz: { resources: { allow: ['posts'] } }
        })

        const res = await handler({
            method: 'POST',
            url: 'http://localhost/sync/push',
            json: async () => ({
                deviceId: 'd1',
                ops: [{
                    idempotencyKey: 'k1',
                    resource: 'posts',
                    kind: 'patch',
                    id: 380968771776512,
                    baseVersion: 0,
                    timestamp: 1,
                    patches: [{ op: 'replace', path: [380968771776512, 'title'], value: 'x' }]
                }]
            })
        })

        expect(res.status).toBe(200)
        expect(res.body.acked).toHaveLength(1)
    })
})

