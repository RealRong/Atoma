import { describe, expect, it } from 'vitest'
import { createError } from '../../../src/error'
import type { IOrmAdapter, ISyncAdapter, QueryResult } from '../../../src/adapters/ports'
import { executeWriteItem } from '../../../src/domain/write/executeWriteItem'

function createOrmAdapter(args?: {
    onCreate?: (resource: string, data: Record<string, unknown>) => Promise<Record<string, unknown>> | Record<string, unknown>
    onUpdate?: (resource: string, item: { id: unknown; data: Record<string, unknown>; baseVersion?: number }) => Promise<Record<string, unknown>>
}) {
    const adapter: IOrmAdapter = {
        async findMany(): Promise<QueryResult> {
            return { data: [] }
        },
        async transaction<T>(fn: (args: { orm: IOrmAdapter; tx: unknown }) => Promise<T>): Promise<T> {
            return fn({ orm: adapter, tx: {} })
        },
        async create(resource, data): Promise<{ data?: unknown; error?: any }> {
            if (!args?.onCreate) return { data }
            try {
                return { data: await args.onCreate(resource, data as Record<string, unknown>) }
            } catch (error) {
                return { error }
            }
        },
        async update(resource, item): Promise<{ data?: unknown; error?: any }> {
            if (!args?.onUpdate) return { data: item.data }
            try {
                return {
                    data: await args.onUpdate(resource, {
                        id: item.id,
                        data: item.data as Record<string, unknown>,
                        baseVersion: item.baseVersion
                    })
                }
            } catch (error) {
                return { error }
            }
        }
    }

    return adapter
}

function createSyncAdapter() {
    const idempotency = new Map<string, { status: number; body: unknown }>()
    let cursor = 0
    let appendChangeCalls = 0

    const sync: ISyncAdapter = {
        async getIdempotency(key) {
            const hit = idempotency.get(key)
            return hit ? { hit: true, status: hit.status, body: hit.body } : { hit: false }
        },
        async claimIdempotency(key, value) {
            const existing = idempotency.get(key)
            if (existing) {
                return { acquired: false, status: existing.status, body: existing.body }
            }
            idempotency.set(key, value)
            return { acquired: true }
        },
        async putIdempotency(key, value) {
            idempotency.set(key, value)
        },
        async appendChange(change) {
            appendChangeCalls += 1
            cursor += 1
            return { ...change, cursor }
        },
        async pullChangesByResource() {
            return []
        },
        async waitForResourceChanges() {
            return []
        }
    }

    return {
        sync,
        getAppendChangeCalls: () => appendChangeCalls
    }
}

describe('executeWriteItem', () => {
    it('并发 CAS 更新应只有一个成功', async () => {
        let current = {
            id: 'u-cas',
            version: 1,
            name: 'before'
        }

        const orm = createOrmAdapter({
            onUpdate: async (_resource, item) => {
                await Promise.resolve()
                if (item.id !== current.id) {
                    throw createError('NOT_FOUND', 'not found', { kind: 'not_found' })
                }
                if (item.baseVersion !== current.version) {
                    throw createError('CONFLICT', 'version conflict', {
                        kind: 'conflict',
                        currentVersion: current.version,
                        currentValue: current
                    })
                }
                current = {
                    ...current,
                    ...item.data,
                    version: current.version + 1
                }
                return current
            }
        })

        const [r1, r2] = await Promise.all([
            executeWriteItem({
                orm,
                syncEnabled: false,
                write: {
                    kind: 'update',
                    resource: 'users',
                    id: 'u-cas',
                    baseVersion: 1,
                    data: { name: 'left' }
                }
            }),
            executeWriteItem({
                orm,
                syncEnabled: false,
                write: {
                    kind: 'update',
                    resource: 'users',
                    id: 'u-cas',
                    baseVersion: 1,
                    data: { name: 'right' }
                }
            })
        ])

        const results = [r1, r2]
        const okResults = results.filter((item) => item.ok)
        const failResults = results.filter((item) => !item.ok)

        expect(okResults).toHaveLength(1)
        expect(failResults).toHaveLength(1)
        expect((failResults[0] as { error: { code: string } }).error.code).toBe('CONFLICT')
        expect(current.version).toBe(2)
    })

    it('同 idempotencyKey 并发写入应只产生一次副作用并可重放', async () => {
        let createCalls = 0

        const orm = createOrmAdapter({
            onCreate: async (_resource, data) => {
                await new Promise(resolve => setTimeout(resolve, 80))
                createCalls += 1
                return {
                    id: String(data.id),
                    version: 1,
                    name: data.name
                }
            }
        })
        const { sync, getAppendChangeCalls } = createSyncAdapter()

        const run = () => executeWriteItem({
            orm,
            sync,
            syncEnabled: true,
            idempotencyTtlMs: 60_000,
            write: {
                kind: 'create',
                resource: 'users',
                id: 'u-idem',
                idempotencyKey: 'idem:key:1',
                data: { name: 'idem-user' }
            }
        })

        const [r1, r2] = await Promise.all([run(), run()])

        expect(r1.ok).toBe(true)
        expect(r2.ok).toBe(true)
        expect(createCalls).toBe(1)
        expect(getAppendChangeCalls()).toBe(1)

        const a = r1 as Extract<typeof r1, { ok: true }>
        const b = r2 as Extract<typeof r2, { ok: true }>
        expect(a.replay).toEqual(b.replay)
    })
})
