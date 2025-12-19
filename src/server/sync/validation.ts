import { throwError } from '../error'
import { Protocol } from '../../protocol'

export type {
    SyncPushOp,
    SyncPushRequest,
    SyncPushAck,
    SyncPushReject,
    SyncPushResponse
} from '../../protocol/sync'

export function validateSyncPullQuery(args: { cursor: any; limit: any; defaultLimit: number; maxLimit: number }) {
    const res = Protocol.sync.validate.pullQuery(args)
    if (res.ok) return res.value
    throwError(res.error.code, res.error.message, (res.error as any).details)
}

export function validateSyncSubscribeQuery(args: { cursor: any }) {
    const res = Protocol.sync.validate.subscribeQuery(args)
    if (res.ok) return res.value
    throwError(res.error.code, res.error.message, (res.error as any).details)
}

export function validateSyncPushRequest(body: any) {
    const res = Protocol.sync.validate.pushRequest(body)
    if (res.ok) return res.value
    throwError(res.error.code, res.error.message, (res.error as any).details)
}
