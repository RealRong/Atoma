import { Protocol } from '#protocol'
import { url as urlUtils } from '#shared'
import { HttpOpsClient, type HttpOpsClientConfig } from './ops/http/HttpOpsClient'
import type { Backend, BackendEndpoint, NotifyClient } from './types'

export type CreateHttpBackendOptions = Readonly<{
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

function normalizeBaseUrl(baseURL: string): string {
    const url = String(baseURL ?? '').trim()
    if (!url) throw new Error('[Atoma] createHttpBackend: baseURL 必填')
    return url
}

function createHttpNotifyClient(args: {
    baseURL: string
    notify?: CreateHttpBackendOptions['notify']
}): NotifyClient | undefined {
    const notify = args.notify
    const enabled = (typeof notify === 'undefined') ? true : Boolean(notify)
    if (!enabled) return undefined

    const cfg = (notify && typeof notify === 'object') ? notify : undefined
    const buildUrl = cfg?.buildUrl
        ? cfg.buildUrl
        : (args2?: { resources?: string[] }) => urlUtils.withResourcesParam(
            urlUtils.resolveUrl(args.baseURL, cfg?.path ?? Protocol.http.paths.SYNC_SUBSCRIBE),
            args2?.resources
        )

    return {
        subscribe: (args2) => {
            const url = buildUrl({ resources: args2.resources })

            let es: EventSource
            const connect = cfg?.connect
            if (connect) es = connect(url)
            else if (typeof EventSource !== 'undefined') es = new EventSource(url)
            else throw new Error('[Atoma] notify.subscribe: EventSource not available and no connect provided')

            const eventName = Protocol.sse.events.NOTIFY

            es.addEventListener(eventName, (event: any) => {
                try {
                    const msg = Protocol.sse.parse.notifyMessage(String(event.data))
                    args2.onMessage(msg as any)
                } catch (err) {
                    args2.onError(err)
                }
            })
            es.onerror = (err) => {
                args2.onError(err)
            }

            if (args2.signal) {
                const signal = args2.signal
                if (signal.aborted) {
                    try { es.close() } catch {}
                } else {
                    const onAbort = () => {
                        try { es.close() } catch {}
                    }
                    signal.addEventListener('abort', onAbort, { once: true })
                }
            }

            return { close: () => es.close() }
        }
    }
}

export function createHttpBackend(options: CreateHttpBackendOptions): Backend {
    const baseURL = normalizeBaseUrl(options.baseURL)
    const key = (typeof options.key === 'string' && options.key.trim()) ? options.key.trim() : baseURL

    const opsClient = new HttpOpsClient({
        baseURL,
        opsPath: options.opsPath,
        headers: options.headers,
        retry: options.retry,
        fetchFn: options.fetchFn,
        interceptors: {
            onRequest: options.onRequest,
            onResponse: options.onResponse,
            responseParser: options.responseParser
        },
        batch: options.batch
    })

    const notify = createHttpNotifyClient({ baseURL, notify: options.notify })

    const endpoint: BackendEndpoint = {
        opsClient,
        ...(notify ? { notify } : {})
    }

    const storePersistence = (options.storePersistence ?? 'remote') as NonNullable<Backend['capabilities']>['storePersistence']

    return {
        key,
        store: endpoint,
        remote: endpoint,
        capabilities: {
            storePersistence
        }
    }
}
