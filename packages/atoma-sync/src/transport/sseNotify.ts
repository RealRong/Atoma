import { Protocol } from 'atoma/protocol'
import type { NotifyMessage } from '#sync/types'

export function subscribeNotifySse(args: {
    resources?: string[]
    buildUrl: (args: { resources?: string[] }) => string
    connect?: (url: string) => EventSource
    eventName?: string
    onMessage: (msg: NotifyMessage) => void
    onError: (error: unknown) => void
    signal?: AbortSignal
}): { close: () => void } {
    const url = args.buildUrl({ resources: args.resources })
    const connect = args.connect

    let eventSource: EventSource
    if (connect) {
        eventSource = connect(url)
    } else if (typeof EventSource !== 'undefined') {
        eventSource = new EventSource(url)
    } else {
        throw new Error('[Sync] EventSource not available and no connect provided')
    }

    const eventName = args.eventName ?? Protocol.sse.events.NOTIFY

    eventSource.addEventListener(eventName, (event: any) => {
        try {
            const msg = Protocol.sse.parse.notifyMessage(String(event.data))
            args.onMessage(msg)
        } catch (error) {
            args.onError(error)
        }
    })

    eventSource.onerror = (error) => {
        args.onError(error)
    }

    if (args.signal) {
        const signal = args.signal
        if (signal.aborted) {
            eventSource.close()
        } else {
            const onAbort = () => {
                try {
                    eventSource.close()
                } catch {
                    // ignore
                }
            }
            signal.addEventListener('abort', onAbort, { once: true })
        }
    }

    return {
        close: () => eventSource.close()
    }
}
