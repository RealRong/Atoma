import type { ExecuteOpsInput, ExecuteOpsOutput } from './ops/OpsClient'
import type { NotifyMessage } from '#protocol'

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

