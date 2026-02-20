import { assertRemoteOpResults, createOpId, buildWriteOp, buildChangesPullOp, assertWriteResultData } from 'atoma-types/protocol-tools'
import type {
    Meta,
    RemoteOp,
    RemoteOpResult,
    WriteEntry as ProtocolWriteEntry,
    WriteItemResult as ProtocolWriteItemResult,
    WriteResultData
} from 'atoma-types/protocol'
import type {
    WriteEntry,
    WriteError,
    WriteItemMeta,
    WriteItemResult,
    WriteOptions
} from 'atoma-types/runtime'
import type { SyncOutboxItem, SyncPushOutcome, SyncTransport } from 'atoma-types/sync'

type ExecuteOperations = (input: {
    ops: RemoteOp[]
    meta: Meta
    signal?: AbortSignal
}) => Promise<{ results: RemoteOpResult[]; status?: number }>

function toProtocolWriteItemMeta(meta: WriteItemMeta | undefined): ProtocolWriteEntry['item']['meta'] {
    if (!meta || typeof meta !== 'object') return undefined
    return {
        ...meta
    }
}

function toProtocolWriteOptions(options: WriteOptions | undefined): ProtocolWriteEntry['options'] {
    if (!options || typeof options !== 'object') return undefined
    return {
        ...(typeof options.returning === 'boolean' ? { returning: options.returning } : {}),
        ...(options.select && typeof options.select === 'object' ? { select: options.select } : {}),
        ...(options.upsert && typeof options.upsert === 'object' ? { upsert: { ...options.upsert } } : {})
    }
}

function toProtocolWriteEntry(entry: WriteEntry): ProtocolWriteEntry {
    const options = toProtocolWriteOptions(entry.options)

    if (entry.action === 'create') {
        return {
            entryId: entry.entryId,
            action: 'create',
            item: {
                ...(entry.item.id ? { id: entry.item.id } : {}),
                value: entry.item.value,
                ...(entry.item.meta ? { meta: toProtocolWriteItemMeta(entry.item.meta) } : {})
            },
            ...(options ? { options } : {})
        }
    }

    if (entry.action === 'update') {
        return {
            entryId: entry.entryId,
            action: 'update',
            item: {
                id: entry.item.id,
                baseVersion: entry.item.baseVersion,
                value: entry.item.value,
                ...(entry.item.meta ? { meta: toProtocolWriteItemMeta(entry.item.meta) } : {})
            },
            ...(options ? { options } : {})
        }
    }

    if (entry.action === 'upsert') {
        return {
            entryId: entry.entryId,
            action: 'upsert',
            item: {
                id: entry.item.id,
                ...(typeof entry.item.expectedVersion === 'number' ? { expectedVersion: entry.item.expectedVersion } : {}),
                value: entry.item.value,
                ...(entry.item.meta ? { meta: toProtocolWriteItemMeta(entry.item.meta) } : {})
            },
            ...(options ? { options } : {})
        }
    }

    return {
        entryId: entry.entryId,
        action: 'delete',
        item: {
            id: entry.item.id,
            baseVersion: entry.item.baseVersion,
            ...(entry.item.meta ? { meta: toProtocolWriteItemMeta(entry.item.meta) } : {})
        },
        ...(options ? { options } : {})
    }
}

function toWriteError(error: unknown, fallbackMessage = 'Write failed'): WriteError {
    const raw = (error && typeof error === 'object') ? (error as Record<string, unknown>) : {}
    const code = (typeof raw.code === 'string' && raw.code) ? raw.code : 'WRITE_FAILED'
    const message = (typeof raw.message === 'string' && raw.message) ? raw.message : fallbackMessage
    const kind = (typeof raw.kind === 'string' && raw.kind) ? raw.kind : 'internal'
    const retryable = (typeof raw.retryable === 'boolean') ? raw.retryable : undefined
    const details = (raw.details && typeof raw.details === 'object')
        ? (raw.details as Record<string, unknown>)
        : undefined
    const cause = raw.cause ? toWriteError(raw.cause, fallbackMessage) : undefined

    return {
        code,
        message,
        kind,
        ...(retryable !== undefined ? { retryable } : {}),
        ...(details ? { details } : {}),
        ...(cause ? { cause } : {})
    }
}

function toWriteItemResult(itemResult: ProtocolWriteItemResult): WriteItemResult {
    if (itemResult.ok) {
        return {
            entryId: itemResult.entryId,
            ok: true,
            id: itemResult.id,
            version: itemResult.version,
            ...(itemResult.data !== undefined ? { data: itemResult.data } : {})
        }
    }

    return {
        entryId: itemResult.entryId,
        ok: false,
        error: toWriteError(itemResult.error),
        ...(itemResult.current
            ? {
                current: {
                    ...(itemResult.current.value !== undefined ? { value: itemResult.current.value } : {}),
                    ...(typeof itemResult.current.version === 'number' ? { version: itemResult.current.version } : {})
                }
            }
            : {})
    }
}

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
                            const raw = toProtocolWriteEntry(e.entry.entry)
                            const baseOptions = (raw.options && typeof raw.options === 'object') ? raw.options : undefined
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
                                error: toWriteError(
                                    { code: 'WRITE_FAILED', message: 'Missing write result', kind: 'internal' },
                                    'Missing write result'
                                )
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
                                    error: toWriteError(payload)
                                } as any
                            }
                    }
                    continue
                }

                let data: WriteResultData
                try {
                    data = assertWriteResultData((result as any).data, {
                        expectedLength: group.entries.length,
                        expectedEntryIds: group.entries.map((value) => String(value.entry.entry.entryId))
                    }) as WriteResultData
                } catch (error) {
                    for (const e of group.entries) {
                        outcomes[e.index] = { kind: 'retry', error }
                    }
                    continue
                }

                const itemResults = Array.isArray((data as any)?.results) ? (data as any).results : []
                for (let itemIndex = 0; itemIndex < group.entries.length; itemIndex++) {
                    const mapped = group.entries[itemIndex]
                    const entryId = (mapped.entry.entry as any)?.entryId
                    const itemResult = itemResults[itemIndex]
                    if (!itemResult) {
                        outcomes[mapped.index] = {
                            kind: 'reject',
                            result: {
                                entryId: (typeof entryId === 'string' && entryId) ? entryId : 'missing',
                                ok: false,
                                error: toWriteError(
                                    { code: 'WRITE_FAILED', message: 'Missing write item result', kind: 'internal' },
                                    'Missing write item result'
                                )
                            }
                        }
                        continue
                    }

                    const writeResult = toWriteItemResult(itemResult)
                    outcomes[mapped.index] = writeResult.ok === true
                        ? { kind: 'ack', result: writeResult }
                        : { kind: 'reject', result: writeResult }
                }
            }

            for (let i = 0; i < outcomes.length; i++) {
                if (!outcomes[i]) {
                    outcomes[i] = {
                        kind: 'reject',
                        result: {
                            entryId: `missing-${i}`,
                            ok: false,
                            error: toWriteError(
                                { code: 'WRITE_FAILED', message: 'Missing write outcome', kind: 'internal' },
                                'Missing write outcome'
                            )
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
