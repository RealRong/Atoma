import type {
    Entity,
    OpsClientLike,
    PersistKey,
    PersistRequest,
    PersistResult,
    PersistWriteback,
    StoreToken
} from '#core'
import type { ObservabilityContext } from '#observability'
import type { CoreStore } from '#core'

export type IoChannel = 'store' | 'remote'

export type IoExecuteOpsRequest = Readonly<{
    channel: IoChannel
    ops: import('#protocol').Operation[]
    meta: import('#protocol').Meta
    signal?: AbortSignal
    context?: ObservabilityContext
}>

export type IoExecuteOpsResponse = Readonly<{
    results: import('#protocol').OperationResult[]
    status?: number
}>

export type IoHandler = (req: IoExecuteOpsRequest) => Promise<IoExecuteOpsResponse>

export type IoMiddleware = (next: IoHandler) => IoHandler

export type ClientIo = Readonly<{
    executeOps: IoHandler
    use: (mw: IoMiddleware) => () => void
    /**
     * Optional subscription for channels that support it (e.g. remote SSE notify).
     * Message payload is intentionally `unknown` to keep the I/O layer neutral.
     */
    subscribe?: (req: Readonly<{
        channel: IoChannel
        resources?: string[]
        onMessage: (msg: unknown) => void
        onError: (err: unknown) => void
        signal?: AbortSignal
    }>) => { close: () => void }
}>

export type PersistHandler = <T extends Entity>(args: {
    req: PersistRequest<T>
    /**
     * Calls the next persistence implementation in the chain.
     * - Default: direct persistence (execute write ops immediately).
     * - Plugins can implement queue/local-first/anything by calling `next` or bypassing it.
     */
    next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
}) => Promise<PersistResult<T>>

export type ClientPluginContext = Readonly<{
    /** The client instance being extended (intentionally untyped to avoid circular generics). */
    client: unknown
    meta?: Readonly<{
        storeBackend?: Readonly<{ role: 'local' | 'remote'; kind?: string }>
    }>
    onDispose: (fn: () => void) => () => void
    io: ClientIo

    /**
     * Persistence strategy routing.
     * - `PersistKey` is opaque to core; plugins interpret it.
     * - A plugin may also choose to set store views to use a specific persistKey.
     */
    persistence: Readonly<{
        register: (key: PersistKey, handler: PersistHandler) => () => void
    }>

    /** Write tickets (for deferred confirmations). */
    acks: Readonly<{
        ack: (idempotencyKey: string) => void
        reject: (idempotencyKey: string, reason?: unknown) => void
    }>

    /** Apply remote/confirmed results back to the local in-memory store. */
    writeback: Readonly<{
        apply: <T extends Entity>(storeName: StoreToken, writeback: PersistWriteback<T>) => Promise<void>
    }>

    /** Optional helpers for creating store views (e.g. different persistKey strategies). */
    stores?: Readonly<{
        view: <T extends Entity, Relations = {}>(store: CoreStore<T, Relations>, args: {
            persistKey?: PersistKey
            allowImplicitFetchForWrite?: boolean
            includeServerAssignedCreate?: boolean
        }) => CoreStore<T, Relations>
    }>

    /** Minimal runtime surface that is useful for plugins (kept intentionally small). */
    runtime: Readonly<{
        opsClient: OpsClientLike
        observability: Readonly<{
            createContext: (storeName: StoreToken, args?: { traceId?: string; explain?: boolean }) => ObservabilityContext
        }>
    }>
}>

export type ClientPlugin<TExt extends object = {}> = Readonly<{
    name: string
    setup: (ctx: ClientPluginContext) => Readonly<{
        extension?: TExt
        dispose?: () => void
    }>
}>

export interface PluginCapableClient {
    use: <TExt extends object>(plugin: ClientPlugin<TExt>) => this & TExt
    dispose: () => void
}
