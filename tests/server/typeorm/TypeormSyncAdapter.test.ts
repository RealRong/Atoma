import { describe, it, expect } from 'vitest'
import { AtomaTypeormSyncAdapter } from '../../../src/server/typeorm/TypeormSyncAdapter'

describe('AtomaTypeormSyncAdapter.appendChange', () => {
    it('从 insert raw.lastID 读取 cursor', async () => {
        const insertResult = {
            generatedMaps: [],
            identifiers: [],
            raw: { lastID: 42 }
        }

        const executor: any = {
            createQueryBuilder: () => {
                const qb: any = {
                    insert: () => qb,
                    into: () => qb,
                    values: () => qb,
                    execute: async () => insertResult,
                    select: () => qb,
                    getRawOne: async () => ({ cursor: 999 })
                }
                return qb
            }
        }

        const sync = new AtomaTypeormSyncAdapter(executor)
        const change = await sync.appendChange({
            resource: 'posts',
            id: '1',
            kind: 'upsert',
            serverVersion: 1,
            changedAt: 1
        })

        expect(change.cursor).toBe(42)
    })
})

