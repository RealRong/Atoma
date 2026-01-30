import { ClientPlugin } from 'atoma-client'

export type WithSyncOptions = Readonly<{
    mode?: string
    resources?: string[]
    pull?: Readonly<{ intervalMs?: number }>
    push?: Readonly<{ maxItems?: number }>
    subscribe?: boolean | Readonly<{ reconnectDelayMs?: number }>
    policy?: Readonly<{
        retry?: Record<string, any>
        backoff?: Record<string, any>
    }>
}>

export type WithSyncExtension = Readonly<{
    sync: {
        start: (mode?: string) => void
        stop: () => void
        dispose: () => void
        status: () => { started: boolean; configured: boolean }
        pull: () => Promise<void>
        push: () => Promise<void>
        devtools: { snapshot: () => any; subscribe: (fn: (e: any) => void) => () => void }
    }
}>

class DisabledSyncPlugin extends ClientPlugin {
    readonly id = 'sync:disabled'

    setup(): void {
        throw new Error('[atoma-sync] 已迁移到新的插件架构，此包尚未完成适配')
    }
}

export function syncPlugin(_opts: WithSyncOptions): ClientPlugin {
    return new DisabledSyncPlugin()
}

export function withSync<TClient>(_client: TClient, _opts: WithSyncOptions): TClient {
    throw new Error('[atoma-sync] 已迁移到新的插件架构，请改用 createClient({ plugins: [...] })')
}
