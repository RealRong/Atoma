import type { ObservabilityContext } from 'atoma-observability'
import { Protocol, type Operation, type OperationResult, type Query, type QueryResultData } from 'atoma-protocol'
import type { Entity } from 'atoma-core'
import { executeLocalQuery } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { OpsClientLike, RuntimeIo, StoreHandle } from '../types/runtimeTypes'

export type IoMode = 'local' | 'remote'

type RemoteIoDeps = {
    opsClient: OpsClientLike
    now?: () => number
}

export type IoConfig =
    | { mode: 'local' }
    | ({ mode: 'remote' } & RemoteIoDeps)

export class Io implements RuntimeIo {
    private readonly impl: RuntimeIo

    constructor(config: IoConfig) {
        this.impl = config.mode === 'local'
            ? new LocalIo()
            : new RemoteIo(config)
    }

    executeOps: RuntimeIo['executeOps'] = async (args) => {
        return await this.impl.executeOps(args)
    }

    query: RuntimeIo['query'] = async (handle, query, context, signal) => {
        return await this.impl.query(handle, query, context, signal)
    }
}

class RemoteIo implements RuntimeIo {
    private readonly opsClient: OpsClientLike
    private readonly now: () => number

    constructor(args: RemoteIoDeps) {
        this.opsClient = args.opsClient
        this.now = args.now ?? (() => Date.now())
    }

    executeOps: RuntimeIo['executeOps'] = async (input) => {
        const context = input.context
        const traceId = (typeof context?.traceId === 'string' && context.traceId) ? context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: input.ops,
            traceId,
            ...(context ? { nextRequestId: context.requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: this.now,
            traceId,
            requestId: context ? context.requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await this.opsClient.executeOps({
            ops: opsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(context ? { context } : {})
        } as any)

        try {
            return Protocol.ops.validate.assertOperationResults((res as any).results)
        } catch (error) {
            throw RemoteIo.toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query,
        context?: ObservabilityContext,
        signal?: AbortSignal
    ) => {
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId: handle.nextOpId('q'),
            resource: handle.storeName,
            query
        })
        const results = await this.executeOps({ ops: [op], context, ...(signal ? { signal } : {}) })
        const result = RemoteIo.requireSingleResult(results, 'Missing query result')
        if (!(result as any).ok) throw RemoteIo.toOpsError(result, 'query')

        let data: QueryResultData
        try {
            data = Protocol.ops.validate.assertQueryResultData((result as any).data) as QueryResultData
        } catch (error) {
            throw RemoteIo.toProtocolValidationError(error, 'Invalid query result data')
        }

        return {
            data: Array.isArray((data as any)?.data) ? ((data as any).data as unknown[]) : [],
            pageInfo: (data as any)?.pageInfo,
            ...(data && (data as any).explain !== undefined ? { explain: (data as any).explain } : {})
        }
    }

    private static requireSingleResult(results: OperationResult[], missingMessage: string): OperationResult {
        const result = results[0]
        if (!result) throw new Error(missingMessage)
        return result
    }

    private static toOpsError(result: OperationResult, tag: string): Error {
        if ((result as any).ok) return new Error(`[${tag}] Operation failed`)
        const message = ((result as any).error && typeof ((result as any).error as any).message === 'string')
            ? ((result as any).error as any).message
            : `[${tag}] Operation failed`
        const err = new Error(message)
        ;(err as any).error = (result as any).error
        return err
    }

    private static toProtocolValidationError(error: unknown, fallbackMessage: string): Error {
        const standard = Protocol.error.wrap(error, {
            code: 'INVALID_RESPONSE',
            message: fallbackMessage,
            kind: 'validation'
        })
        const err = new Error(`[Atoma] ${standard.message}`)
        ;(err as any).error = standard
        return err
    }
}

class LocalIo implements RuntimeIo {
    executeOps: RuntimeIo['executeOps'] = async () => {
        throw new Error('[Atoma] local-only 模式不支持 ops 执行')
    }

    query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query
    ) => {
        const map = handle.jotaiStore.get(handle.atom) as Map<EntityId, T>
        const items = Array.from(map.values()) as T[]
        return executeLocalQuery(items as any, query as any)
    }
}
