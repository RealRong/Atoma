import { createClient } from 'atoma-client'
import { memoryBackendPlugin } from 'atoma-backend-memory'
import { atomaServerBackendPlugin } from 'atoma-backend-atoma-server'
import { historyPlugin } from 'atoma-history'
import { syncPlugin, type SyncExtension } from 'atoma-sync'
import type { AtomaClient, AtomaHistory } from 'atoma-types/client'
import type { ClientPlugin } from 'atoma-types/client/plugins'
import type { SyncEvent, SyncMode, SyncPhase } from 'atoma-types/sync'
import type { DemoEntities, DemoSchema, DemoSeed } from './demoSchema'
import { demoSchema } from './demoSchema'

export type DemoClient = AtomaClient<DemoEntities, DemoSchema>
    & Partial<Pick<SyncExtension, 'sync'>>
    & Partial<{ history: AtomaHistory }>

type BaseClientOptions = Readonly<{
    enableHistory?: boolean
    enableSync?: boolean
    syncMode?: SyncMode
    syncResources?: string[]
    onSyncEvent?: (event: SyncEvent) => void
    onSyncError?: (error: Error, context: { phase: SyncPhase }) => void
}>

export function createMemoryDemoClient(options: BaseClientOptions & {
    seed?: DemoSeed
} = {}): DemoClient {
    const plugins: ClientPlugin[] = [
        memoryBackendPlugin(options.seed ? { seed: options.seed as unknown as Record<string, any[]> } : undefined)
    ]
    mountOptionalPlugins(plugins, options)
    return buildClient(plugins)
}

export function createHttpDemoClient(options: BaseClientOptions & {
    baseURL: string
    fetchFn: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    disableBatch?: boolean
}): DemoClient {
    const plugins: ClientPlugin[] = [
        atomaServerBackendPlugin({
            baseURL: options.baseURL,
            fetchFn: options.fetchFn,
            batch: options.disableBatch === false ? undefined : { enabled: false }
        })
    ]
    mountOptionalPlugins(plugins, options)
    return buildClient(plugins)
}

function mountOptionalPlugins(plugins: ClientPlugin[], options: BaseClientOptions): void {
    if (options.enableHistory !== false) {
        plugins.push(historyPlugin())
    }

    if (options.enableSync) {
        plugins.push(syncPlugin({
            mode: options.syncMode ?? 'full',
            resources: options.syncResources ?? ['users', 'posts', 'comments'],
            onEvent: options.onSyncEvent,
            onError: options.onSyncError
        }))
    }
}

function buildClient(plugins: ClientPlugin[]): DemoClient {
    return createClient<DemoEntities, DemoSchema>({
        stores: {
            schema: demoSchema
        },
        plugins
    }) as DemoClient
}
