import type { WriteOptions } from '@atoma-js/types/protocol'
import { serializeError } from '../../shared/logging/serializeError'
import { statusOf, toStandard } from '../../shared/errors/standardError'
import { extractConflictMeta } from './conflict'
import {
    type ErrorWriteReplay,
    claimWriteReplayOrAcquire,
    storeWriteReplay
} from './idempotency'
import { applyWriteByKind } from './applyWrite'
import type { ExecuteWriteItemArgs, ExecuteWriteItemResult, WriteKind } from './types'

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function ensureSelect(select: Record<string, boolean> | undefined, required: string[]): Record<string, boolean> | undefined {
    if (!select) return undefined
    const out: Record<string, boolean> = { ...select }
    required.forEach(key => { out[key] = true })
    return out
}

function requiredSelectFields(kind: WriteKind): string[] {
    if (kind === 'create') return ['id', 'version']
    return kind === 'upsert' || kind === 'update' ? ['version'] : []
}

export async function executeWriteItem(args: ExecuteWriteItemArgs): Promise<ExecuteWriteItemResult> {
    const now = args.now ?? (() => Date.now())
    const idempotencyKey = typeof args.write.idempotencyKey === 'string' && args.write.idempotencyKey ? args.write.idempotencyKey : undefined
    const options: WriteOptions = isPlainObject(args.write.options) ? (args.write.options as WriteOptions) : {}
    const returningRequested = options.returning !== false
    const internalSelect = ensureSelect(
        isPlainObject(options.select) ? options.select : undefined,
        requiredSelectFields(args.write.kind)
    )

    if (args.syncEnabled && !args.sync) {
        throw new Error('executeWriteItem requires sync adapter when syncEnabled=true')
    }

    const replayOrLock = await claimWriteReplayOrAcquire({
        syncEnabled: args.syncEnabled,
        sync: args.sync,
        tx: args.tx,
        idempotencyKey,
        idempotencyTtlMs: args.idempotencyTtlMs,
        resource: args.write.resource,
        id: args.write.id
    })
    if (replayOrLock !== true) {
        if (replayOrLock.kind === 'ok') return { ok: true, status: 200, data: replayOrLock.data, replay: replayOrLock }
        return {
            ok: false,
            status: statusOf(replayOrLock.error),
            error: replayOrLock.error,
            replay: replayOrLock
        }
    }

    try {
        const success = await applyWriteByKind({
            orm: args.orm,
            sync: args.sync,
            tx: args.tx,
            syncEnabled: args.syncEnabled,
            changedAt: now(),
            write: args.write,
            options,
            internalSelect,
            returningRequested
        })
        await storeWriteReplay({
            syncEnabled: args.syncEnabled,
            sync: args.sync,
            tx: args.tx,
            idempotencyKey,
            idempotencyTtlMs: args.idempotencyTtlMs,
            replay: success.replay,
            status: 200
        })
        return {
            ok: true,
            status: 200,
            ...(success.data !== undefined ? { data: success.data } : {}),
            replay: success.replay,
            ...(success.change ? { change: success.change } : {})
        }
    } catch (error) {
        const standard = toStandard(error, 'WRITE_FAILED')
        const logMeta = {
            meta: args.meta,
            write: {
                kind: args.write.kind,
                resource: args.write.resource,
                idempotencyKey,
                id: args.write.id,
                baseVersion: args.write.baseVersion,
                expectedVersion: args.write.expectedVersion
            },
            error: serializeError(error),
            standard
        }
        if (standard.kind === 'validation' || standard.code === 'CONFLICT') {
            args.logger?.warn?.('write item failed', logMeta)
        } else {
            args.logger?.error?.('write item failed', logMeta)
        }

        const status = statusOf(standard)
        const replay: ErrorWriteReplay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
        await storeWriteReplay({
            syncEnabled: args.syncEnabled,
            sync: args.sync,
            tx: args.tx,
            idempotencyKey,
            idempotencyTtlMs: args.idempotencyTtlMs,
            replay,
            status
        })
        return { ok: false, status, error: standard, replay }
    }
}
