import { assertOperationResults, createOpId, buildWriteOp, buildChangesPullOp, assertWriteResultData } from 'atoma-types/protocol-tools'
import type { Meta, Operation, OperationResult, WriteItemResult, WriteResultData } from 'atoma-types/protocol'
import type { SyncOutboxItem, SyncPushOutcome, SyncTransport } from 'atoma-types/sync'

type ExecuteOps = (input: {
    ops: Operation[]
    meta: Meta
    signal?: AbortSignal
}) => Promise<{ results: OperationResult[]; status?: number }>

export function createOpsSyncDriver(args: {
    executeOps: ExecuteOps
    now?: () => number
}): SyncTransport {
    const now = args.now ?? (() => Date.now())

    return {
        pullChanges: async (input) => {
            const op = buildChangesPullOp({
                opId: createOpId('c', { now }),
                cursor: input.cursor,
                limit: input.limit,
                ...(input.resources?.length ? { resources: input.resources } : {})
            })

            const res = await args.executeOps({
                ops: [op],
                meta: input.meta,
                ...(input.signal ? { signal: input.signal } : {})
            })

            const results = assertOperationResults((res as any).results)
            const result = results[0]
            if (!result) throw new Error('[Sync] Missing changes.pull result')
            if (!(result as any).ok) {
                throw toOpsError(result, 'changes.pull')
            }
            return (result as any).data as any
        },

        pushWrites: async (input) => {
            const outcomes: SyncPushOutcome[] = new Array(input.entries.length)

            type Group = {
                resource: string
                action: any
                entries: Array<{ index: number; entry: SyncOutboxItem }>
            }

            const groupsByKey = new Map<string, Group>()
            const groups: Group[] = []

            for (let i = 0; i < input.entries.length; i++) {
                const entry = input.entries[i]
                const resource = String(entry?.resource ?? '')
                const action = entry?.action

                if (!resource || !action || !entry?.item) {
                    outcomes[i] = {
                        kind: 'reject',
                        result: {
                            index: 0,
                            ok: false,
                            error: { code: 'WRITE_FAILED', message: 'Invalid outbox entry', kind: 'internal' as const }
                        } as any
                    }
                    continue
                }

                const groupKey = `${resource}::${String(action)}`
                let group = groupsByKey.get(groupKey)
                if (!group) {
                    group = { resource, action, entries: [] }
                    groupsByKey.set(groupKey, group)
                    groups.push(group)
                }
                group.entries.push({ index: i, entry })
            }

            for (const group of groups) {
                const op = buildWriteOp({
                    opId: createOpId('w', { now }),
                    write: {
                        resource: group.resource,
                        action: group.action,
                        items: group.entries.map(e => e.entry.item),
                        options: { returning: input.returning }
                    }
                })

                let result: OperationResult | undefined
                try {
                    const res = await args.executeOps({
                        ops: [op],
                        meta: input.meta,
                        ...(input.signal ? { signal: input.signal } : {})
                    })
                    const results = assertOperationResults((res as any).results)
                    result = results[0]
                } catch (error) {
                    for (const e of group.entries) {
                        outcomes[e.index] = {
                            kind: 'retry',
                            error
                        }
                    }
                    continue
                }

                if (!result) {
                    for (const e of group.entries) {
                        outcomes[e.index] = {
                            kind: 'reject',
                            result: {
                                index: 0,
                                ok: false,
                                error: { code: 'WRITE_FAILED', message: 'Missing write result', kind: 'internal' as const }
                            } as any
                        }
                    }
                    continue
                }

                if (!(result as any).ok) {
                    const payload = (result as any).error ?? result
                    const retryable = isRetryableOpError(payload)
                    for (const e of group.entries) {
                        outcomes[e.index] = retryable
                            ? { kind: 'retry', error: payload }
                            : { kind: 'reject', result: { index: 0, ok: false, error: payload } as any }
                    }
                    continue
                }

                let data: WriteResultData
                try {
                    data = assertWriteResultData((result as any).data) as WriteResultData
                } catch (error) {
                    for (const e of group.entries) {
                        outcomes[e.index] = { kind: 'retry', error }
                    }
                    continue
                }

                const itemResults = Array.isArray((data as any)?.results) ? (data as any).results : []
                for (let j = 0; j < group.entries.length; j++) {
                    const mapped = group.entries[j]!
                    const itemResult = itemResults[j] as (WriteItemResult | undefined)
                    if (!itemResult) {
                        outcomes[mapped.index] = {
                            kind: 'reject',
                            result: {
                                index: j,
                                ok: false,
                                error: { code: 'WRITE_FAILED', message: 'Missing write item result', kind: 'internal' as const }
                            } as any
                        }
                        continue
                    }
                    outcomes[mapped.index] = itemResult.ok === true
                        ? { kind: 'ack', result: itemResult as any }
                        : { kind: 'reject', result: itemResult as any }
                }
            }

            for (let i = 0; i < outcomes.length; i++) {
                if (!outcomes[i]) {
                    outcomes[i] = {
                        kind: 'reject',
                        result: {
                            index: 0,
                            ok: false,
                            error: { code: 'WRITE_FAILED', message: 'Missing write outcome', kind: 'internal' as const }
                        } as any
                    }
                }
            }

            return outcomes
        }
    }
}

function toOpsError(result: OperationResult, tag: string): Error {
    if ((result as any).ok) return new Error(`[${tag}] Operation failed`)
    const message = ((result as any).error && typeof ((result as any).error as any).message === 'string')
        ? ((result as any).error as any).message
        : `[${tag}] Operation failed`
    const err = new Error(message)
    ;(err as any).error = (result as any).error
    return err
}

function isRetryableOpError(error: any): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = (error as any).kind
    return kind === 'internal' || kind === 'adapter'
}
