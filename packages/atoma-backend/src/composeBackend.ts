import type { Backend, BackendEndpoint } from 'atoma/backend'

export type ComposeBackendOptions = Readonly<{
    key: string
    store: Backend | BackendEndpoint
    remote?: Backend | BackendEndpoint
}>

function asStoreEndpoint(value: Backend | BackendEndpoint): BackendEndpoint {
    if ((value as any)?.opsClient) return value as BackendEndpoint
    return (value as Backend).store
}

function asRemoteEndpoint(value: Backend | BackendEndpoint): BackendEndpoint {
    if ((value as any)?.opsClient) return value as BackendEndpoint
    const b = value as Backend
    return b.remote ?? b.store
}

function asBackend(value: Backend | BackendEndpoint): Backend | undefined {
    if ((value as any)?.store) return value as Backend
    return undefined
}

export function composeBackend(options: ComposeBackendOptions): Backend {
    const key = String(options.key ?? '').trim()
    if (!key) throw new Error('[Atoma] composeBackend: key 必填')

    const storeEndpoint = asStoreEndpoint(options.store)
    const remoteEndpoint = options.remote ? asRemoteEndpoint(options.remote) : undefined

    const storeBackend = asBackend(options.store)
    const remoteBackend = options.remote ? asBackend(options.remote) : undefined

    return {
        key,
        store: storeEndpoint,
        ...(remoteEndpoint ? { remote: remoteEndpoint } : {}),
        capabilities: {
            storePersistence: storeBackend?.capabilities?.storePersistence ?? 'ephemeral'
        },
        dispose: async () => {
            try {
                await storeBackend?.dispose?.()
            } finally {
                await remoteBackend?.dispose?.()
            }
        }
    }
}

