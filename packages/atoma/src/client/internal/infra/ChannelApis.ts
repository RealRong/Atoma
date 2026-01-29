import type { Backend } from '#backend'
import type { StoreToken } from '#core'
import type { ObservabilityContext } from '#observability'
import { Protocol } from '#protocol'
import type {
    ChangeBatch,
    Cursor,
    Operation,
    OperationResult,
    Query,
    WriteAction,
    WriteItem,
    WriteOptions,
    WriteResultData
} from '#protocol'
import type {
    ChannelApi,
    ChannelQueryResult,
    IoChannel,
    IoHandler,
    NotifyMessage,
    RemoteApi
} from '#client/types'

export class ChannelApis {
    readonly store: ChannelApi
    readonly remote: RemoteApi

    private readonly execute: IoHandler
    private readonly remoteBackend: Backend['remote'] | undefined
    private readonly now: () => number

    constructor(args: { execute: IoHandler; backend?: Backend; now?: () => number }) {
        this.execute = args.execute
        this.remoteBackend = args.backend?.remote
        this.now = args.now ?? (() => Date.now())

        this.store = this.makeChannelApi('store')
        this.remote = this.buildRemoteApi()
    }



    private requireResultByOpId(results: OperationResult[], opId: string, missingMessage: string): OperationResult {
        for (const r of results) {
            if ((r as any)?.opId === opId) return r
        }
        throw new Error(missingMessage)
    }

    private toOpsError(result: OperationResult, tag: string): Error {
        if ((result as any).ok) return new Error(`[${tag}] Operation failed`)
        const message = ((result as any).error && typeof ((result as any).error as any).message === 'string')
            ? ((result as any).error as any).message
            : `[${tag}] Operation failed`
        const err = new Error(message)
            ; (err as any).error = (result as any).error
        return err
    }

    private executeOps = async (args2: {
        channel: IoChannel
        ops: Operation[]
        context?: ObservabilityContext
        signal?: AbortSignal
    }): Promise<OperationResult[]> => {
        const traceId = (typeof args2.context?.traceId === 'string' && args2.context.traceId) ? args2.context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: args2.ops,
            traceId,
            ...(args2.context ? { nextRequestId: (args2.context as any).requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: this.now,
            traceId,
            requestId: args2.context ? (args2.context as any).requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await this.execute({
            channel: args2.channel,
            ops: opsWithTrace,
            meta,
            ...(args2.signal ? { signal: args2.signal } : {}),
            ...(args2.context ? { context: args2.context } : {})
        })

        return Protocol.ops.validate.assertOperationResults((res as any).results)
    }

    private queryChannel = async <T = unknown>(args2: {
        channel: IoChannel
        store: StoreToken
        query: Query
        context?: ObservabilityContext
        signal?: AbortSignal
    }): Promise<ChannelQueryResult<T>> => {
        const opId = Protocol.ids.createOpId('q', { now: this.now })
        const op: Operation = Protocol.ops.build.buildQueryOp({
            opId,
            resource: String(args2.store),
            query: args2.query
        })
        const results = await this.executeOps({
            channel: args2.channel,
            ops: [op],
            ...(args2.context ? { context: args2.context } : {}),
            ...(args2.signal ? { signal: args2.signal } : {})
        })
        const result = this.requireResultByOpId(results, opId, '[Atoma] Missing query result')
        if (!(result as any).ok) throw this.toOpsError(result, 'query')

        const data = Protocol.ops.validate.assertQueryResultData((result as any).data) as any
        return {
            data: Array.isArray(data?.data) ? (data.data as T[]) : [],
            ...(data?.pageInfo ? { pageInfo: data.pageInfo } : {}),
            ...(data?.explain !== undefined ? { explain: data.explain } : {})
        }
    }

    private writeChannel = async (args2: {
        channel: IoChannel
        store: StoreToken
        action: WriteAction
        items: WriteItem[]
        options?: WriteOptions
        context?: ObservabilityContext
        signal?: AbortSignal
    }): Promise<WriteResultData> => {
        const opId = Protocol.ids.createOpId('w', { now: this.now })
        const op: Operation = Protocol.ops.build.buildWriteOp({
            opId,
            write: {
                resource: String(args2.store),
                action: args2.action,
                items: args2.items,
                ...(args2.options ? { options: args2.options } : {})
            }
        })
        const results = await this.executeOps({
            channel: args2.channel,
            ops: [op],
            ...(args2.context ? { context: args2.context } : {}),
            ...(args2.signal ? { signal: args2.signal } : {})
        })
        const result = this.requireResultByOpId(results, opId, '[Atoma] Missing write result')
        if (!(result as any).ok) throw this.toOpsError(result, 'write')
        return Protocol.ops.validate.assertWriteResultData((result as any).data) as any
    }

    private makeChannelApi = (channel: IoChannel): ChannelApi => {
        return {
            query: (args2) => this.queryChannel({ channel, ...args2 } as any),
            write: (args2) => this.writeChannel({ channel, ...args2 } as any)
        }
    }

    private requireRemote = () => {
        if (!this.remoteBackend) {
            throw new Error('[Atoma] remote backend 未配置（createClient({ backend })）')
        }
        return this.remoteBackend
    }

    private buildRemoteApi = (): RemoteApi => {
        return {
            ...this.makeChannelApi('remote'),
            changes: {
                pull: async (args2: {
                    cursor: Cursor
                    limit: number
                    resources?: string[]
                    context?: ObservabilityContext
                    signal?: AbortSignal
                }): Promise<ChangeBatch> => {
                    this.requireRemote()
                    const opId = Protocol.ids.createOpId('c', { now: this.now })
                    const op: Operation = Protocol.ops.build.buildChangesPullOp({
                        opId,
                        cursor: args2.cursor as Cursor,
                        limit: args2.limit,
                        ...(args2.resources?.length ? { resources: args2.resources } : {})
                    })
                    const results = await this.executeOps({
                        channel: 'remote',
                        ops: [op],
                        ...(args2.context ? { context: args2.context } : {}),
                        ...(args2.signal ? { signal: args2.signal } : {})
                    })
                    const result = this.requireResultByOpId(results, opId, '[Atoma] Missing changes.pull result')
                    if (!(result as any).ok) throw this.toOpsError(result, 'changes.pull')
                    return (result as any).data as ChangeBatch
                }
            },
            ...(this.remoteBackend?.notify
                ? {
                    subscribeNotify: (args2: {
                        resources?: string[]
                        onMessage: (msg: NotifyMessage) => void
                        onError: (err: unknown) => void
                        signal?: AbortSignal
                    }) => {
                        const remote = this.requireRemote()
                        return remote.notify!.subscribe(args2 as any)
                    }
                }
                : {})
        } as any
    }
}
