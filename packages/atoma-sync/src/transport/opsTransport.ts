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

        const res = await args.opsClient.executeOps({ ops: [op], meta: input.meta, signal: input.signal })
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
        const outcomes: SyncPushOutcome[] = new Array(input.entries.length)

        type Group = {
            opId: string
            resource: string
            action: any
            options: any
            entries: Array<{ index: number; entry: any }>
        }

        const groupsByKey = new Map<string, Group>()
        const groups: Group[] = []

        for (let i = 0; i < input.entries.length; i++) {
            const entry: any = input.entries[i]
            const resource = String(entry?.resource ?? '')
            const action = entry?.action
            const options = {
                ...(entry?.options ? entry.options : {}),
                returning: input.returning
            }

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

            let optionsKey: string
            try {
                optionsKey = stableStringify(options)
            } catch {
                // If options are not serializable (e.g. contain circular refs), fall back to per-entry grouping.
                optionsKey = `__unstringifiable__:${String(entry?.idempotencyKey ?? i)}`
            }

            const groupKey = `${resource}::${String(action)}::${optionsKey}`
            let group = groupsByKey.get(groupKey)
            if (!group) {
                const opId = Protocol.ids.createOpId('w', { now })
                group = { opId, resource, action, options, entries: [] }
                groupsByKey.set(groupKey, group)
                groups.push(group)
            }
            group.entries.push({ index: i, entry })
        }

        const ops: Operation[] = []
        const builtByOpId = new Map<string, { group: Group; op?: Operation; error?: unknown }>()

        for (const group of groups) {
            try {
                const op = Protocol.ops.build.buildWriteOp({
                    opId: group.opId,
                    write: {
                        resource: group.resource,
                        action: group.action,
                        items: group.entries.map(e => e.entry.item),
                        options: group.options
                    }
                })
                ops.push(op)
                builtByOpId.set(group.opId, { group, op })
            } catch (error) {
                builtByOpId.set(group.opId, { group, error })
            }
        }

        const byId = new Map<string, OperationResult>()
        if (ops.length) {
            const res = await args.opsClient.executeOps({ ops, meta: input.meta, signal: input.signal })
            for (const r of res.results as any[]) byId.set(r.opId, r as any)
        }

        for (const group of groups) {
            const built = builtByOpId.get(group.opId)
            if (!built || built.error) {
                for (const e of group.entries) {
                    outcomes[e.index] = {
                        kind: 'reject',
                        result: {
                            index: 0,
                            ok: false,
                            error: { code: 'WRITE_FAILED', message: 'Invalid outbox entry', kind: 'internal' as const }
                        } as any
                    }
                }
                continue
            }

            const result = byId.get(group.opId)
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

            if (!result.ok) {
                if (isRetryableOpError((result as any).error)) {
                    for (const e of group.entries) {
                        outcomes[e.index] = { kind: 'retry', error: (result as any).error }
                    }
                } else {
                    for (const e of group.entries) {
                        outcomes[e.index] = {
                            kind: 'reject',
                            result: { index: 0, ok: false, error: (result as any).error } as any
                        }
                    }
                }
                continue
            }

            const data = (result as any).data as WriteResultData
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

                if (itemResult.ok === true) {
                    outcomes[mapped.index] = { kind: 'ack', result: itemResult as any }
                } else {
                    outcomes[mapped.index] = { kind: 'reject', result: itemResult as any }
                }
            }
        }

        // Defensive: fill any missing slots.
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

function stableStringify(value: any): string {
    return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value: any): any {
    if (!value || typeof value !== 'object') return value
    if (Array.isArray(value)) return value.map(sortKeysDeep)
    const out: any = {}
    for (const k of Object.keys(value).sort()) {
        out[k] = sortKeysDeep(value[k])
    }
    return out
}
