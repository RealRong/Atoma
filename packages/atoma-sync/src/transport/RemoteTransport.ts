import type { ClientPluginContext } from 'atoma/client'
import type { WriteItemResult, WriteResultData } from 'atoma/protocol'
import type { SyncPushOutcome, SyncSubscribe, SyncTransport } from '#sync/types'

export class RemoteTransport implements SyncTransport {
    readonly subscribe?: SyncSubscribe

    constructor(private readonly ctx: ClientPluginContext) {
        if (this.ctx.remote.subscribeNotify) {
            this.subscribe = (args) => this.ctx.remote.subscribeNotify!({
                resources: args.resources,
                signal: args.signal,
                onError: args.onError,
                onMessage: (msg) => args.onMessage(msg as any)
            })
        }
    }

    pullChanges: SyncTransport['pullChanges'] = async (input) => {
        return await this.ctx.remote.changes.pull({
            cursor: input.cursor,
            limit: input.limit,
            ...(input.resources?.length ? { resources: input.resources } : {}),
            ...(input.signal ? { signal: input.signal } : {})
        })
    }

    pushWrites: SyncTransport['pushWrites'] = async (input) => {
        const outcomes: SyncPushOutcome[] = new Array(input.entries.length)

        type Group = {
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
                group = { resource, action, entries: [] }
                groupsByKey.set(groupKey, group)
                groups.push(group)
            }
            group.entries.push({ index: i, entry })
        }

        for (const group of groups) {
            let data: WriteResultData
            try {
                data = await this.ctx.remote.write({
                    store: group.resource as any,
                    action: group.action,
                    items: group.entries.map(e => e.entry.item),
                    options: { returning: input.returning },
                    ...(input.signal ? { signal: input.signal } : {})
                } as any)
            } catch (error) {
                const payload = (error as any)?.error ?? error
                if (isRetryableOpError(payload)) {
                    for (const e of group.entries) {
                        outcomes[e.index] = { kind: 'retry', error: payload }
                    }
                } else {
                    for (const e of group.entries) {
                        outcomes[e.index] = {
                            kind: 'reject',
                            result: { index: 0, ok: false, error: payload } as any
                        }
                    }
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

function isRetryableOpError(error: any): boolean {
    if (!error || typeof error !== 'object') return false
    if (error.retryable === true) return true
    const kind = error.kind
    return kind === 'internal' || kind === 'adapter'
}

