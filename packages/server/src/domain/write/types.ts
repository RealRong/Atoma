import type { StandardError as StandardErrorType, WriteOptions } from '@atoma-js/types/protocol'
import type { AtomaChange, IOrmAdapter, ISyncAdapter } from '../../adapters/ports'
import type { AtomaServerLogger } from '../../logger'
import type { ErrorWriteReplay, OkWriteReplay } from './idempotency'

export type WriteKind = 'create' | 'update' | 'delete' | 'upsert'

export type WriteInput = {
    kind: WriteKind
    resource: string
    idempotencyKey?: string
    id?: unknown
    data?: unknown
    baseVersion?: number
    expectedVersion?: number
    options?: WriteOptions
}

export type ExecuteWriteItemArgs = {
    orm: IOrmAdapter
    sync?: ISyncAdapter
    tx?: unknown
    idempotencyTtlMs?: number
    syncEnabled: boolean
    now?: () => number
    meta?: { traceId?: string; requestId?: string; opId?: string }
    logger?: AtomaServerLogger
    write: WriteInput
}

export type ExecuteWriteItemResult =
    | {
        ok: true
        status: 200
        data?: unknown
        replay: OkWriteReplay
        change?: AtomaChange
    }
    | {
        ok: false
        status: number
        error: StandardErrorType
        replay: ErrorWriteReplay
    }

export type WriteContext = {
    orm: IOrmAdapter
    sync?: ISyncAdapter
    tx?: unknown
    syncEnabled: boolean
    changedAt: number
    write: WriteInput
    options: WriteOptions
    internalSelect?: Record<string, boolean>
    returningRequested: boolean
}

export type WriteSuccess = {
    replay: OkWriteReplay
    data?: unknown
    change?: AtomaChange
}
