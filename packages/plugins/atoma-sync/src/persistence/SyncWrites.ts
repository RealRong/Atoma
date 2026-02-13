import type { Entity } from 'atoma-types/core'
import type { RuntimeExtensionFacade } from 'atoma-types/client/plugins'
import type { WriteInput, WriteOutput } from 'atoma-types/runtime'
import type { OutboxStore, OutboxWrite } from 'atoma-types/sync'

function mapWriteEntriesToOutboxWrites(input: WriteInput<any>): OutboxWrite[] {
    const out: OutboxWrite[] = []
    const resource = String(input.storeName)

    for (const entry of input.writeEntries) {
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

function asDirectWrite<T extends Entity>(input: WriteInput<T>): WriteInput<T> {
    return {
        ...input,
        writeStrategy: 'direct'
    }
}

export class SyncWrites {
    private readonly unregister: Array<() => void> = []
    private disposed = false

    constructor(private readonly deps: { runtime: RuntimeExtensionFacade; outbox: OutboxStore }) {
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
            policy: { implicitFetch: false },
            write: async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
                const writes = mapWriteEntriesToOutboxWrites(input)
                if (writes.length) await outbox.enqueueWrites({ writes })
                return { status: 'enqueued' }
            }
        }))

        this.unregister.push(runtime.strategy.register('local-first', {
            policy: { implicitFetch: true },
            write: async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
                const direct = await runtime.strategy.write(asDirectWrite(input))
                const writes = mapWriteEntriesToOutboxWrites(input)
                if (writes.length) await outbox.enqueueWrites({ writes })
                return {
                    status: 'enqueued',
                    ...(direct.results ? { results: direct.results } : {})
                }
            }
        }))
    }
}
