import type { Entity } from 'atoma-core'
import { executeLocalQuery } from 'atoma-core'
import type { EntityId, Operation, OperationResult, QueryResultData } from 'atoma-protocol'
import { ClientPlugin } from '../plugins/ClientPlugin'
import type { IoHandler, PersistHandler, PluginContext, ReadHandler, Register } from '../plugins/types'

const MISSING_TERMINAL = '[Atoma] HandlerChain: missing terminal handler'

const isMissingTerminal = (error: unknown): boolean => {
    if (!error) return false
    if (typeof error === 'string') return error.includes(MISSING_TERMINAL)
    if (typeof (error as any).message === 'string') {
        return String((error as any).message).includes(MISSING_TERMINAL)
    }
    return false
}

async function queryLocal<T extends Entity>(ctx: PluginContext, storeName: string, query: any): Promise<QueryResultData> {
    const handle = ctx.runtime.stores.resolveHandle(storeName, 'LocalBackendPlugin.query')
    const map = handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
    const items = Array.from(map.values()) as T[]
    const outbound = await Promise.all(items.map(item => ctx.runtime.transform.outbound(handle, item)))
    const normalized = outbound.filter(item => item !== undefined) as T[]
    return executeLocalQuery(normalized as any, query as any, { matcher: handle.matcher })
}

function toUnsupportedOpsResults(ops: Operation[]): OperationResult[] {
    return ops.map(op => ({
        opId: op.opId,
        ok: false,
        error: {
            code: 'LOCAL_ONLY',
            message: '[Atoma] LocalBackendPlugin: ops not supported',
            kind: 'internal'
        }
    }))
}

export class LocalBackendPlugin extends ClientPlugin {
    readonly id = 'defaults:local-backend'

    setup(ctx: PluginContext, register: Register) {
        const ioHandler: IoHandler = async (req, _ctx, next) => {
            try {
                return await next()
            } catch (error) {
                if (!isMissingTerminal(error)) throw error
            }

            if (!req.ops.length) return { results: [] }
            const results: OperationResult[] = []
            for (const op of req.ops) {
                if (op.kind === 'query') {
                    const data = await queryLocal(ctx, op.query.resource, op.query.query)
                    results.push({ opId: op.opId, ok: true, data })
                    continue
                }
                results.push(...toUnsupportedOpsResults([op]))
            }
            return { results }
        }

        const readHandler: ReadHandler = async (req, _ctx, next) => {
            try {
                return await next()
            } catch (error) {
                if (!isMissingTerminal(error)) throw error
            }
            return await queryLocal(ctx, String(req.storeName), req.query)
        }

        const persistHandler: PersistHandler = async (_req, _ctx, next) => {
            try {
                return await next()
            } catch (error) {
                if (!isMissingTerminal(error)) throw error
            }
            return { status: 'confirmed' }
        }

        register('io', ioHandler, { priority: -1000 })
        register('read', readHandler, { priority: -1000 })
        register('persist', persistHandler, { priority: -1000 })
    }
}
