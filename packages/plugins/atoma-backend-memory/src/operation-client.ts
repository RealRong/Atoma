import { StorageOperationClient } from 'atoma-backend-shared'
import { isRecord } from 'atoma-shared'

type ResourceStore = Map<string, any>

export class MemoryOperationClient extends StorageOperationClient {
    private readonly storesByResource = new Map<string, ResourceStore>()

    constructor(config?: {
        seed?: Record<string, any[]>
    }) {
        super({
            adapter: {
                list: async (resource) => Array.from(this.requireStore(resource).values()),
                get: async (resource, id) => this.requireStore(resource).get(id),
                put: async (resource, id, value) => {
                    this.requireStore(resource).set(id, value)
                },
                delete: async (resource, id) => {
                    this.requireStore(resource).delete(id)
                }
            }
        })

        if (config?.seed && isRecord(config.seed)) {
            Object.entries(config.seed).forEach(([resource, items]) => {
                if (!Array.isArray(items)) return
                const store = this.requireStore(resource)
                items.forEach(item => {
                    const rawId = (item as any)?.id
                    if (rawId === undefined) return
                    const id = String(rawId)
                    const current = isRecord(item) ? { ...(item as any) } : item
                    if (isRecord(current)) {
                        current.id = id
                        if (!(typeof current.version === 'number' && Number.isFinite(current.version) && current.version >= 1)) {
                            current.version = 1
                        }
                    }
                    store.set(id, current)
                })
            })
        }
    }

    private requireStore(resource: string): ResourceStore {
        const key = String(resource || '')
        const existing = this.storesByResource.get(key)
        if (existing) return existing
        const next: ResourceStore = new Map()
        this.storesByResource.set(key, next)
        return next
    }
}
