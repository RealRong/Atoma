import type { Table } from 'dexie'
import { StorageOpsClient } from 'atoma-backend-shared'
import { zod } from 'atoma-shared'

const { parseOrThrow, z } = zod

function isPlainObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function clonePlain(value: any) {
    return value ? JSON.parse(JSON.stringify(value)) : value
}

function serializeValue(value: any) {
    const cloned = isPlainObject(value) ? { ...value } : value

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

export class IndexedDBOpsClient extends StorageOpsClient {
    constructor(config: {
        tableForResource: (resource: string) => Table<any, string>
    }) {
        const parsed = parseOrThrow(
            z.object({ tableForResource: z.any() })
                .loose()
                .superRefine((value: any, ctx) => {
                    if (typeof value.tableForResource !== 'function') {
                        ctx.addIssue({ code: 'custom', message: '[IndexedDBOpsClient] config.tableForResource is required' })
                    }
                }),
            config,
            { prefix: '' }
        ) as any

        super({
            adapter: {
                list: async (resource) => await parsed.tableForResource(resource).toArray(),
                get: async (resource, id) => {
                    const existing = await parsed.tableForResource(resource).get(id as any)
                    return existing ?? undefined
                },
                put: async (resource, id, value) => {
                    await parsed.tableForResource(resource).put(value, id as any)
                },
                delete: async (resource, id) => {
                    await parsed.tableForResource(resource).delete(id as any)
                }
            },
            toStoredValue: serializeValue,
            toResponseValue: clonePlain
        })
    }
}
