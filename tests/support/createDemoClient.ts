import { createClient } from 'atoma-client'
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

export async function createLocalDemoClient(options: BaseClientOptions & {
    seed?: DemoSeed
} = {}): Promise<DemoClient> {
    const plugins: ClientPlugin[] = []
    mountOptionalPlugins(plugins, options)
    const client = buildClient(plugins)

    try {
        if (options.seed) {
            await seedClientData(client, options.seed)
        }
    } catch (error) {
        client.dispose()
        throw error
    }

    return client
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

function ensureWriteManyOk(
    label: string,
    results: Array<{
        index: number
        ok: boolean
        error?: unknown
    }>
): void {
    const failed = results.find((result) => !result.ok)
    if (!failed) return
    const reason = failed.error instanceof Error
        ? failed.error.message
        : String(failed.error ?? 'unknown')
    throw new Error(`[Atoma][demo-seed] ${label} failed at index=${failed.index}: ${reason}`)
}

async function seedClientData(client: DemoClient, seed: DemoSeed): Promise<void> {
    ensureWriteManyOk('users', await client.stores('users').createMany(seed.users))
    ensureWriteManyOk('posts', await client.stores('posts').createMany(seed.posts))
    ensureWriteManyOk('comments', await client.stores('comments').createMany(seed.comments))
}
