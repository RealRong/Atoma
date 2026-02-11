import type { Entity } from 'atoma-types/core'
import type { PersistRequest, PersistResult, Runtime } from 'atoma-types/runtime'
import type { OutboxStore, OutboxWrite } from 'atoma-types/sync'

function mapWriteEntriesToOutboxWrites(req: PersistRequest<any>): OutboxWrite[] {
    const out: OutboxWrite[] = []
    const resource = String(req.storeName)

    for (const entry of req.writeEntries) {
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

export class SyncPersistHandlers {
    private readonly unregister: Array<() => void> = []
    private disposed = false

    constructor(private readonly deps: { runtime: Runtime; outbox: OutboxStore }) {
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

        this.unregister.push(runtime.strategy.register('queue', {
            write: { implicitFetch: false },
            persist: async <T extends Entity>(x: {
                req: PersistRequest<T>
                next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
            }) => {
                const writes = mapWriteEntriesToOutboxWrites(x.req)
                if (writes.length) await outbox.enqueueWrites({ writes })
                return { status: 'enqueued' } as PersistResult<T>
            }
        }))

        this.unregister.push(runtime.strategy.register('local-first', {
            write: { implicitFetch: true },
            persist: async <T extends Entity>(x: {
                req: PersistRequest<T>
                next: (req: PersistRequest<T>) => Promise<PersistResult<T>>
            }) => {
                const direct = await x.next(x.req)
                const writes = mapWriteEntriesToOutboxWrites(x.req)
                if (writes.length) await outbox.enqueueWrites({ writes })
                return {
                    status: 'enqueued',
                    ...(direct.results ? { results: direct.results } : {})
                } as PersistResult<T>
            }
        }))
    }
}
