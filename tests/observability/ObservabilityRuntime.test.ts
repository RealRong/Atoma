import { describe, it, expect, vi } from 'vitest'
import { Observability } from '../../src/observability'

describe('ObservabilityRuntime (9.2.3)', () => {
    it('debug 关闭时：createContext 返回 inactive 且 emit 不触发 onEvent', () => {
        const onEvent = vi.fn()
        const runtime = Observability.runtime.create({ scope: 'todos', debug: { enabled: false }, onEvent })
        const ctx = runtime.createContext()

        expect(ctx.active).toBe(false)
        expect(ctx.traceId).toBeUndefined()

        ctx.emit('query:start', { params: { limit: 1 } } as any)
        expect(onEvent).toHaveBeenCalledTimes(0)
    })

    it('debug 开启 + sample=1：自动分配 traceId，emit 产出 DebugEvent（默认 payload 摘要）', () => {
        const events: any[] = []
        const runtime = Observability.runtime.create({
            scope: 'todos',
            debug: { enabled: true, sample: 1 },
            onEvent: (e) => events.push(e)
        })

        const ctx = runtime.createContext()
        expect(ctx.active).toBe(true)
        expect(typeof ctx.traceId).toBe('string')
        expect(ctx.traceId!.startsWith('t_')).toBe(true)

        ctx.emit('query:start', { params: { limit: 1 } } as any)
        expect(events).toHaveLength(1)
        expect(events[0].type).toBe('query:start')
        expect(events[0].scope).toBe('todos')
        expect(events[0].traceId).toBe(ctx.traceId)
        expect(events[0].payload?.type).toBe('object')
    })

    it('payload=true：payload 原样保留（redact 后）', () => {
        const events: any[] = []
        const runtime = Observability.runtime.create({
            scope: 'todos',
            debug: { enabled: true, sample: 1, payload: true, redact: (v) => ({ redacted: true, v }) },
            onEvent: (e) => events.push(e)
        })

        const ctx = runtime.createContext({ traceId: 't_x' })
        ctx.emit('adapter:request', { method: 'GET', endpoint: '/x', attempt: 1 } as any)

        expect(events).toHaveLength(1)
        expect(events[0].payload).toEqual({
            redacted: true,
            v: { method: 'GET', endpoint: '/x', attempt: 1 }
        })
    })

    it('ctx.with(meta)：固化 requestId/opId/parentSpanId，且允许 emit 时覆盖', () => {
        const events: any[] = []
        const runtime = Observability.runtime.create({
            scope: 'todos',
            debug: { enabled: true, sample: 1, payload: true },
            onEvent: (e) => events.push(e)
        })

        const base = runtime.createContext({ traceId: 't_meta' })
        const ctx = base.with({ requestId: 'r_1', opId: 'op_1', parentSpanId: 'p_1' })

        ctx.emit('adapter:request', { method: 'GET', endpoint: '/x', attempt: 1 } as any)
        ctx.emit('adapter:response', { ok: true, status: 200, durationMs: 3 } as any, { requestId: 'r_2' })

        expect(events[0].requestId).toBe('r_1')
        expect(events[0].opId).toBe('op_1')
        expect(events[0].parentSpanId).toBe('p_1')

        expect(events[1].requestId).toBe('r_2')
        expect(events[1].opId).toBe('op_1')
        expect(events[1].parentSpanId).toBe('p_1')
    })

    it('requestId(traceId)：对同一 trace 自增序列；LRU 淘汰后序列可重置', () => {
        const runtime = Observability.runtime.create({
            scope: 'todos',
            debug: { enabled: false },
            maxTraces: 2
        })

        expect(runtime.requestId('t_a')).toBe('r_t_a_1')
        expect(runtime.requestId('t_a')).toBe('r_t_a_2')

        runtime.createContext({ traceId: 't_b' })
        runtime.createContext({ traceId: 't_c' }) // 触发 LRU 淘汰 t_a

        expect(runtime.requestId('t_a')).toBe('r_t_a_1')
    })
})
