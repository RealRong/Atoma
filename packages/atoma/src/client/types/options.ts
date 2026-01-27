import type { Backend, HttpOpsClientConfig } from '#backend'
import type { Entity, StoreDataProcessor } from '#core'
import type { AtomaSchema } from './schema'
import type { ClientPlugin } from './plugin'

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = Readonly<{
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema

    /** Global dataProcessor applied to all stores (per-store config overrides). */
    dataProcessor?: StoreDataProcessor<any>

    /**
     * Backend input.
     * - string: baseURL (HTTP backend)
     * - object: HTTP backend config
     * - Backend: custom backend instance
     * - undefined: local-only mode
     */
    backend?: string | HttpBackendConfig | Backend

    /** Optional plugins to install immediately (equivalent to calling `client.use(...)` in order). */
    plugins?: ReadonlyArray<ClientPlugin<any>>
}>

type HttpBackendConfig = Readonly<{
    baseURL: string
    /**
     * Stable identifier for this backend instance.
     * Default: baseURL
     */
    key?: string
    /**
     * How the Store endpoint persists data.
     * - 'remote' (default): online-first, no local durable mirror.
     * - 'durable': local server / durable store behind HTTP (mirror enabled).
     */
    storePersistence?: NonNullable<Backend['capabilities']>['storePersistence']
    opsPath?: HttpOpsClientConfig['opsPath']
    headers?: HttpOpsClientConfig['headers']
    retry?: HttpOpsClientConfig['retry']
    fetchFn?: HttpOpsClientConfig['fetchFn']
    onRequest?: NonNullable<HttpOpsClientConfig['interceptors']>['onRequest']
    onResponse?: NonNullable<HttpOpsClientConfig['interceptors']>['onResponse']
    responseParser?: NonNullable<HttpOpsClientConfig['interceptors']>['responseParser']
    batch?: HttpOpsClientConfig['batch']
    /**
     * Enable/disable notify subscription.
     * - true (default): enable with protocol default path
     * - false: disable
     * - object: customize url builder/connect
     */
    notify?: boolean | Readonly<{
        path?: string
        buildUrl?: (args?: { resources?: string[] }) => string
        connect?: (url: string) => EventSource
    }>
}>
