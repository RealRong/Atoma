import { describe, expect, it, vi } from 'vitest'
import type { Meta, Operation, WriteItemResult } from '../../src/protocol'
import type { OutboxStore, SyncOutboxItem, SyncTransport } from '../../src/sync/types'
import { PushLane } from '../../src/sync/lanes/PushLane'

function createMemoryOutbox(): OutboxStore & { queue: SyncOutboxItem[] } {
    const queue: Array<SyncOutboxItem & { inFlightAtMs?: number }> = []

    const api: OutboxStore & { queue: SyncOutboxItem[] } = {
        queue: queue as any,
        enqueue: async (items) => {
            for (const item of items) {
                queue.push({ ...item, inFlightAtMs: undefined })
            }
        },
        peek: async (limit) => {
            const out: SyncOutboxItem[] = []
            const cap = Math.max(0, Math.floor(limit))
            for (const item of queue) {
                if (out.length >= cap) break
                if (typeof item.inFlightAtMs === 'number') continue
                out.push(item)
            }
            return out
        },
        ack: async (keys) => {
            const set = new Set(keys)
            for (let i = queue.length - 1; i >= 0; i--) {
                if (set.has(queue[i].idempotencyKey)) queue.splice(i, 1)
            }
        },
        reject: async (keys) => {
            const set = new Set(keys)
            for (let i = queue.length - 1; i >= 0; i--) {
                if (set.has(queue[i].idempotencyKey)) queue.splice(i, 1)
            }
        },
        markInFlight: async (keys, atMs) => {
            const set = new Set(keys)
            for (const item of queue) {
                if (!set.has(item.idempotencyKey)) continue
                item.inFlightAtMs = atMs
            }
        },
        releaseInFlight: async (keys) => {
            const set = new Set(keys)
            for (const item of queue) {
                if (!set.has(item.idempotencyKey)) continue
                item.inFlightAtMs = undefined
            }
        },
        rebase: async (args) => {
            const baseVersion = args.baseVersion
            if (!(typeof baseVersion === 'number' && Number.isFinite(baseVersion) && baseVersion > 0)) return
            const afterEnqueuedAtMs = typeof args.afterEnqueuedAtMs === 'number' ? args.afterEnqueuedAtMs : undefined

            for (const entry of queue) {
                if (typeof entry.inFlightAtMs === 'number') continue
                if (entry.resource !== args.resource) continue
                if (afterEnqueuedAtMs !== undefined && entry.enqueuedAtMs <= afterEnqueuedAtMs) continue

                const entityId = (entry.item as any)?.entityId
                if (typeof entityId !== 'string' || entityId !== args.entityId) continue

                const writeItem: any = entry.item as any
                if (typeof writeItem.baseVersion === 'number' && Number.isFinite(writeItem.baseVersion) && writeItem.baseVersion > 0) {
                    if (writeItem.baseVersion < baseVersion) {
                        writeItem.baseVersion = baseVersion
                    }
                }
            }
        },
        size: async () => queue.length
    }

    return api
}

function createFakeTransport() {
    const seenOps: Operation[] = []
    const versionById = new Map<string, number>()

    const opsClient = {
        executeOps: async (input: { ops: Operation[]; meta: Meta }) => {
            const op = input.ops[0]
            seenOps.push(op)

            if (op.kind !== 'write') throw new Error('only write supported')
            const action = op.write.action
            const results: WriteItemResult[] = op.write.items.map((item: any, index: number) => {
                const entityId = String(item.entityId)
                const baseVersion = item.baseVersion
                const current = versionById.get(entityId)

                if (action === 'update' || action === 'delete') {
                    if (typeof baseVersion !== 'number') {
                        return {
                            index,
                            ok: false,
                            error: { code: 'INVALID_WRITE', message: 'Missing baseVersion', kind: 'validation' }
                        } as any
                    }
                    if (current !== undefined && current !== baseVersion) {
                        return {
                            index,
                            ok: false,
                            error: { code: 'CONFLICT', message: 'Version conflict', kind: 'conflict' }
                        } as any
                    }
                    const next = baseVersion + 1
                    versionById.set(entityId, next)
                    return { index, ok: true, entityId, version: next } as any
                }

                if (action === 'upsert') {
                    if (typeof baseVersion === 'number') {
                        if (current !== undefined && current !== baseVersion) {
                            return {
                                index,
                                ok: false,
                                error: { code: 'CONFLICT', message: 'Version conflict', kind: 'conflict' }
                            } as any
                        }
                        const next = baseVersion + 1
                        versionById.set(entityId, next)
                        return { index, ok: true, entityId, version: next } as any
                    }
                    const next = (current ?? 0) + 1
                    versionById.set(entityId, next)
                    return { index, ok: true, entityId, version: next } as any
                }

                throw new Error(`unsupported action: ${String(action)}`)
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

    const transport: SyncTransport = {
        opsClient: opsClient as any,
        subscribe: () => ({ close: () => { } })
    }

    return { transport, seenOps }
}

describe('Phase5: outbox compaction + virtual baseVersion rewrite', () => {
    it('compacts same-entity updates and rebases later strict upsert baseVersion', async () => {
        const outbox = createMemoryOutbox()
        const { transport, seenOps } = createFakeTransport()

        const applyWriteAck = vi.fn(async () => { })
        const applyWriteReject = vi.fn(async () => { })

        const lane = new PushLane({
            outbox,
            transport,
            applier: { applyChanges: async () => { }, applyWriteAck, applyWriteReject } as any,
            maxPushItems: 50,
            returning: false,
            now: () => Date.now(),
            buildMeta: () => ({ v: 1, clientTimeMs: Date.now() } as any),
            nextOpId: () => 'w1',
            onError: undefined,
            onEvent: undefined
        })

        await outbox.enqueue([
            {
                idempotencyKey: 'k1',
                resource: 'posts',
                action: 'update',
                item: { entityId: 'p1', baseVersion: 1, value: { id: 'p1', version: 1 }, meta: { idempotencyKey: 'k1' } } as any,
                enqueuedAtMs: 1
            },
            {
                idempotencyKey: 'k2',
                resource: 'posts',
                action: 'update',
                item: { entityId: 'p1', baseVersion: 1, value: { id: 'p1', version: 1 }, meta: { idempotencyKey: 'k2' } } as any,
                enqueuedAtMs: 2
            },
            {
                idempotencyKey: 'k3',
                resource: 'posts',
                action: 'upsert',
                item: { entityId: 'p1', baseVersion: 1, value: { id: 'p1', version: 1 }, meta: { idempotencyKey: 'k3' } } as any,
                options: { upsert: { mode: 'strict' } } as any,
                enqueuedAtMs: 3
            }
        ])

        await lane.flush()

        expect(seenOps.length).toBe(2)
        expect((seenOps[0] as any).write.action).toBe('update')
        expect((seenOps[0] as any).write.items.length).toBe(1)
        expect((seenOps[0] as any).write.items[0].baseVersion).toBe(1)

        expect((seenOps[1] as any).write.action).toBe('upsert')
        expect((seenOps[1] as any).write.items.length).toBe(1)
        expect((seenOps[1] as any).write.items[0].baseVersion).toBe(2)

        expect(applyWriteReject.mock.calls.length).toBe(0)
        expect(applyWriteAck.mock.calls.length).toBe(3)
        expect(await outbox.size()).toBe(0)
    })
})

