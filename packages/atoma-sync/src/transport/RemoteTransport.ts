import type { ClientPluginContext } from 'atoma/client'
import {
    Protocol,
    type ChangeBatch,
    type Operation,
    type OperationResult,
    type WriteItemResult,
    type WriteResultData
} from 'atoma/protocol'
import type { NotifyMessage, SyncPushOutcome, SyncSubscribe, SyncTransport } from '#sync/types'

export class RemoteTransport implements SyncTransport {
    private readonly now: () => number
    readonly subscribe?: SyncSubscribe

    constructor(
        private readonly ctx: ClientPluginContext,
        opts?: Readonly<{ now?: () => number }>
    ) {
        this.now = opts?.now ?? (() => Date.now())

        if (this.ctx.io.subscribe) {
            this.subscribe = (args) => this.ctx.io.subscribe!({
                channel: 'remote',
                resources: args.resources,
                signal: args.signal,
                onError: args.onError,
                onMessage: (raw) => {
                    try {
                        args.onMessage(decodeNotifyMessage(raw))
                    } catch (error) {
                        args.onError(error)
                    }
                }
            })
        }
    }

    pullChanges: SyncTransport['pullChanges'] = async (input) => {
        const opId = Protocol.ids.createOpId('c', { now: this.now })
        const op = Protocol.ops.build.buildChangesPullOp({
            opId,
            cursor: input.cursor,
            limit: input.limit,
            ...(input.resources?.length ? { resources: input.resources } : {})
        })

        const res = await this.ctx.io.executeOps({
            channel: 'remote',
            ops: [op],
            meta: input.meta,
            signal: input.signal
        })
        const result = ((res as any)?.results?.find((r: any) => r?.opId === opId) as OperationResult | undefined) ?? {
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

    pushWrites: SyncTransport['pushWrites'] = async (input) => {
        const outcomes: SyncPushOutcome[] = new Array(input.entries.length)

        type Group = {
            opId: string
            resource: string
            action: any
            entries: Array<{ index: number; entry: any }>
        }

        const groupsByKey = new Map<string, Group>()
        const groups: Group[] = []

        for (let i = 0; i < input.entries.length; i++) {
            const entry: any = input.entries[i]
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
                const opId = Protocol.ids.createOpId('w', { now: this.now })
                group = { opId, resource, action, entries: [] }
                groupsByKey.set(groupKey, group)
                groups.push(group)
            }
            group.entries.push({ index: i, entry })
        }

        const ops: Operation[] = []
        for (const group of groups) {
            ops.push(Protocol.ops.build.buildWriteOp({
                opId: group.opId,
                write: {
                    resource: group.resource,
                    action: group.action,
                    items: group.entries.map(e => e.entry.item),
                    options: { returning: input.returning }
                }
            }))
        }

        const byId = new Map<string, OperationResult>()
        if (ops.length) {
            const res = await this.ctx.io.executeOps({
                channel: 'remote',
                ops,
                meta: input.meta,
                signal: input.signal
            })
            for (const r of (res as any)?.results ?? []) {
                if (r && typeof r === 'object' && typeof (r as any).opId === 'string') {
                    byId.set((r as any).opId, r as any)
                }
            }
        }

        for (const group of groups) {
            const result = byId.get(group.opId)
            if (!result) {
                rejectGroup(outcomes, group, {
                    code: 'WRITE_FAILED',
                    message: 'Missing write result',
                    kind: 'internal' as const
                })
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

                outcomes[mapped.index] = itemResult.ok === true
                    ? { kind: 'ack', result: itemResult as any }
                    : { kind: 'reject', result: itemResult as any }
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
}

function rejectGroup(outcomes: SyncPushOutcome[], group: { entries: Array<{ index: number }> }, error: any) {
    for (const e of group.entries) {
        outcomes[e.index] = {
            kind: 'reject',
            result: { index: 0, ok: false, error } as any
        }
    }
}

function isRetryableOpError(error: any): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = (error as any).kind
    return kind === 'internal' || kind === 'adapter'
}

function decodeNotifyMessage(raw: unknown): NotifyMessage {
    if (typeof raw === 'string') {
        return Protocol.sse.parse.notifyMessage(raw)
    }
    if (raw && typeof raw === 'object') {
        const resources2 = (raw as any).resources
        const traceId = (raw as any).traceId
        return {
            ...(Array.isArray(resources2) ? { resources: resources2.map((r: any) => String(r)) } : {}),
            ...(typeof traceId === 'string' ? { traceId } : {})
        }
    }
    throw new Error('[atoma-sync] notify message: unsupported payload')
}

