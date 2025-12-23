import { SSE_EVENT_CHANGES } from './constants'
import * as sseFormat from './format'
import * as sseParse from './parse'

export const sse = {
    events: {
        CHANGES: SSE_EVENT_CHANGES
    },
    format: {
        comment: sseFormat.sseComment,
        retry: sseFormat.sseRetry,
        event: sseFormat.sseEvent,
        changes: sseFormat.sseChanges
    },
    parse: {
        changeBatch: sseParse.parseChangeBatch,
        changeBatchJson: sseParse.parseChangeBatchJson
    }
} as const

export { SSE_EVENT_CHANGES } from './constants'
