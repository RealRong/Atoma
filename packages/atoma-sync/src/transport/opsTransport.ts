import type { OpsClientLike } from 'atoma/core'
import { Protocol, type ChangeBatch, type Meta, type Operation, type OperationResult, type WriteItemResult, type WriteResultData } from 'atoma/protocol'
import type { SyncSubscribe, SyncTransport, SyncPushOutcome } from '#sync/types'

export function createOpsTransport(args: {
    opsClient: OpsClientLike
    subscribe?: SyncSubscribe
    now?: () => number
}): SyncTransport {
    const now = args.now ?? (() => Date.now())

    const pullChanges: SyncTransport['pullChanges'] = async (input) => {
        const opId = Protocol.ids.createOpId('c', { now })
        const op = Protocol.ops.build.buildChangesPullOp({
            opId,
            cursor: input.cursor,
            limit: input.limit,
            ...(input.resources?.length ? { resources: input.resources } : {})
        })

        const res = await args.opsClient.executeOps({ ops: [op], meta: input.meta })
        const result = (res.results.find(r => r.opId === opId) as OperationResult | undefined) ?? {
            opId,
            ok: false as const,
            error: { code: 'INTERNAL', message: 'Missing result', kind: 'internal' as const }
        }

        if (!result.ok) {
            const message = typeof (result.error as any)?.message === 'string'
                ? String((result.error as any).message)
                : 'Operation failed'
            const err = new Error(message)
            ;(err as any).error = result.error
            throw err
        }

        return result.data as ChangeBatch
    }

    const pushWrites: SyncTransport['pushWrites'] = async (input) => {
        const built: Array<{ opId: string; op: Operation } | { opId: string; error: unknown }> = input.entries.map((entry) => {
            const opId = `w:${entry.idempotencyKey}`
            try {
                const op = Protocol.ops.build.buildWriteOp({
                    opId,
                    write: {
                        resource: String((entry as any).resource ?? ''),
                        action: (entry as any).action as any,
                        items: [(entry as any).item as any],
                        options: {
                            ...((entry as any).options ? (entry as any).options : {}),
                            returning: input.returning
                        }
                    }
                })
                return { opId, op }
            } catch (error) {
                return { opId, error }
            }
        })

        const ops: Operation[] = built.flatMap(b => ('op' in b ? [b.op] : []))
        const byId = new Map<string, OperationResult>()
        if (ops.length) {
            const res = await args.opsClient.executeOps({ ops, meta: input.meta })
            for (const r of res.results) byId.set(r.opId, r)
        }

        const outcomes: SyncPushOutcome[] = []

        for (let i = 0; i < input.entries.length; i++) {
            const entry = input.entries[i]!
            const builtItem = built[i]!
            const opId = builtItem.opId

            if ('error' in builtItem) {
                outcomes.push({
                    kind: 'reject',
                    result: {
                        index: 0,
                        ok: false,
                        error: { code: 'WRITE_FAILED', message: 'Invalid outbox entry', kind: 'internal' as const }
                    } as any
                })
                continue
            }

            const result = byId.get(opId)
            if (!result) {
                outcomes.push({
                    kind: 'reject',
                    result: {
                        index: 0,
                        ok: false,
                        error: { code: 'WRITE_FAILED', message: 'Missing write result', kind: 'internal' as const }
                    } as any
                })
                continue
            }

            if (!result.ok) {
                if (isRetryableOpError(result.error)) {
                    outcomes.push({ kind: 'retry', error: result.error })
                    continue
                }
                outcomes.push({
                    kind: 'reject',
                    result: { index: 0, ok: false, error: result.error } as any
                })
                continue
            }

            const data = result.data as WriteResultData
            const itemResults = Array.isArray(data?.results) ? data.results : []
            const itemResult = (itemResults.length ? itemResults[0] : undefined) as (WriteItemResult | undefined)

            if (!itemResult) {
                outcomes.push({
                    kind: 'reject',
                    result: {
                        index: 0,
                        ok: false,
                        error: { code: 'WRITE_FAILED', message: 'Missing write item result', kind: 'internal' as const }
                    } as any
                })
                continue
            }

            if (itemResult.ok === true) {
                outcomes.push({ kind: 'ack', result: itemResult as any })
            } else {
                outcomes.push({ kind: 'reject', result: itemResult as any })
            }
        }

        return outcomes
    }

    return {
        pullChanges,
        pushWrites,
        ...(args.subscribe ? { subscribe: args.subscribe } : {})
    }
}

function isRetryableOpError(error: any): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = error.kind
    return kind === 'internal' || kind === 'adapter'
}
