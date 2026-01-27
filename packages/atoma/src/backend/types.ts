import type { ObservabilityContext } from '#observability'
import type { Meta, NotifyMessage, Operation, OperationResult } from '#protocol'

export type ExecuteOpsInput = {
    ops: Operation[]
    meta: Meta
    signal?: AbortSignal
    context?: ObservabilityContext
}

export type ExecuteOpsOutput = {
    results: OperationResult[]
    status?: number
}

export abstract class OpsClient {
    abstract executeOps(input: ExecuteOpsInput): Promise<ExecuteOpsOutput>
}

export type OpsClientLike = Readonly<{
    executeOps: (input: ExecuteOpsInput) => Promise<ExecuteOpsOutput>
}>

export type NotifyClient = Readonly<{
    subscribe: (args: {
        resources?: string[]
        onMessage: (msg: NotifyMessage) => void
        onError: (err: unknown) => void
        signal?: AbortSignal
    }) => { close: () => void }
}>

export type BackendEndpoint = Readonly<{
    opsClient: OpsClientLike
    notify?: NotifyClient
    capabilities?: Readonly<{
        supportsBatch?: boolean
    }>
}>

export type Backend = Readonly<{
    /** Stable identifier for this backend instance (used for clientKey, plugin namespaces, etc.). */
    key: string

    /** Store endpoint (used by ctx.store and direct CRUD). */
    store: BackendEndpoint

    /** Optional remote endpoint (used by ctx.remote for sync/notify/changes.pull, etc.). */
    remote?: BackendEndpoint

    /** Optional backend capabilities (client reads capabilities, not configuration). */
    capabilities?: Readonly<{
        storePersistence?: 'ephemeral' | 'durable' | 'remote'
    }>

    /** Optional resource cleanup hook (sqlite handles, notify subscriptions, etc.). */
    dispose?: () => void | Promise<void>
}>
