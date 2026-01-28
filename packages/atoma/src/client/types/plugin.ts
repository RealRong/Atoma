import type {
    Entity,
    OperationContext,
    PersistRequest,
    PersistResult,
    PersistWriteback,
    StoreCommit,
    StoreToken,
    WriteStrategy
} from '#core'
import type { DebugConfig, DebugEvent, ObservabilityContext } from '#observability'
import type { Patch } from 'immer'
import type { ClientRuntime } from './runtime'

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

export type DevtoolsProvider = Readonly<{
    snapshot: () => any
    subscribe?: (fn: (e: any) => void) => () => void
}>

export type DevtoolsProviderInput = DevtoolsProvider | (() => any)

export type PersistHandler = <T extends Entity>(args: {
    req: PersistRequest<T>
    /**
     * Calls the next persistence implementation in the chain.
     * - Default: direct persistence (execute write ops immediately).
     * - Plugins can implement queue/local-first/anything by calling `next` or bypassing it.
     */
    next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
}) => Promise<PersistResult<T>>

export type ChannelQueryResult<T = unknown> = Readonly<{ data: T[]; pageInfo?: any; explain?: any }>

export type ChannelApi = Readonly<{
    query: <T = unknown>(args: {
        store: StoreToken
        query: import('#protocol').Query
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

export type NotifyMessage = import('#protocol').NotifyMessage

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
    core: Readonly<{
        /** The client instance being extended (intentionally untyped to avoid circular generics). */
        client: unknown
        /**
         * Internal runtime (used by first-party plugins like devtools).
         * - Not intended for most userland plugins.
         */
        runtime: ClientRuntime
        meta?: Readonly<{
            /**
             * Stable identifier for this client instance (used for namespacing plugin persistence).
             * - Typically derived from the configured backend(s).
             */
            clientKey: string
            storeBackend?: Readonly<{
                role: 'local' | 'remote'
                kind: 'http' | 'indexeddb' | 'memory' | 'localServer' | 'custom'
            }>
        }>
    }>

    onDispose: (fn: () => void) => () => void

    transport: Readonly<{
        io: ClientIo
        store: ChannelApi
        remote: RemoteApi
    }>

    commit: Readonly<{
        subscribe: (listener: (commit: StoreCommit) => void) => () => void
        applyPatches: (args: { storeName: StoreToken; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => Promise<void>
    }>

    observability: Readonly<{
        createContext: (storeName: StoreToken, args?: { traceId?: string; explain?: boolean }) => ObservabilityContext
        registerStore?: (args: { storeName: StoreToken; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => void
    }>

    /**
     * Persistence strategy routing.
     * - `WriteStrategy` is opaque to core; plugins interpret it.
     */
    persistence: Readonly<{
        register: (key: WriteStrategy, handler: PersistHandler) => () => void
        ack: (idempotencyKey: string) => void
        reject: (idempotencyKey: string, reason?: unknown) => void
        writeback: <T extends Entity>(
            storeName: StoreToken,
            writeback: PersistWriteback<T>,
            options?: { context?: ObservabilityContext }
        ) => Promise<void>
    }>

    devtools: Readonly<{
        register: (key: string, provider: DevtoolsProviderInput) => () => void
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
