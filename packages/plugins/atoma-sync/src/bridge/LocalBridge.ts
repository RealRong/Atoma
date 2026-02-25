import type { PluginContext } from 'atoma-types/client/plugins'
import type { StoreChange } from 'atoma-types/core'
import type { SyncEvent, SyncPhase } from 'atoma-types/sync'
import { toLocalSyncDocs } from '../mapping/document'
import type { ReadyRuntime } from '../runtime/contracts'

type WriteCommittedEvent = Readonly<{
    storeName: string
    context?: Readonly<{
        origin?: unknown
    }>
    changes?: ReadonlyArray<StoreChange<any>>
}>

export class LocalBridge {
    private disposed = false
    private unregister: (() => void) | undefined

    constructor(private readonly args: {
        ctx: PluginContext
        ensureReady: () => Promise<ReadyRuntime>
        now: () => number
        emitEvent: (event: SyncEvent) => void
        reportError: (error: unknown, phase: SyncPhase) => void
    }) {}

    mount(): void {
        if (this.unregister) return
        this.unregister = this.args.ctx.events.on('writeCommitted', (event) => {
            this.onWriteCommitted(event as WriteCommittedEvent)
        })
    }

    dispose(): void {
        this.disposed = true
        const unregister = this.unregister
        this.unregister = undefined
        if (!unregister) return

        try {
            unregister()
        } catch {
            // ignore
        }
    }

    private onWriteCommitted(event: WriteCommittedEvent): void {
        if (this.disposed) return
        if (String(event.context?.origin ?? '') === 'sync') return

        void this.applyLocal(event).catch((error) => {
            this.args.reportError(error, 'bridge')
        })
    }

    private async applyLocal(event: WriteCommittedEvent): Promise<void> {
        const runtime = await this.args.ensureReady()
        const target = runtime.resourceByStoreName.get(String(event.storeName))
        if (!target) return

        const collection = runtime.collectionByResource.get(target.resource)
        if (!collection) return

        const changes = Array.isArray(event.changes)
            ? event.changes as ReadonlyArray<StoreChange<any>>
            : []
        if (!changes.length) return

        const docs = toLocalSyncDocs({
            changes,
            resource: target.resource,
            clientId: this.args.ctx.clientId,
            now: this.args.now
        })
        if (!docs.length) return

        const result = await collection.bulkUpsert(docs)
        if (result.error.length) {
            const first = result.error[0]
            throw first instanceof Error
                ? first
                : new Error('[Sync] Failed to persist local write into RxDB collection')
        }

        this.args.emitEvent({
            type: 'sync.bridge.localWrite',
            resource: target.resource,
            count: docs.length
        })
    }
}
