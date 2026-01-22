import type { ChangeKind } from '#protocol'
import { errorStatus, throwError, toStandardError } from '../error'
import type { AtomaChange, IOrmAdapter, ISyncAdapter, StandardError as StandardErrorType } from '../adapters/ports'
import type { WriteOptions } from '#protocol'
import type { AtomaServerLogger } from '../logger'

export type WriteChangeSummary = {
    changedFields: string[]
    changedPaths?: Array<Array<string | number>>
}

export function summarizeCreateItem(item: unknown): WriteChangeSummary {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return { changedFields: [] }
    return { changedFields: Object.keys(item as any) }
}

export function summarizeUpdateData(data: unknown): WriteChangeSummary {
    if (!data || typeof data !== 'object' || Array.isArray(data)) return { changedFields: [] }
    return { changedFields: Object.keys(data as any) }
}

export type WriteKind = 'create' | 'update' | 'delete' | 'upsert'

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
    logger?: AtomaServerLogger
    write: {
        kind: WriteKind
        resource: string
        idempotencyKey?: string
        id?: unknown
        data?: unknown
        baseVersion?: number
        timestamp?: number
        options?: WriteOptions
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

function isPlainObject(value: any): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function serializeErrorForLog(error: unknown) {
    if (error instanceof Error) {
        const anyErr = error as any
        return {
            name: error.name,
            message: error.message,
            stack: error.stack,
            ...(anyErr?.cause !== undefined ? { cause: anyErr.cause } : {})
        }
    }
    return { value: error }
}

function ensureSelect(select: Record<string, boolean> | undefined, required: string[]): Record<string, boolean> | undefined {
    if (!select) return undefined
    const out: Record<string, boolean> = { ...select }
    required.forEach(key => { out[key] = true })
    return out
}

function requiredSelectFields(kind: WriteKind, args: { returningRequested: boolean }): string[] {
    if (kind === 'create') return ['id', 'version']
    if (kind === 'update') return ['version']
    if (kind === 'upsert') {
        // 即使 returning=false，我们也需要 version 来正确返回 WriteItemResult.version（尤其 loose upsert）
        return ['version']
    }
    return []
}

export async function executeWriteItemWithSemantics(args: ExecuteArgs): Promise<ExecuteWriteItemResult> {
    const now = args.now ?? (() => Date.now())
    const { orm, sync, tx, write } = args
    const idempotencyKey = typeof write.idempotencyKey === 'string' && write.idempotencyKey ? write.idempotencyKey : undefined
    const options: WriteOptions = (write.options && typeof write.options === 'object' && !Array.isArray(write.options))
        ? (write.options as WriteOptions)
        : {}
    const returningRequested = options.returning !== false
    const select = options.select
    const internalSelect = ensureSelect(
        isPlainObject(select) ? select : undefined,
        requiredSelectFields(write.kind, { returningRequested })
    )

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
            const v = (data as any).version
            if (!(typeof v === 'number' && Number.isFinite(v) && v >= 1)) (data as any).version = 1

            const row = await (async () => {
                if (typeof orm.create === 'function') {
                    const res = await orm.create(write.resource, data, { returning: true, ...(internalSelect ? { select: internalSelect } : {}) } as any)
                    if (res?.error) throw res.error
                    return res?.data
                }
                const res = await (orm as any).bulkCreate(write.resource, [data], { returning: true, ...(internalSelect ? { select: internalSelect } : {}) } as any)
                const r0 = res?.resultsByIndex?.[0]
                if (!r0) throw new Error('bulkCreate returned empty resultsByIndex')
                if (!r0.ok) throw r0.error
                return r0.data
            })()

            const expectedId = write.id !== undefined ? normalizeId(write.id) : ''
            const actualId = normalizeId((row as any)?.id)

            if (write.id !== undefined && actualId && expectedId && actualId !== expectedId) {
                throwError('INTERNAL', `Create returned mismatched id (expected=${expectedId}, actual=${actualId})`, {
                    kind: 'internal',
                    resource: write.resource
                })
            }

            if (write.id === undefined && !actualId) {
                throwError('INTERNAL', 'Create returned missing id', { kind: 'internal', resource: write.resource })
            }

            const id = write.id !== undefined
                ? expectedId
                : actualId
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
                data: row
            }
            await writeIdempotency(replay, 200)
            return { ok: true, status: 200, data: replay.data, replay, ...(change ? { change } : {}) }
        }

        if (write.kind === 'upsert') {
            if (typeof orm.upsert !== 'function') {
                throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement upsert', { kind: 'adapter' })
            }
            if (write.id === undefined) {
                throwError('INVALID_WRITE', 'Missing id for upsert', { kind: 'validation', resource: write.resource })
            }

            const mode: 'strict' | 'loose' = (options as any)?.upsert?.mode === 'loose' ? 'loose' : 'strict'
            const merge: boolean = options.merge !== false
            const id = normalizeId(write.id)

            const data = (write.data && typeof write.data === 'object' && !Array.isArray(write.data))
                ? { ...(write.data as any) }
                : {}

            // upsert 必须能产出 version（即使 options.returning=false），否则协议无法返回 version
            const res = await orm.upsert(
                write.resource,
                {
                    id,
                    data,
                    baseVersion: write.baseVersion,
                    timestamp: write.timestamp,
                    mode,
                    merge
                } as any,
                { ...options, returning: true, ...(internalSelect ? { select: internalSelect } : {}) } as any
            )
            if (res?.error) throw res.error

            const row = res?.data
            const rowVersion = typeof (row as any)?.version === 'number' ? (row as any).version : undefined
            const serverVersion = (() => {
                if (typeof rowVersion === 'number' && Number.isFinite(rowVersion) && rowVersion >= 1) return rowVersion
                if (typeof write.baseVersion === 'number' && Number.isFinite(write.baseVersion)) return write.baseVersion + 1
                if (mode === 'strict') return 1
                throwError('INTERNAL', 'Upsert returned missing version', { kind: 'internal', resource: write.resource })
            })()

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
                ...(returningRequested ? { data: row } : {})
            }
            await writeIdempotency(replay, 200)
            return { ok: true, status: 200, data: replay.data, replay, ...(change ? { change } : {}) }
        }

        if (write.kind === 'update') {
            if (typeof orm.update !== 'function') {
                throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement update', { kind: 'adapter' })
            }
            if (write.id === undefined) {
                throwError('INVALID_WRITE', 'Missing id for update', { kind: 'validation', resource: write.resource })
            }
            if (typeof write.baseVersion !== 'number' || !Number.isFinite(write.baseVersion) || write.baseVersion <= 0) {
                throwError('INVALID_WRITE', 'Missing baseVersion for update', { kind: 'validation', resource: write.resource })
            }

            const rawId = write.id
            const id = normalizeId(rawId)
            const data = (write.data && typeof write.data === 'object' && !Array.isArray(write.data))
                ? { ...(write.data as any) }
                : {}

            // update 必须能产出 version（即使 options.returning=false），否则协议无法返回 version
            const res = await orm.update(
                write.resource,
                { id: rawId, data, baseVersion: write.baseVersion, timestamp: write.timestamp } as any,
                { ...options, returning: true, ...(internalSelect ? { select: internalSelect } : {}) } as any
            )
            if (res?.error) throw res.error

            const row = res?.data
            const serverVersion = typeof (row as any)?.version === 'number'
                ? (row as any).version
                : (typeof write.baseVersion === 'number' && Number.isFinite(write.baseVersion) ? write.baseVersion + 1 : 1)

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
        const logMeta = {
            meta: args.meta,
            write: {
                kind: write.kind,
                resource: write.resource,
                idempotencyKey,
                id: write.id,
                baseVersion: write.baseVersion,
                timestamp: write.timestamp
            },
            error: serializeErrorForLog(err),
            standard
        }

        if (standard.kind === 'validation' || standard.code === 'CONFLICT') {
            args.logger?.warn?.('write item failed', logMeta)
        } else {
            args.logger?.error?.('write item failed', logMeta)
        }

        const status = errorStatus(standard)
        const replay: ErrorReplay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
        await writeIdempotency(replay, status)
        return { ok: false, status, error: standard, replay }
    }
}
