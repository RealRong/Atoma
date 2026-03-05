import type { Table } from 'dexie'
import { StorageOperationClient } from 'atoma-backend-shared'
import { isRecord } from 'atoma-shared'

function clonePlain(value: any) {
    return value ? JSON.parse(JSON.stringify(value)) : value
}

function serializeValue(value: any) {
    const cloned = isRecord(value) ? { ...value } : value

    const iterate = (obj: any) => {
        const stack = [obj]
        while (stack.length > 0) {
            const currentObj = stack.pop()
            if (!currentObj || typeof currentObj !== 'object') continue

            Object.keys(currentObj).forEach(key => {
                if (currentObj[key] instanceof Map) {
                    currentObj[key] = Array.from(currentObj[key].values())
                } else if (currentObj[key] instanceof Set) {
                    currentObj[key] = Array.from(currentObj[key])
                } else if (typeof currentObj[key] === 'object' && currentObj[key] !== null) {
                    stack.push(currentObj[key])
                }
            })
        }
    }

    iterate(cloned)
    return cloned
}

function requireTableResolver(config: {
    tableForResource: (resource: string) => Table<any, string>
}): (resource: string) => Table<any, string> {
    if (typeof config.tableForResource !== 'function') {
        throw new Error('[IndexedDbOperationClient] config.tableForResource is required')
    }
    return config.tableForResource
}

export class IndexedDbOperationClient extends StorageOperationClient {
    constructor(config: {
        tableForResource: (resource: string) => Table<any, string>
    }) {
        const tableForResource = requireTableResolver(config)

        super({
            adapter: {
                list: async (resource) => await tableForResource(resource).toArray(),
                get: async (resource, id) => {
                    const existing = await tableForResource(resource).get(id as any)
                    return existing ?? undefined
                },
                put: async (resource, id, value) => {
                    await tableForResource(resource).put(value, id as any)
                },
                delete: async (resource, id) => {
                    await tableForResource(resource).delete(id as any)
                }
            },
            toStoredValue: serializeValue,
            toResponseValue: clonePlain
        })
    }
}
