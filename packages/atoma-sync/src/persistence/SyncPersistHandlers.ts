import type { ClientPluginContext } from 'atoma-client'
import type { Entity } from 'atoma-core'
import type { PersistRequest, PersistResult } from 'atoma-runtime/types/persistenceTypes'
import type { WriteAction, WriteItem, WriteOptions } from 'atoma-protocol'
import type { OutboxStore, OutboxWrite } from '#sync/types'

function mapTranslatedWriteOpsToOutboxWrites(writeOps: PersistRequest<any>['writeOps']): OutboxWrite[] {
    const out: OutboxWrite[] = []
    for (const w of writeOps) {
        const op: any = w.op
        if (!op || op.kind !== 'write') {
            throw new Error('[atoma-sync] outbox: 仅支持 write op（TranslatedWriteOp.op.kind 必须为 "write"）')
        }

        const write: any = op.write
        const resource = String(write?.resource ?? '')
        const action = write?.action as WriteAction
        const options = (write?.options && typeof write.options === 'object') ? (write.options as WriteOptions) : undefined
        const items: WriteItem[] = Array.isArray(write?.items) ? (write.items as WriteItem[]) : []
        if (!resource || !action || items.length !== 1) {
            throw new Error('[atoma-sync] outbox: write op 必须包含 resource/action 且只能有 1 个 item')
        }

        // We intentionally do not support per-write protocol options in the outbox.
        // Keep the sync semantics uniform and controlled by the sync runtime config.
        if (options && Object.keys(options as any).length > 0) {
            throw new Error('[atoma-sync] outbox: 不支持 write.options（请通过 sync 配置控制行为）')
        }

        const item = items[0]
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
            action,
            item,
        })
    }
    return out
}

export class SyncPersistHandlers {
    private readonly unregister: Array<() => void> = []
    private disposed = false

    constructor(private readonly deps: { ctx: ClientPluginContext; outbox: OutboxStore }) {
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
        const { ctx, outbox } = this.deps

        this.unregister.push(ctx.persistence.register('queue', {
            write: { implicitFetch: false },
            persist: async <T extends Entity>(x: {
                req: PersistRequest<T>
                next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
            }) => {
                const writes = mapTranslatedWriteOpsToOutboxWrites(x.req.writeOps)
                if (writes.length) await outbox.enqueueWrites({ writes })
                return { status: 'enqueued' } as PersistResult<T>
            }
        }))

        this.unregister.push(ctx.persistence.register('local-first', {
            write: { implicitFetch: true },
            persist: async <T extends Entity>(x: {
                req: PersistRequest<T>
                next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
            }) => {
                const direct = await x.next(x.req)
                const writes = mapTranslatedWriteOpsToOutboxWrites(x.req.writeOps)
                if (writes.length) await outbox.enqueueWrites({ writes })
                return {
                    status: 'enqueued',
                    ...(direct.ack ? { ack: direct.ack } : {})
                } as PersistResult<T>
            }
        }))
    }
}
