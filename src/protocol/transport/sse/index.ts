import { SSE_EVENT_NOTIFY } from './constants'
import * as sseFormat from './format'
import * as sseParse from './parse'

export const sse = {
    events: {
        NOTIFY: SSE_EVENT_NOTIFY
    },
    format: {
        comment: sseFormat.sseComment,
        retry: sseFormat.sseRetry,
        event: sseFormat.sseEvent,
        notify: sseFormat.sseNotify
    },
    parse: {
        notifyMessage: sseParse.parseNotifyMessage,
        notifyMessageJson: sseParse.parseNotifyMessageJson
    }
} as const

export { SSE_EVENT_NOTIFY } from './constants'
