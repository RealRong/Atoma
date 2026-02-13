import { assertRemoteOpResults, createOpId, buildWriteOp, buildChangesPullOp, assertWriteResultData } from 'atoma-types/protocol-tools'
import type { Meta, RemoteOp, RemoteOpResult, WriteItemResult, WriteResultData } from 'atoma-types/protocol'
import type { SyncOutboxItem, SyncPushOutcome, SyncTransport } from 'atoma-types/sync'

type ExecuteOperations = (input: {
    ops: RemoteOp[]
    meta: Meta
    signal?: AbortSignal
}) => Promise<{ results: RemoteOpResult[]; status?: number }>

export function createOperationSyncDriver(args: {
    executeOperations: ExecuteOperations
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

            const res = await args.executeOperations({
                ops: [op],
                meta: input.meta,
                ...(input.signal ? { signal: input.signal } : {})
            })

            const results = assertRemoteOpResults((res as any).results)
            const result = results[0]
            if (!result) throw new Error('[Sync] Missing changes.pull result')
            if (!(result as any).ok) {
                throw toOperationError(result, 'changes.pull')
            }
            return (result as any).data as any
        },

        pushWrites: async (input) => {
            const outcomes: SyncPushOutcome[] = new Array(input.entries.length)

            type Group = {
                resource: string
                entries: Array<{ index: number; entry: SyncOutboxItem }>
            }

            const groupsByKey = new Map<string, Group>()
            const groups: Group[] = []

            for (let i = 0; i < input.entries.length; i++) {
                const outboxItem = input.entries[i]
                const resource = String(outboxItem?.resource ?? '')
                const entry = outboxItem?.entry as any
                const action = entry?.action
                const item = entry?.item

                if (!resource || !entry || !action || !item) {
                    outcomes[i] = {
                        kind: 'reject',
                        result: {
                            entryId: typeof entry?.entryId === 'string' && entry.entryId ? entry.entryId : `invalid-${i}`,
                            ok: false,
                            error: { code: 'WRITE_FAILED', message: 'Invalid outbox entry', kind: 'internal' as const }
                        }
                    }
                    continue
                }

                let group = groupsByKey.get(resource)
                if (!group) {
                    group = { resource, entries: [] }
                    groupsByKey.set(resource, group)
                    groups.push(group)
                }
                group.entries.push({ index: i, entry: outboxItem })
            }

            for (const group of groups) {
                const op = buildWriteOp({
                    opId: createOpId('w', { now }),
                    write: {
                        resource: group.resource,
                        entries: group.entries.map(e => {
                            const raw = e.entry.entry as any
                            const baseOptions = (raw?.options && typeof raw.options === 'object') ? raw.options : undefined
                            const options = {
                                ...(baseOptions ? baseOptions : {}),
                                returning: input.returning
                            }
                            return {
                                ...raw,
                                options
                            }
                        })
                    }
                })

                let result: RemoteOpResult | undefined
                try {
                    const res = await args.executeOperations({
                        ops: [op],
                        meta: input.meta,
                        ...(input.signal ? { signal: input.signal } : {})
                    })
                    const results = assertRemoteOpResults((res as any).results)
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
                        const entryId = (e.entry.entry as any)?.entryId
                        outcomes[e.index] = {
                            kind: 'reject',
                            result: {
                                entryId: typeof entryId === 'string' && entryId ? entryId : 'missing',
                                ok: false,
                                error: { code: 'WRITE_FAILED', message: 'Missing write result', kind: 'internal' as const }
                            }
                        }
                    }
                    continue
                }

                if (!(result as any).ok) {
                    const payload = (result as any).error ?? result
                    const retryable = isRetryableOperationError(payload)
                    for (const e of group.entries) {
                        const entryId = (e.entry.entry as any)?.entryId
                        outcomes[e.index] = retryable
                            ? { kind: 'retry', error: payload }
                            : {
                                kind: 'reject',
                                result: {
                                    entryId: typeof entryId === 'string' && entryId ? entryId : 'failed',
                                    ok: false,
                                    error: payload
                                } as any
                            }
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
                const itemResultByEntryId = new Map<string, WriteItemResult>()
                for (const itemResult of itemResults as WriteItemResult[]) {
                    itemResultByEntryId.set(itemResult.entryId, itemResult)
                }

                for (const mapped of group.entries) {
                    const entryId = (mapped.entry.entry as any)?.entryId
                    const key = typeof entryId === 'string' ? entryId : ''
                    const itemResult = key ? itemResultByEntryId.get(key) : undefined
                    if (!itemResult) {
                        outcomes[mapped.index] = {
                            kind: 'reject',
                            result: {
                                entryId: key || 'missing',
                                ok: false,
                                error: { code: 'WRITE_FAILED', message: 'Missing write item result', kind: 'internal' as const }
                            }
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
                            entryId: `missing-${i}`,
                            ok: false,
                            error: { code: 'WRITE_FAILED', message: 'Missing write outcome', kind: 'internal' as const }
                        }
                    }
                }
            }

            return outcomes
        }
    }
}

function toOperationError(result: RemoteOpResult, tag: string): Error {
    if ((result as any).ok) return new Error(`[${tag}] RemoteOp failed`)
    const message = ((result as any).error && typeof ((result as any).error as any).message === 'string')
        ? ((result as any).error as any).message
        : `[${tag}] RemoteOp failed`
    const err = new Error(message)
    ;(err as any).error = (result as any).error
    return err
}

function isRetryableOperationError(error: any): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = (error as any).kind
    return kind === 'internal' || kind === 'adapter'
}
