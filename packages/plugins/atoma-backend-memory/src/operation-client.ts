import { StorageOperationClient } from 'atoma-backend-shared'

type ResourceStore = Map<string, any>

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

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

        if (config?.seed && isPlainObject(config.seed)) {
            Object.entries(config.seed).forEach(([resource, items]) => {
                if (!Array.isArray(items)) return
                const store = this.requireStore(resource)
                items.forEach(item => {
                    const rawId = (item as any)?.id
                    if (rawId === undefined) return
                    const id = String(rawId)
                    const current = isPlainObject(item) ? { ...(item as any) } : item
                    if (isPlainObject(current)) {
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
