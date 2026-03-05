import type { IOrmAdapter, ISyncAdapter } from '../../adapters/ports'
import { createError } from '../../error'
import { executeWriteItem } from '../../domain/write/executeWriteItem'
import { statusOf, toStandard } from '../../shared/errors/standardError'
import {
    extractConflictMeta,
    extractWriteItemMeta,
    serializeErrorForLog,
    toFailItemResult,
    toOkItemResult,
    toUnhandledItemError,
    type TraceMeta,
    validateCreateIdMatchesValue
} from './writeResult'

export async function executeWriteItems(args: {
    adapter: IOrmAdapter
    syncAdapter?: ISyncAdapter
    syncEnabled: boolean
    idempotencyTtlMs: number
    resource: string
    action: 'create' | 'update' | 'upsert' | 'delete'
    items: any[]
    writeOptions: unknown
    opTrace: TraceMeta
    logger: any
}) {
    const sync = args.syncEnabled ? args.syncAdapter : undefined
    if (args.syncEnabled && !sync) {
        throw new Error('executeWriteOps requires sync adapter when syncEnabled=true')
    }

    const writeIdempotency = async (key: string, replay: any, status: number, tx?: unknown) => {
        if (!args.syncEnabled) return
        await sync!.putIdempotency(
            key,
            { status, body: { kind: 'write', value: replay } },
            args.idempotencyTtlMs,
            tx
        )
    }

    const invalidWrite = (message: string) => toStandard(createError('INVALID_WRITE', message, { kind: 'validation', resource: args.resource }))

    const executeSingleInContext = async (ctx: { orm: IOrmAdapter; tx?: unknown }, index: number) => {
        const raw = args.items[index] as any
        const { idempotencyKey } = extractWriteItemMeta(raw)

        try {
            const base = {
                resource: args.resource,
                ...(idempotencyKey ? { idempotencyKey } : {})
            }

            if (args.action === 'create') {
                const match = validateCreateIdMatchesValue(raw)
                if (!match.ok) {
                    const standard = invalidWrite(match.reason)
                    const replay = { kind: 'error', error: standard, ...extractConflictMeta(standard) }
                    if (args.syncEnabled && idempotencyKey) await writeIdempotency(idempotencyKey, replay, statusOf(standard), ctx.tx)
                    const result: any = { ok: false, status: statusOf(standard), error: standard, replay }
                    args.logger?.warn?.('write item rejected', {
                        opId: args.opTrace.opId,
                        ...(args.opTrace.traceId ? { traceId: args.opTrace.traceId } : {}),
                        ...(args.opTrace.requestId ? { requestId: args.opTrace.requestId } : {}),
                        resource: args.resource,
                        action: args.action,
                        index,
                        id: raw?.id,
                        baseVersion: raw?.baseVersion,
                        idempotencyKey,
                        error: standard
                    })
                    return toFailItemResult(result, args.opTrace)
                }
            }

            const result = await executeWriteItem({
                orm: ctx.orm,
                sync,
                tx: ctx.tx,
                syncEnabled: args.syncEnabled,
                idempotencyTtlMs: args.idempotencyTtlMs,
                meta: args.opTrace,
                logger: args.logger,
                write: (() => {
                    if (args.action === 'create') {
                        return {
                            kind: 'create',
                            ...base,
                            id: raw?.id,
                            data: raw?.value,
                            ...(args.writeOptions !== undefined ? { options: args.writeOptions as any } : {})
                        }
                    }
                    if (args.action === 'update') {
                        return {
                            kind: 'update',
                            ...base,
                            id: raw?.id,
                            baseVersion: raw?.baseVersion,
                            data: raw?.value,
                            ...(args.writeOptions !== undefined ? { options: args.writeOptions as any } : {})
                        }
                    }
                    if (args.action === 'upsert') {
                        return {
                            kind: 'upsert',
                            ...base,
                            id: raw?.id,
                            expectedVersion: raw?.expectedVersion,
                            data: raw?.value,
                            ...(args.writeOptions !== undefined ? { options: args.writeOptions as any } : {})
                        }
                    }

                    return {
                        kind: 'delete',
                        ...base,
                        id: raw?.id,
                        baseVersion: raw?.baseVersion,
                        ...(args.writeOptions !== undefined ? { options: args.writeOptions as any } : {})
                    }
                })()
            })

            return result.ok
                ? toOkItemResult(result)
                : toFailItemResult(result, args.opTrace)
        } catch (error) {
            args.logger?.error?.('write item threw', {
                opId: args.opTrace.opId,
                ...(args.opTrace.traceId ? { traceId: args.opTrace.traceId } : {}),
                ...(args.opTrace.requestId ? { requestId: args.opTrace.requestId } : {}),
                resource: args.resource,
                action: args.action,
                index,
                id: raw?.id,
                baseVersion: raw?.baseVersion,
                expectedVersion: raw?.expectedVersion,
                idempotencyKey,
                error: serializeErrorForLog(error)
            })
            return toUnhandledItemError(error, args.opTrace)
        }
    }

    const executePerItemInContext = async (ctx: { orm: IOrmAdapter; tx?: unknown }) => {
        const itemResults: any[] = new Array(args.items.length)
        for (let index = 0; index < args.items.length; index += 1) {
            itemResults[index] = await executeSingleInContext(ctx, index)
        }
        return itemResults
    }

    if (!args.syncEnabled) {
        return {
            transactionApplied: false,
            results: await executePerItemInContext({ orm: args.adapter, tx: undefined })
        }
    }

    try {
        const results = await args.adapter.transaction(async (tx) => executePerItemInContext({ orm: tx.orm, tx: tx.tx }))
        return { transactionApplied: true, results }
    } catch {
        const fallback: any[] = new Array(args.items.length)
        for (let index = 0; index < args.items.length; index += 1) {
            try {
                fallback[index] = await args.adapter.transaction(async (tx) => executeSingleInContext({ orm: tx.orm, tx: tx.tx }, index))
            } catch (error) {
                fallback[index] = toUnhandledItemError(error, args.opTrace)
            }
        }
        return { transactionApplied: false, results: fallback }
    }
}
