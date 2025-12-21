import { describe, it, expect, vi } from 'vitest'
import { SyncOrchestrator } from '../../../src/adapters/http/syncOrchestrator'
import { HTTPEventEmitter } from '../../../src/adapters/http/eventEmitter'
import { TRACE_ID_HEADER, REQUEST_ID_HEADER } from '../../../src/protocol/trace'
import { Observability } from '../../../src/observability'

type Entity = { id: any }

describe('SyncOrchestrator', () => {
    it('重连时先 pull 再 replay（/sync/push）', async () => {
        const order: string[] = []

        const fetchWithRetry = vi.fn(async () => {
            order.push('push')
            const body = {
                acked: [{ idempotencyKey: 'k1', id: 1, serverVersion: 1 }],
                rejected: []
            }
            return new Response(JSON.stringify(body), {
                status: 200,
                headers: { 'Content-Type': 'application/json' }
            })
        })

        const orchestrator = new SyncOrchestrator<Entity>(
            {
                baseURL: 'http://example.local/orchestrator-reconnect',
                sync: { enabled: true },
                offline: { enabled: true }
            } as any,
            {
                queueStorageKey: 'q:reconnect',
                eventEmitter: new HTTPEventEmitter(),
                client: {} as any,
                fetchWithRetry,
                getHeaders: async () => ({}),
                devtools: { registerQueue: () => true } as any
            }
        )

        orchestrator.setSyncHub({
            pullNow: async () => { order.push('pull') }
        } as any)

        ;(orchestrator as any).networkState.isOnline = false
        await orchestrator.pushOrQueueSyncOps([{
            idempotencyKey: 'k1',
            resource: 'todos',
            kind: 'patch',
            id: 1,
            baseVersion: 0,
            timestamp: 1,
            patches: []
        } as any])

        ;(orchestrator as any).networkState.isOnline = true
        await (orchestrator as any).handleReconnect()

        expect(order).toEqual(['pull', 'push'])
    })

    it('sync push 会注入 traceId/requestId 到 headers，并在仅提供 traceId 时派生 requestId', async () => {
        const seen: any[] = []

        const orchestrator = new SyncOrchestrator<Entity>(
            {
                baseURL: 'http://example.local/orchestrator-trace',
                sync: { enabled: true },
                offline: { enabled: false }
            } as any,
            {
                queueStorageKey: 'q:trace',
                eventEmitter: new HTTPEventEmitter(),
                client: {} as any,
                fetchWithRetry: async (_input, init) => {
                    seen.push(init)
                    const body = {
                        acked: [{ idempotencyKey: 'k2', id: 1, serverVersion: 1 }],
                        rejected: []
                    }
                    return new Response(JSON.stringify(body), {
                        status: 200,
                        headers: { 'Content-Type': 'application/json' }
                    })
                },
                getHeaders: async () => ({}),
                devtools: { registerQueue: () => true } as any
            }
        )

        const ctx = Observability.runtime.create({ scope: 'test' }).createContext({ traceId: 't_abc' })
        await orchestrator.pushOrQueueSyncOps(
            [{
                idempotencyKey: 'k2',
                resource: 'todos',
                kind: 'patch',
                id: 1,
                baseVersion: 0,
                timestamp: 1,
                patches: []
            } as any],
            ctx
        )

        const init = seen[0]
        expect(init?.headers?.[TRACE_ID_HEADER]).toBe('t_abc')
        expect(init?.headers?.[REQUEST_ID_HEADER]).toBe('r_t_abc_1')

        const parsed = JSON.parse(String(init?.body))
        expect(parsed?.traceId).toBe('t_abc')
        expect(parsed?.requestId).toBe('r_t_abc_1')
    })
})
