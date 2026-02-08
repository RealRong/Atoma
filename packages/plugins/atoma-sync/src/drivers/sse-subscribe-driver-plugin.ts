import { HTTP_PATH_SYNC_SUBSCRIBE, SSE_EVENT_NOTIFY, parseNotifyMessage } from 'atoma-types/protocol-tools'
import type { ClientPlugin, ClientPluginContext } from 'atoma-types/client'
import type { NotifyMessage, SyncSubscribeDriver } from 'atoma-types/sync'
import { getSyncSubscribeDriver, registerSyncSubscribeDriver } from '#sync/capabilities'

type HeadersInput = () => Promise<Record<string, string>> | Record<string, string>

export type SseSubscribeDriverPluginOptions = Readonly<{
    /** Base URL for subscribe endpoint (e.g. https://api.example.com). */
    baseURL?: string
    /** Full subscribe URL override. */
    url?: string
    /** Subscribe path (default: HTTP_PATH_SYNC_SUBSCRIBE). */
    path?: string
    /** Optional headers (for fetch-based SSE). */
    headers?: HeadersInput
    /** Optional custom fetch. */
    fetchFn?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>
    /** Use credentials when EventSource is used. */
    withCredentials?: boolean
    /** Optional EventSource factory (for environments without global EventSource or custom headers). */
    eventSourceFactory?: (url: string, init?: { withCredentials?: boolean }) => EventSourceLike
    /** Custom notify message parser. */
    parse?: (data: string) => NotifyMessage
    /** Overwrite existing sync.subscribe if present. */
    overwrite?: boolean
}>

type EventSourceLike = {
    addEventListener: (type: string, listener: (ev: MessageEvent) => void) => void
    removeEventListener: (type: string, listener: (ev: MessageEvent) => void) => void
    close: () => void
    onerror?: ((ev: Event) => void) | null
}

export function sseSubscribeDriverPlugin(options: SseSubscribeDriverPluginOptions = {}): ClientPlugin {
    return {
        id: 'sync.subscribe:sse',
        init: (ctx: ClientPluginContext) => {
            if (!options?.overwrite && getSyncSubscribeDriver(ctx)) return

            const driver: SyncSubscribeDriver = {
                subscribe: (args) => {
                    const url = buildSubscribeUrl(options, args.resources)
                    const closeHandlers: Array<() => void> = []
                    const controller = new AbortController()

                    const onAbort = () => {
                        try {
                            controller.abort()
                        } catch {
                            // ignore
                        }
                    }

                    if (args.signal) {
                        if (args.signal.aborted) onAbort()
                        else args.signal.addEventListener('abort', onAbort, { once: true })
                        closeHandlers.push(() => {
                            try {
                                args.signal?.removeEventListener('abort', onAbort)
                            } catch {
                                // ignore
                            }
                        })
                    }

                    const run = tryUseEventSource(options, url, args, controller, closeHandlers)
                        ?? runFetchStream(options, url, args, controller, closeHandlers)

                    void run.catch((error) => {
                        if (!controller.signal.aborted) {
                            args.onError(error)
                        }
                    })

                    return {
                        close: () => {
                            for (const fn of closeHandlers) {
                                try {
                                    fn()
                                } catch {
                                    // ignore
                                }
                            }
                            onAbort()
                        }
                    }
                }
            }

            const unregister = registerSyncSubscribeDriver(ctx, driver)

            return {
                dispose: () => {
                    try {
                        unregister?.()
                    } catch {
                        // ignore
                    }
                }
            }
        }
    }
}

function buildSubscribeUrl(options: SseSubscribeDriverPluginOptions, resources?: string[]): string {
    const url = options.url ? String(options.url).trim() : ''
    const baseURL = options.baseURL ? String(options.baseURL).trim() : ''
    const path = typeof options.path === 'string' && options.path.trim()
        ? options.path.trim()
        : HTTP_PATH_SYNC_SUBSCRIBE

    if (!url && !baseURL) throw new Error('[Sync] subscribe url missing')

    const full = url || joinUrl(baseURL, path)
    const out = new URL(full)
    if (Array.isArray(resources) && resources.length) {
        for (const r of resources) {
            if (typeof r === 'string' && r.trim()) {
                out.searchParams.append('resources', r.trim())
            }
        }
    }
    return out.toString()
}

function joinUrl(base: string, path: string): string {
    if (!base) return path
    if (!path) return base

    const hasTrailing = base.endsWith('/')
    const hasLeading = path.startsWith('/')

    if (hasTrailing && hasLeading) return `${base}${path.slice(1)}`
    if (!hasTrailing && !hasLeading) return `${base}/${path}`
    return `${base}${path}`
}

function tryUseEventSource(
    options: SseSubscribeDriverPluginOptions,
    url: string,
    args: { onMessage: (msg: NotifyMessage) => void; onError: (error: unknown) => void; signal?: AbortSignal },
    controller: AbortController,
    closeHandlers: Array<() => void>
): Promise<void> | null {
    const factory = options.eventSourceFactory
        ?? (typeof EventSource !== 'undefined'
            ? ((u: string, init?: { withCredentials?: boolean }) => new EventSource(u, init) as EventSourceLike)
            : undefined)

    if (!factory) return null
    if (options.headers) return null

    const eventName = SSE_EVENT_NOTIFY
    const parse = options.parse ?? ((data: string) => parseNotifyMessage(data))
    const es = factory(url, { withCredentials: options.withCredentials })

    const onMessage = (ev: MessageEvent) => {
        if (controller.signal.aborted) return
        try {
            const msg = parse(String((ev as any).data ?? ''))
            args.onMessage(msg)
        } catch (error) {
            args.onError(error)
        }
    }

    const onError = (ev: Event) => {
        if (controller.signal.aborted) return
        args.onError(ev)
    }

    es.addEventListener(eventName, onMessage as any)
    es.onerror = onError

    const close = () => {
        try {
            es.removeEventListener(eventName, onMessage as any)
        } catch {
            // ignore
        }
        try {
            es.close()
        } catch {
            // ignore
        }
    }

    closeHandlers.push(close)

    return new Promise((resolve) => {
        const onAbort = () => {
            close()
            resolve()
        }
        controller.signal.addEventListener('abort', onAbort, { once: true })
        closeHandlers.push(() => {
            try {
                controller.signal.removeEventListener('abort', onAbort)
            } catch {
                // ignore
            }
        })
        if (controller.signal.aborted) resolve()
    })
}

async function runFetchStream(
    options: SseSubscribeDriverPluginOptions,
    url: string,
    args: { onMessage: (msg: NotifyMessage) => void; onError: (error: unknown) => void; signal?: AbortSignal },
    controller: AbortController,
    closeHandlers: Array<() => void>
): Promise<void> {
    const parse = options.parse ?? ((data: string) => parseNotifyMessage(data))
    const fetchFn = options.fetchFn ?? fetch.bind(globalThis)
    const headers = await resolveHeaders(options.headers)
    const reqHeaders = {
        accept: 'text/event-stream',
        ...headers
    }

    const onAbort = () => {
        try {
            controller.abort()
        } catch {
            // ignore
        }
    }
    closeHandlers.push(() => {
        try {
            controller.abort()
        } catch {
            // ignore
        }
    })
    if (args.signal) {
        if (args.signal.aborted) onAbort()
        else args.signal.addEventListener('abort', onAbort, { once: true })
        closeHandlers.push(() => {
            try {
                args.signal?.removeEventListener('abort', onAbort)
            } catch {
                // ignore
            }
        })
    }

    const res = await fetchFn(url, {
        method: 'GET',
        headers: reqHeaders,
        signal: controller.signal
    })

    if (!res.ok) {
        throw new Error(`[Sync] subscribe failed: ${res.status}`)
    }

    const reader = res.body?.getReader()
    if (!reader) {
        throw new Error('[Sync] subscribe failed: missing response body')
    }

    const decoder = new TextDecoder()
    let buffer = ''
    let eventName: string | undefined
    let dataLines: string[] = []

    const dispatch = () => {
        if (!dataLines.length) {
            eventName = undefined
            return
        }
        const data = dataLines.join('\n')
        dataLines = []
        const name = eventName
        eventName = undefined
        if (name && name !== SSE_EVENT_NOTIFY) return
        try {
            const msg = parse(data)
            args.onMessage(msg)
        } catch (error) {
            args.onError(error)
        }
    }

    while (true) {
        if (controller.signal.aborted) return
        const { value, done } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })

        let idx = buffer.indexOf('\n')
        while (idx >= 0) {
            const line = buffer.slice(0, idx).replace(/\r$/, '')
            buffer = buffer.slice(idx + 1)

            if (!line) {
                dispatch()
            } else if (line.startsWith(':')) {
                // comment/heartbeat
            } else if (line.startsWith('event:')) {
                eventName = line.slice(6).trim()
            } else if (line.startsWith('data:')) {
                dataLines.push(line.slice(5).trimStart())
            }

            idx = buffer.indexOf('\n')
        }
    }

    if (!controller.signal.aborted) {
        throw new Error('[Sync] subscribe closed')
    }
}

async function resolveHeaders(input?: HeadersInput): Promise<Record<string, string>> {
    if (!input) return {}
    if (typeof input === 'function') {
        const res = input()
        return res instanceof Promise ? await res : res
    }
    return input
}
