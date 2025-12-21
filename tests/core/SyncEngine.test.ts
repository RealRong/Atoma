import { describe, it, expect, vi, afterEach } from 'vitest'
import { SyncEngine } from '../../src/sync'
import { MemoryOutboxStore } from '../../src/sync/outbox'
import { MemoryCursorStore } from '../../src/sync/cursor'

describe('SyncEngine (vNext)', () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it('enqueueWrite 会按 idempotencyKey 去重', async () => {
        const outbox = new MemoryOutboxStore()
        const cursor = new MemoryCursorStore('0')
        const applier = {
            applyChanges: vi.fn(),
            applyWriteAck: vi.fn(),
            applyWriteReject: vi.fn()
        }
        const transport = {
            push: vi.fn(async () => ({ transactionApplied: true, results: [] })),
            pull: vi.fn(async () => ({ nextCursor: '0', changes: [] })),
            subscribe: vi.fn(() => ({ close: vi.fn() }))
        }

        const engine = new SyncEngine({
            transport,
            outbox,
            cursor,
            applier
        })

        await engine.enqueueWrite({
            resource: 'post',
            action: 'create',
            items: [
                { value: { id: 1 }, meta: { idempotencyKey: 'k1' } },
                { value: { id: 2 }, meta: { idempotencyKey: 'k1' } }
            ]
        })

        expect(outbox.size()).toBe(1)
    })

    it('cursor 只允许单调前进', async () => {
        const outbox = new MemoryOutboxStore()
        const cursor = new MemoryCursorStore('10')
        const applier = {
            applyChanges: vi.fn(),
            applyWriteAck: vi.fn(),
            applyWriteReject: vi.fn()
        }
        const transport = {
            push: vi.fn(async () => ({ transactionApplied: true, results: [] })),
            pull: vi.fn(async () => ({ nextCursor: '9', changes: [] })),
            subscribe: vi.fn(() => ({ close: vi.fn() }))
        }

        const engine = new SyncEngine({
            transport,
            outbox,
            cursor,
            applier
        })

        await engine.pullNow()
        expect(cursor.get()).toBe('10')
    })

    it('subscribe 断线后会重连', async () => {
        vi.useFakeTimers()

        const outbox = new MemoryOutboxStore()
        const cursor = new MemoryCursorStore('0')
        const applier = {
            applyChanges: vi.fn(),
            applyWriteAck: vi.fn(),
            applyWriteReject: vi.fn()
        }

        let subscribeCalls = 0
        const transport = {
            push: vi.fn(async () => ({ transactionApplied: true, results: [] })),
            pull: vi.fn(async () => ({ nextCursor: '0', changes: [] })),
            subscribe: vi.fn(({ onError }: { onError: (error: unknown) => void }) => {
                subscribeCalls += 1
                if (subscribeCalls === 1) {
                    setTimeout(() => onError(new Error('boom')), 0)
                }
                return { close: vi.fn() }
            })
        }

        const engine = new SyncEngine({
            transport,
            outbox,
            cursor,
            applier,
            subscribe: true,
            reconnectDelayMs: 50
        })

        engine.start()
        await vi.runAllTimersAsync()

        expect(subscribeCalls).toBe(2)
    })
})
