import type { PluginEvents, PluginRuntime } from 'atoma-types/client/plugins'
import type { WriteEntry, WriteItemResult, WriteOutput } from 'atoma-types/runtime'
import type { OutboxStore, OutboxWrite, SyncEvent, SyncPhase } from 'atoma-types/sync'
import { toError } from '#sync/internal'

function mapWriteEntriesToOutboxWrites(args: {
    storeName: string
    writeEntries: ReadonlyArray<WriteEntry>
}): OutboxWrite[] {
    const out: OutboxWrite[] = []
    const resource = String(args.storeName)

    for (const entry of args.writeEntries) {
        const action = entry?.action
        const item = entry?.item
        const options = (entry?.options && typeof entry.options === 'object') ? entry.options : undefined

        if (!resource || !action || !item) {
            throw new Error('[atoma-sync] outbox: write entry 必须包含 resource/action/item')
        }

        if (options && Object.keys(options as any).length > 0) {
            throw new Error('[atoma-sync] outbox: 不支持 write entry options（请通过 sync 配置控制行为）')
        }

        const meta = item?.meta
        if (!meta || typeof meta !== 'object') {
            throw new Error('[atoma-sync] outbox: write item meta 必填（需要 idempotencyKey/clientTimeMs）')
        }
        if (typeof meta.idempotencyKey !== 'string' || !meta.idempotencyKey) {
            throw new Error('[atoma-sync] outbox: write item meta.idempotencyKey 必填')
        }
        if (typeof meta.clientTimeMs !== 'number' || !Number.isFinite(meta.clientTimeMs)) {
            throw new Error('[atoma-sync] outbox: write item meta.clientTimeMs 必填')
        }

        out.push({
            resource,
            entry
        })
    }

    return out
}

export class SyncWrites {
    private readonly unregister: Array<() => void> = []
    private disposed = false
    private readonly resourcesAllowSet?: ReadonlySet<string>

    constructor(private readonly deps: {
        runtime: PluginRuntime
        events: PluginEvents
        outbox: OutboxStore
        resources?: ReadonlyArray<string>
        onEvent?: (event: SyncEvent) => void
        onError?: (error: Error, context: { phase: SyncPhase }) => void
    }) {
        const resources = deps.resources
            ?.map(value => String(value ?? '').trim())
            .filter(Boolean)
        if (resources?.length) {
            this.resourcesAllowSet = new Set(resources)
        }
        this.register()
    }

    dispose() {
        if (this.disposed) return
        this.disposed = true
        for (let i = this.unregister.length - 1; i >= 0; i--) {
            try {
                this.unregister[i]()
            } catch {
                // ignore
            }
        }
        this.unregister.length = 0
    }

    private register() {
        const { runtime, outbox } = this.deps

        this.unregister.push(this.deps.events.register({
            write: {
                onCommitted: (event: {
                    storeName: string
                    context: { origin: string }
                    writeEntries: ReadonlyArray<WriteEntry>
                }) => {
                    if (runtime.execution.hasExecutor('write')) return
                    if (event.context.origin === 'sync') return

                    const resource = String(event.storeName)
                    if (this.resourcesAllowSet && !this.resourcesAllowSet.has(resource)) return

                    const writeEntries = [...event.writeEntries]
                    if (!writeEntries.length) return

                    let writes: OutboxWrite[]
                    try {
                        writes = mapWriteEntriesToOutboxWrites({
                            storeName: resource,
                            writeEntries
                        })
                    } catch (error) {
                        this.reportEnqueueFailure({
                            resource,
                            count: writeEntries.length,
                            error
                        })
                        return
                    }

                    void outbox.enqueueWrites({ writes }).catch((error) => {
                        this.reportEnqueueFailure({
                            resource,
                            count: writes.length,
                            error
                        })
                    })
                }
            }
        }))

        this.unregister.push(runtime.execution.subscribe((event) => {
            if (event.type !== 'write.succeeded') return
            if (event.output.status === 'enqueued') return

            const writeEntries = filterWriteEntriesByResults({
                status: event.output.status,
                writeEntries: event.request.entries,
                results: event.output.results
            })
            if (!writeEntries.length) return

            const resource = String(event.request.handle.storeName)
            if (this.resourcesAllowSet && !this.resourcesAllowSet.has(resource)) return

            let writes: OutboxWrite[]
            try {
                writes = mapWriteEntriesToOutboxWrites({
                    storeName: resource,
                    writeEntries
                })
            } catch (error) {
                this.reportEnqueueFailure({
                    resource,
                    count: writeEntries.length,
                    error
                })
                return
            }
            if (!writes.length) return

            void outbox.enqueueWrites({ writes }).catch((error) => {
                this.reportEnqueueFailure({
                    resource,
                    count: writes.length,
                    error
                })
            })
        }))
    }

    private reportEnqueueFailure(args: {
        resource: string
        count: number
        error: unknown
    }) {
        const error = toError(args.error)
        this.deps.onEvent?.({
            type: 'outbox:enqueue_failed',
            resource: args.resource,
            count: args.count,
            error
        })
        this.deps.onError?.(error, { phase: 'outbox' })
    }
}

function filterWriteEntriesByResults(args: {
    status: WriteOutput['status']
    writeEntries: ReadonlyArray<WriteEntry>
    results?: ReadonlyArray<WriteItemResult>
}): WriteEntry[] {
    if (args.status === 'enqueued') return []
    if (!args.results || !args.results.length) {
        if (args.status === 'rejected' || args.status === 'partial') {
            return []
        }
        return [...args.writeEntries]
    }

    if (args.results.length !== args.writeEntries.length) {
        return args.status === 'confirmed' ? [...args.writeEntries] : []
    }

    const accepted: WriteEntry[] = []
    for (let index = 0; index < args.writeEntries.length; index++) {
        const result = args.results[index]
        if (!result?.ok) continue
        accepted.push(args.writeEntries[index])
    }

    return accepted
}
