import type { AtomaChange } from '../../protocol/sync'
import { throwError, toStandardError, errorStatus } from '../error'
import type { IOrmAdapter, StandardError as StandardErrorType } from '../types'
import type { ISyncAdapter } from '../sync/types'
import type { StoredWriteReplay, WriteKind } from './types'

type OkReplay = Extract<StoredWriteReplay, { kind: 'ok' }>
type ErrorReplay = Extract<StoredWriteReplay, { kind: 'error' }>

type ExecuteArgs = {
    orm: IOrmAdapter
    sync?: ISyncAdapter
    tx?: unknown
    idempotencyTtlMs?: number
    syncEnabled: boolean
    now?: () => number
    meta?: { traceId?: string; requestId?: string; opId?: string }
    write: {
        kind: WriteKind
        resource: string
        idempotencyKey?: string
        id?: unknown
        data?: unknown
        patches?: any[]
        baseVersion?: number
        timestamp?: number
    }
}

export type ExecuteWriteItemResult =
    | {
        ok: true
        status: 200
        data?: unknown
        replay: OkReplay
        change?: AtomaChange
    }
    | {
        ok: false
        status: number
        error: StandardErrorType
        replay: ErrorReplay
    }

function normalizeId(value: unknown): string {
    if (typeof value === 'string') return value
    if (typeof value === 'number' && Number.isFinite(value)) return String(value)
    if (value === null || value === undefined) return ''
    return String(value)
}

function extractConflictMeta(error: StandardErrorType) {
    const details = (error as any)?.details
    const currentValue = details && typeof details === 'object' ? (details as any).currentValue : undefined
    const currentVersion = details && typeof details === 'object' ? (details as any).currentVersion : undefined
    return {
        ...(currentValue !== undefined ? { currentValue } : {}),
        ...(typeof currentVersion === 'number' ? { currentVersion } : {})
    }
}

export async function executeWriteItemWithSemantics(args: ExecuteArgs): Promise<ExecuteWriteItemResult> {
    const now = args.now ?? (() => Date.now())
    const { orm, sync, tx, write } = args
    const idempotencyKey = typeof write.idempotencyKey === 'string' && write.idempotencyKey ? write.idempotencyKey : undefined

    if (args.syncEnabled) {
        if (!sync) {
            throw new Error('executeWriteItemWithSemantics requires sync adapter when syncEnabled=true')
        }
    }

    const readIdempotency = async (): Promise<StoredWriteReplay | undefined> => {
        if (!args.syncEnabled) return undefined
        if (!idempotencyKey) return undefined
        const hit = await sync!.getIdempotency(idempotencyKey, tx)
        if (!hit.hit) return undefined
        const body = hit.body
        if (!body || typeof body !== 'object') return undefined
        const kind = (body as any).kind
        if (kind !== 'write') return undefined
        const value = (body as any).value
        if (!value || typeof value !== 'object') return undefined
        if ((value as any).kind !== 'ok' && (value as any).kind !== 'error') return undefined
        return value as StoredWriteReplay
    }

    const writeIdempotency = async (replay: StoredWriteReplay, status: number) => {
        if (!args.syncEnabled) return
        if (!idempotencyKey) return
        await sync!.putIdempotency(
            idempotencyKey,
            { status, body: { kind: 'write', value: replay } },
            args.idempotencyTtlMs,
            tx
        )
    }

    const replayHit = await readIdempotency()
    if (replayHit) {
        if (replayHit.kind === 'ok') {
            return {
                ok: true,
                status: 200,
                data: replayHit.data,
                replay: replayHit as OkReplay
            }
        }
        return {
            ok: false,
            status: errorStatus(replayHit.error),
            error: replayHit.error,
            replay: replayHit as ErrorReplay
        }
    }

    try {
        const changedAt = now()

        if (write.kind === 'create') {
            if (typeof orm.create !== 'function' && typeof (orm as any).bulkCreate !== 'function') {
                throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement create', { kind: 'adapter' })
            }

            const data = write.data && typeof write.data === 'object' ? { ...(write.data as any) } : {}
            if (write.id !== undefined) (data as any).id = write.id
            if (typeof (data as any).version !== 'number') (data as any).version = 1

            const row = await (async () => {
                if (typeof orm.create === 'function') {
                    const res = await orm.create(write.resource, data, { returning: true } as any)
                    if (res?.error) throw res.error
                    return res?.data
                }
                const res = await (orm as any).bulkCreate(write.resource, [data], { returning: true } as any)
                const first = Array.isArray(res?.data) ? res.data[0] : undefined
                if (Array.isArray(res?.partialFailures) && res.partialFailures.length) {
                    throw res.partialFailures[0]?.error ?? new Error('bulkCreate failed')
                }
                return first
            })()

            const id = normalizeId((row as any)?.id ?? (data as any).id)
            if (!id) {
                throwError('INVALID_WRITE', 'Missing id from create result', { kind: 'adapter', resource: write.resource })
            }
            const serverVersion = typeof (row as any)?.version === 'number' ? (row as any).version : 1

            let change: AtomaChange | undefined
            if (args.syncEnabled) {
                change = await sync!.appendChange({
                    resource: write.resource,
                    id,
                    kind: 'upsert',
                    serverVersion,
                    changedAt
                }, tx)
            }

            const replay: OkReplay = {
                kind: 'ok',
                resource: write.resource,
                id,
                changeKind: 'upsert',
                serverVersion,
                ...(change ? { cursor: change.cursor } : {}),
                data: row ?? data
            }
            await writeIdempotency(replay, 200)
            return { ok: true, status: 200, data: replay.data, replay, ...(change ? { change } : {}) }
        }

        if (write.kind === 'patch') {
            if (typeof orm.patch !== 'function') {
                throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement patch', { kind: 'adapter' })
            }
            if (write.id === undefined) {
                throwError('INVALID_WRITE', 'Missing id for patch', { kind: 'validation', resource: write.resource })
            }
            if (typeof write.baseVersion !== 'number' || !Number.isFinite(write.baseVersion)) {
                throwError('INVALID_WRITE', 'Missing baseVersion for patch', { kind: 'validation', resource: write.resource })
            }
            const res = await orm.patch(
                write.resource,
                { id: write.id, patches: write.patches ?? [], baseVersion: write.baseVersion, timestamp: write.timestamp } as any,
                { returning: true } as any
            )
            if (res?.error) throw res.error

            const row = res?.data
            const id = normalizeId((row as any)?.id ?? write.id)
            const serverVersion = typeof (row as any)?.version === 'number'
                ? (row as any).version
                : write.baseVersion + 1

            let change: AtomaChange | undefined
            if (args.syncEnabled) {
                change = await sync!.appendChange({
                    resource: write.resource,
                    id,
                    kind: 'upsert',
                    serverVersion,
                    changedAt
                }, tx)
            }

            const replay: OkReplay = {
                kind: 'ok',
                resource: write.resource,
                id,
                changeKind: 'upsert',
                serverVersion,
                ...(change ? { cursor: change.cursor } : {}),
                data: row
            }
            await writeIdempotency(replay, 200)
            return { ok: true, status: 200, data: replay.data, replay, ...(change ? { change } : {}) }
        }

        if (write.kind === 'delete') {
            if (typeof orm.delete !== 'function') {
                throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement delete', { kind: 'adapter' })
            }
            if (write.id === undefined) {
                throwError('INVALID_WRITE', 'Missing id for delete', { kind: 'validation', resource: write.resource })
            }
            if (typeof write.baseVersion !== 'number' || !Number.isFinite(write.baseVersion)) {
                throwError('INVALID_WRITE', 'Missing baseVersion for delete', { kind: 'validation', resource: write.resource })
            }

            const res = await orm.delete(write.resource, { id: write.id, baseVersion: write.baseVersion } as any, { returning: false } as any)
            if (res?.error) throw res.error

            const id = normalizeId(write.id)
            const serverVersion = write.baseVersion + 1

            let change: AtomaChange | undefined
            if (args.syncEnabled) {
                change = await sync!.appendChange({
                    resource: write.resource,
                    id,
                    kind: 'delete',
                    serverVersion,
                    changedAt
                }, tx)
            }

            const replay: OkReplay = {
                kind: 'ok',
                resource: write.resource,
                id,
                changeKind: 'delete',
                serverVersion,
                ...(change ? { cursor: change.cursor } : {})
            }
            await writeIdempotency(replay, 200)
            return { ok: true, status: 200, replay, ...(change ? { change } : {}) }
        }

        throwError('INVALID_WRITE', 'Unsupported write kind', { kind: 'validation', resource: write.resource })
    } catch (err: any) {
        const standard = toStandardError(err, 'WRITE_FAILED')
        const status = errorStatus(standard)
        const replay: ErrorReplay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
        await writeIdempotency(replay, status)
        return { ok: false, status, error: standard, replay }
    }
}
