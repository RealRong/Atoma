import { SYNC_SSE_EVENT_CHANGES } from './types'
import type { AtomaChange, SyncPullResponse, SyncPushOp, SyncPushRequest, SyncSubscribeEvent } from './types'

export function pushRequest(args: {
    ops: SyncPushOp[]
    deviceId?: string
    traceId?: string
    requestId?: string
}): SyncPushRequest {
    const deviceId = typeof args.deviceId === 'string' && args.deviceId ? args.deviceId : undefined
    const traceId = typeof args.traceId === 'string' && args.traceId ? args.traceId : undefined
    const requestId = typeof args.requestId === 'string' && args.requestId ? args.requestId : undefined

    return {
        ...(deviceId ? { deviceId } : {}),
        ...(traceId ? { traceId } : {}),
        ...(requestId ? { requestId } : {}),
        ops: Array.isArray(args.ops) ? args.ops : []
    }
}

export function subscribeEvent(args: { cursor: number; changes: AtomaChange[] }): SyncSubscribeEvent {
    return {
        cursor: args.cursor,
        changes: Array.isArray(args.changes) ? args.changes : []
    }
}

export function pullResponse(args: { nextCursor: number; changes: AtomaChange[] }): SyncPullResponse {
    return {
        nextCursor: args.nextCursor,
        changes: Array.isArray(args.changes) ? args.changes : []
    }
}

export function sseChangesFrame(event: SyncSubscribeEvent) {
    return {
        event: SYNC_SSE_EVENT_CHANGES,
        data: event
    }
}
