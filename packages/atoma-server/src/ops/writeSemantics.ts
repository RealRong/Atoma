import type { ChangeKind } from 'atoma-types/protocol'
import { errorStatus, throwError, toStandardError } from '../error'
import type { StandardError as StandardErrorType } from 'atoma-types/protocol'
import type { AtomaChange, IOrmAdapter, ISyncAdapter } from '../adapters/ports'
import type { WriteOptions } from 'atoma-types/protocol'
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
        expectedVersion?: number
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

function requiredSelectFields(kind: WriteKind): string[] {
    if (kind === 'create') return ['id', 'version']
    if (kind === 'update') return ['version']
    if (kind === 'upsert') {
        // 即使 returning=false，我们也需要 version 来正确返回 WriteItemResult.version
        return ['version']
    }
    return []
}

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

type WriteExecutionContext = {
    orm: IOrmAdapter
    sync?: ISyncAdapter
    tx?: unknown
    syncEnabled: boolean
    changedAt: number
    write: ExecuteArgs['write']
    options: WriteOptions
    internalSelect?: Record<string, boolean>
    returningRequested: boolean
}

type WriteExecutionSuccess = {
    replay: OkReplay
    data?: unknown
    change?: AtomaChange
}

async function appendChangeIfEnabled(args: {
    syncEnabled: boolean
    sync?: ISyncAdapter
    tx?: unknown
    resource: string
    id: string
    kind: ChangeKind
    serverVersion: number
    changedAt: number
}): Promise<AtomaChange | undefined> {
    if (!args.syncEnabled) return undefined
    return args.sync!.appendChange({
        resource: args.resource,
        id: args.id,
        kind: args.kind,
        serverVersion: args.serverVersion,
        changedAt: args.changedAt
    }, args.tx)
}

async function executeCreateWrite(ctx: WriteExecutionContext): Promise<WriteExecutionSuccess> {
    const { orm, write } = ctx
    if (typeof orm.create !== 'function') {
        throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement create', { kind: 'adapter' })
    }

    const data = write.data && typeof write.data === 'object' ? { ...(write.data as any) } : {}
    if (write.id !== undefined) (data as any).id = write.id
    const v = (data as any).version
    if (!(typeof v === 'number' && Number.isFinite(v) && v >= 1)) (data as any).version = 1

    const res = await orm.create(
        write.resource,
        data,
        { returning: true, ...(ctx.internalSelect ? { select: ctx.internalSelect } : {}) } as any
    )
    if (res?.error) throw res.error
    const row = res?.data

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
    const change = await appendChangeIfEnabled({
        syncEnabled: ctx.syncEnabled,
        sync: ctx.sync,
        tx: ctx.tx,
        resource: write.resource,
        id,
        kind: 'upsert',
        serverVersion,
        changedAt: ctx.changedAt
    })
    const replay: OkReplay = {
        kind: 'ok',
        resource: write.resource,
        id,
        changeKind: 'upsert',
        serverVersion,
        ...(change ? { cursor: change.cursor } : {}),
        data: row
    }

    return { replay, data: row, ...(change ? { change } : {}) }
}

async function executeUpsertWrite(ctx: WriteExecutionContext): Promise<WriteExecutionSuccess> {
    const { orm, write } = ctx
    if (typeof orm.upsert !== 'function') {
        throwError('ADAPTER_NOT_IMPLEMENTED', 'Adapter does not implement upsert', { kind: 'adapter' })
    }
    if (write.id === undefined) {
        throwError('INVALID_WRITE', 'Missing id for upsert', { kind: 'validation', resource: write.resource })
    }

    const conflict: 'cas' | 'lww' = (ctx.options as any)?.upsert?.conflict === 'lww' ? 'lww' : 'cas'
    const apply: 'merge' | 'replace' = (ctx.options as any)?.upsert?.apply === 'replace' ? 'replace' : 'merge'
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
            expectedVersion: write.expectedVersion,
            conflict,
            apply
        } as any,
        { ...ctx.options, returning: true, ...(ctx.internalSelect ? { select: ctx.internalSelect } : {}) } as any
    )
    if (res?.error) throw res.error

    const row = res?.data
    const rowVersion = typeof (row as any)?.version === 'number' ? (row as any).version : undefined
    if (!(typeof rowVersion === 'number' && Number.isFinite(rowVersion) && rowVersion >= 1)) {
        throwError('INTERNAL', 'Upsert returned missing version', { kind: 'internal', resource: write.resource })
    }
    const serverVersion = rowVersion
    const change = await appendChangeIfEnabled({
        syncEnabled: ctx.syncEnabled,
        sync: ctx.sync,
        tx: ctx.tx,
        resource: write.resource,
        id,
        kind: 'upsert',
        serverVersion,
        changedAt: ctx.changedAt
    })
    const replay: OkReplay = {
        kind: 'ok',
        resource: write.resource,
        id,
        changeKind: 'upsert',
        serverVersion,
        ...(change ? { cursor: change.cursor } : {}),
        ...(ctx.returningRequested ? { data: row } : {})
    }

    return { replay, ...(ctx.returningRequested ? { data: row } : {}), ...(change ? { change } : {}) }
}

async function executeUpdateWrite(ctx: WriteExecutionContext): Promise<WriteExecutionSuccess> {
    const { orm, write } = ctx
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
        { id: rawId, data, baseVersion: write.baseVersion } as any,
        { ...ctx.options, returning: true, ...(ctx.internalSelect ? { select: ctx.internalSelect } : {}) } as any
    )
    if (res?.error) throw res.error

    const row = res?.data
    const serverVersion = typeof (row as any)?.version === 'number'
        ? (row as any).version
        : (typeof write.baseVersion === 'number' && Number.isFinite(write.baseVersion) ? write.baseVersion + 1 : 1)
    const change = await appendChangeIfEnabled({
        syncEnabled: ctx.syncEnabled,
        sync: ctx.sync,
        tx: ctx.tx,
        resource: write.resource,
        id,
        kind: 'upsert',
        serverVersion,
        changedAt: ctx.changedAt
    })
    const replay: OkReplay = {
        kind: 'ok',
        resource: write.resource,
        id,
        changeKind: 'upsert',
        serverVersion,
        ...(change ? { cursor: change.cursor } : {}),
        data: row
    }

    return { replay, data: row, ...(change ? { change } : {}) }
}

async function executeDeleteWrite(ctx: WriteExecutionContext): Promise<WriteExecutionSuccess> {
    const { orm, write } = ctx
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
    const change = await appendChangeIfEnabled({
        syncEnabled: ctx.syncEnabled,
        sync: ctx.sync,
        tx: ctx.tx,
        resource: write.resource,
        id,
        kind: 'delete',
        serverVersion,
        changedAt: ctx.changedAt
    })
    const replay: OkReplay = {
        kind: 'ok',
        resource: write.resource,
        id,
        changeKind: 'delete',
        serverVersion,
        ...(change ? { cursor: change.cursor } : {})
    }

    return { replay, ...(change ? { change } : {}) }
}

async function executeWriteByKind(ctx: WriteExecutionContext): Promise<WriteExecutionSuccess> {
    if (ctx.write.kind === 'create') return executeCreateWrite(ctx)
    if (ctx.write.kind === 'upsert') return executeUpsertWrite(ctx)
    if (ctx.write.kind === 'update') return executeUpdateWrite(ctx)
    if (ctx.write.kind === 'delete') return executeDeleteWrite(ctx)

    throwError('INVALID_WRITE', 'Unsupported write kind', { kind: 'validation', resource: ctx.write.resource })
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
        requiredSelectFields(write.kind)
    )

    if (args.syncEnabled) {
        if (!sync) {
            throw new Error('executeWriteItemWithSemantics requires sync adapter when syncEnabled=true')
        }
    }

    const toReplayResult = (replay: StoredWriteReplay): ExecuteWriteItemResult => {
        if (replay.kind === 'ok') {
            return {
                ok: true,
                status: 200,
                data: replay.data,
                replay: replay as OkReplay
            }
        }
        return {
            ok: false,
            status: errorStatus(replay.error),
            error: replay.error,
            replay: replay as ErrorReplay
        }
    }

    const readIdempotencyReplay = async (): Promise<StoredWriteReplay | undefined> => {
        if (!args.syncEnabled || !idempotencyKey) return undefined
        const hit = await sync!.getIdempotency(idempotencyKey, tx)
        if (!hit.hit) return undefined
        return readStoredWriteReplay(hit.body)
    }

    const claimIdempotencyOrReplay = async (): Promise<StoredWriteReplay | true> => {
        if (!args.syncEnabled || !idempotencyKey) return true

        const claim = await sync!.claimIdempotency(
            idempotencyKey,
            { status: 102, body: { kind: 'pending' } },
            args.idempotencyTtlMs,
            tx
        )
        if (claim.acquired) return true

        const replayFromClaim = readStoredWriteReplay(claim.body)
        if (replayFromClaim) return replayFromClaim

        for (let attempt = 0; attempt < 5; attempt += 1) {
            await new Promise(resolve => setTimeout(resolve, 20 * (attempt + 1)))
            const replay = await readIdempotencyReplay()
            if (replay) return replay
        }

        throwError('CONFLICT', 'Idempotency key is in progress', {
            kind: 'conflict',
            resource: write.resource,
            ...(write.id !== undefined ? { id: normalizeId(write.id) } : {})
        } as any)
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

    const claimResult = await claimIdempotencyOrReplay()
    if (claimResult !== true) return toReplayResult(claimResult)

    try {
        const changedAt = now()
        const success = await executeWriteByKind({
            orm,
            sync,
            tx,
            syncEnabled: args.syncEnabled,
            changedAt,
            write,
            options,
            internalSelect,
            returningRequested
        })

        await writeIdempotency(success.replay, 200)
        return {
            ok: true,
            status: 200,
            ...(success.data !== undefined ? { data: success.data } : {}),
            replay: success.replay,
            ...(success.change ? { change: success.change } : {})
        }
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
                expectedVersion: write.expectedVersion
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
