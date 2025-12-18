import { describe, it, expect } from 'vitest'
import { throwError } from '../../src/server'
import { executeWriteItemWithSemantics } from '../../src/server/writeSemantics/executeWriteItemWithSemantics'

describe('executeWriteItemWithSemantics', () => {
    it('patch(baseVersion=0) + root replace：missing 时走 create(upsert)', async () => {
        const created: any[] = []

        const orm: any = {
            patch: async (resource: string) => {
                throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource })
            },
            create: async (_resource: string, data: any) => {
                created.push(data)
                return { data }
            }
        }

        let cursor = 0
        const sync: any = {
            getIdempotency: async () => ({ hit: false }),
            putIdempotency: async () => {},
            appendChange: async (c: any) => {
                cursor += 1
                return { ...c, cursor }
            }
        }

        const res = await executeWriteItemWithSemantics({
            orm,
            sync,
            syncEnabled: true,
            write: {
                kind: 'patch',
                resource: 'posts',
                idempotencyKey: 'k1',
                id: 123,
                baseVersion: 0,
                timestamp: 1,
                patches: [{ op: 'replace', path: [123], value: { id: 123, title: 't', version: 0 } }]
            }
        })

        expect(res.ok).toBe(true)
        if (!res.ok) return
        expect(created).toHaveLength(1)
        expect(created[0].version).toBe(1)
        expect(res.replay).toMatchObject({ resource: 'posts', id: '123', serverVersion: 1 })
        expect(res.change?.cursor).toBe(1)
    })

    it('patch(baseVersion=0) 非 root replace：missing 时不做 upsert', async () => {
        const created: any[] = []

        const orm: any = {
            patch: async (resource: string) => {
                throwError('NOT_FOUND', 'Not found', { kind: 'validation', resource })
            },
            create: async (_resource: string, data: any) => {
                created.push(data)
                return { data }
            }
        }

        const sync: any = {
            getIdempotency: async () => ({ hit: false }),
            putIdempotency: async () => {},
            appendChange: async (c: any) => ({ ...c, cursor: 1 })
        }

        const res = await executeWriteItemWithSemantics({
            orm,
            sync,
            syncEnabled: true,
            write: {
                kind: 'patch',
                resource: 'posts',
                idempotencyKey: 'k1',
                id: 123,
                baseVersion: 0,
                timestamp: 1,
                patches: [{ op: 'replace', path: [123, 'title'], value: 't' }]
            }
        })

        expect(res.ok).toBe(false)
        if (res.ok) return
        expect(res.status).toBe(404)
        expect(res.error.code).toBe('NOT_FOUND')
        expect(created).toHaveLength(0)
    })
})

