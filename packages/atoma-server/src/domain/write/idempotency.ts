import type { ChangeKind, StandardError as StandardErrorType } from 'atoma-types/protocol'
import type { ISyncAdapter } from '../../adapters/ports'
import { throwError } from '../../error'
import { normalizeId } from '../../shared/utils/id'

export type StoredWriteReplay =
    | {
        kind: 'ok'
        resource: string
        id: string
        changeKind: ChangeKind
        serverVersion: number
        cursor?: number
        data?: unknown
    }
    | {
        kind: 'error'
        error: StandardErrorType
        currentValue?: unknown
        currentVersion?: number
    }

export type OkWriteReplay = Extract<StoredWriteReplay, { kind: 'ok' }>
export type ErrorWriteReplay = Extract<StoredWriteReplay, { kind: 'error' }>

function readStoredWriteReplay(value: unknown): StoredWriteReplay | undefined {
    if (!value || typeof value !== 'object') return undefined
    const kind = (value as any).kind
    if (kind !== 'write') return undefined

    const replay = (value as any).value
    if (!replay || typeof replay !== 'object') return undefined
    const replayKind = (replay as any).kind
    if (replayKind !== 'ok' && replayKind !== 'error') return undefined
    return replay as StoredWriteReplay
}

async function readReplayFromStorage(args: {
    syncEnabled: boolean
    sync?: ISyncAdapter
    tx?: unknown
    idempotencyKey?: string
}): Promise<StoredWriteReplay | undefined> {
    if (!args.syncEnabled || !args.idempotencyKey) return undefined
    const hit = await args.sync!.getIdempotency(args.idempotencyKey, args.tx)
    if (!hit.hit) return undefined
    return readStoredWriteReplay(hit.body)
}

export async function claimWriteReplayOrAcquire(args: {
    syncEnabled: boolean
    sync?: ISyncAdapter
    tx?: unknown
    idempotencyKey?: string
    idempotencyTtlMs?: number
    resource: string
    id?: unknown
}): Promise<StoredWriteReplay | true> {
    if (!args.syncEnabled || !args.idempotencyKey) return true

    const claim = await args.sync!.claimIdempotency(
        args.idempotencyKey,
        { status: 102, body: { kind: 'pending' } },
        args.idempotencyTtlMs,
        args.tx
    )
    if (claim.acquired) return true

    const replayFromClaim = readStoredWriteReplay(claim.body)
    if (replayFromClaim) return replayFromClaim

    for (let attempt = 0; attempt < 5; attempt += 1) {
        await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
        const replay = await readReplayFromStorage(args)
        if (replay) return replay
    }

    throwError('CONFLICT', 'Idempotency key is in progress', {
        kind: 'conflict',
        resource: args.resource,
        ...(args.id !== undefined ? { id: normalizeId(args.id) } : {})
    } as any)
}

export async function storeWriteReplay(args: {
    syncEnabled: boolean
    sync?: ISyncAdapter
    tx?: unknown
    idempotencyKey?: string
    idempotencyTtlMs?: number
    replay: StoredWriteReplay
    status: number
}): Promise<void> {
    if (!args.syncEnabled || !args.idempotencyKey) return

    await args.sync!.putIdempotency(
        args.idempotencyKey,
        { status: args.status, body: { kind: 'write', value: args.replay } },
        args.idempotencyTtlMs,
        args.tx
    )
}
