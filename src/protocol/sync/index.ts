import * as syncCompose from './compose'
import * as syncFormat from './format'
import * as syncValidate from './validate'

export const sync = {
    compose: {
        pushRequest: syncCompose.pushRequest,
        subscribeEvent: syncCompose.subscribeEvent,
        pullResponse: syncCompose.pullResponse
    },
    validate: {
        pullQuery: syncValidate.validatePullQuery,
        subscribeQuery: syncValidate.validateSubscribeQuery,
        pushRequest: syncValidate.validatePushRequest
    },
    format: {
        sseEvent: syncFormat.sseEvent,
        sseRetry: syncFormat.sseRetry,
        sseComment: syncFormat.sseComment,
        sseChanges: syncFormat.sseChanges
    }
} as const

export { SYNC_SSE_EVENT_CHANGES } from './types'

export type {
    AtomaChange,
    ChangeKind,
    AtomaPatch,
    SyncPushOp,
    SyncPushRequest,
    SyncPushAck,
    SyncPushReject,
    SyncPushResponse,
    SyncPullResponse,
    SyncSubscribeEvent
} from './types'
