export const SYNC_SSE_EVENT_CHANGES = 'changes'

export type ChangeKind = 'upsert' | 'delete'

export type AtomaChange = {
    cursor: number
    resource: string
    id: string
    kind: ChangeKind
    serverVersion: number
    changedAt: number
}

export type AtomaPatch = {
    op: string
    path: Array<string | number>
    value?: unknown
}

export type SyncPushOp =
    | {
        opId?: string
        idempotencyKey: string
        resource: string
        kind: 'create'
        id?: unknown
        timestamp?: number
        data: unknown
    }
    | {
        opId?: string
        idempotencyKey: string
        resource: string
        kind: 'patch'
        id: unknown
        baseVersion: number
        timestamp?: number
        patches: AtomaPatch[]
    }
    | {
        opId?: string
        idempotencyKey: string
        resource: string
        kind: 'delete'
        id: unknown
        baseVersion: number
        timestamp?: number
    }

export type SyncPushRequest = {
    deviceId?: string
    traceId?: string
    requestId?: string
    ops: SyncPushOp[]
}

export type SyncPushAck = {
    idempotencyKey: string
    resource: string
    id: string
    serverVersion: number
}

export type SyncPushReject = {
    idempotencyKey: string
    error: unknown
    currentValue?: unknown
    currentVersion?: number
}

export type SyncPushResponse = {
    serverCursor?: number
    acked: SyncPushAck[]
    rejected: SyncPushReject[]
}

export type SyncPullResponse = {
    nextCursor: number
    changes: AtomaChange[]
}

export type SyncSubscribeEvent = {
    cursor: number
    changes: AtomaChange[]
}

