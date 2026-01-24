import type {
    Entity,
    PersistRequest,
    PersistResult,
    PersistWriteback,
    StoreToken
} from '#core'
import type { WriteStrategy } from '#core'
import type { ObservabilityContext } from '#observability'
import type { CoreStore } from '#core'

export type IoChannel = 'store' | 'remote'

export type IoRequest = Readonly<{
    channel: IoChannel
    ops: import('#protocol').Operation[]
    meta: import('#protocol').Meta
    signal?: AbortSignal
    context?: ObservabilityContext
}>

export type IoResponse = Readonly<{
    results: import('#protocol').OperationResult[]
    status?: number
}>

export type IoHandler = (req: IoRequest) => Promise<IoResponse>

export type IoMiddleware = (next: IoHandler) => IoHandler

export type ClientIo = Readonly<{
    use: (mw: IoMiddleware) => () => void
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

export type ChannelQueryResult<T = unknown> = Readonly<{ items: T[]; pageInfo?: any }>

export type ChannelApi = Readonly<{
    query: <T = unknown>(args: {
        store: StoreToken
        params: import('#protocol').QueryParams
        context?: ObservabilityContext
        signal?: AbortSignal
    }) => Promise<ChannelQueryResult<T>>
    write: (args: {
        store: StoreToken
        action: import('#protocol').WriteAction
        items: import('#protocol').WriteItem[]
        options?: import('#protocol').WriteOptions
        context?: ObservabilityContext
        signal?: AbortSignal
    }) => Promise<import('#protocol').WriteResultData>
}>

export type NotifyMessage = Readonly<{ resources?: string[]; traceId?: string }>

export type RemoteApi = ChannelApi & Readonly<{
    changes: Readonly<{
        pull: (args: {
            cursor: import('#protocol').Cursor
            limit: number
            resources?: string[]
            context?: ObservabilityContext
            signal?: AbortSignal
        }) => Promise<import('#protocol').ChangeBatch>
    }>
    subscribeNotify?: (args: {
        resources?: string[]
        onMessage: (msg: NotifyMessage) => void
        onError: (err: unknown) => void
        signal?: AbortSignal
    }) => { close: () => void }
}>

export type ClientPluginContext = Readonly<{
    /** The client instance being extended (intentionally untyped to avoid circular generics). */
    client: unknown
    meta?: Readonly<{
        /**
         * Stable identifier for this client instance (used for namespacing plugin persistence).
         * - Typically derived from the configured backend(s).
         */
        clientKey: string
        storeBackend?: Readonly<{ role: 'local' | 'remote'; kind?: string }>
    }>
    onDispose: (fn: () => void) => () => void
    io: ClientIo
    store: ChannelApi
    remote: RemoteApi

    observability: Readonly<{
        createContext: (storeName: StoreToken, args?: { traceId?: string; explain?: boolean }) => ObservabilityContext
    }>

    /**
     * Persistence strategy routing.
     * - `WriteStrategy` is opaque to core; plugins interpret it.
     * - A plugin may also choose to set store views to use a specific writeStrategy.
     */
    persistence: Readonly<{
        register: (key: WriteStrategy, handler: PersistHandler) => () => void
    }>

    /** Write tickets (for deferred confirmations). */
    acks: Readonly<{
        ack: (idempotencyKey: string) => void
        reject: (idempotencyKey: string, reason?: unknown) => void
    }>

    /** Applies writeback results to memory; and commits to durable store when Store backend is local. */
    writeback: Readonly<{
        commit: <T extends Entity>(
            storeName: StoreToken,
            writeback: PersistWriteback<T>,
            options?: { context?: ObservabilityContext }
        ) => Promise<void>
    }>

    /** Optional helpers for creating store views (e.g. different write strategies). */
    stores?: Readonly<{
        view: <T extends Entity, Relations = {}>(store: CoreStore<T, Relations>, args: {
            writeStrategy?: WriteStrategy
            allowImplicitFetchForWrite?: boolean
            includeServerAssignedCreate?: boolean
        }) => CoreStore<T, Relations>
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
