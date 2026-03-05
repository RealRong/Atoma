import type { RxJsonSchema } from 'rxdb'
import type { SyncResourceRuntime, SyncDoc } from '../runtime/contracts'
import type { SyncResourceConfig } from '../types'
import { isRecord, normalizeName } from '../utils/common'

export function normalizeResources(input: ReadonlyArray<string | SyncResourceConfig>): ReadonlyArray<SyncResourceRuntime> {
    if (!Array.isArray(input) || input.length === 0) {
        throw new Error('[Sync] resources is required')
    }

    const usedResources = new Set<string>()
    const usedCollectionNames = new Set<string>()

    const result: SyncResourceRuntime[] = input.map((item) => {
        const config = typeof item === 'string'
            ? ({ resource: item } as SyncResourceConfig)
            : item

        const resource = String(config.resource ?? '').trim()
        if (!resource) {
            throw new Error('[Sync] resource name must be non-empty')
        }
        if (usedResources.has(resource)) {
            throw new Error(`[Sync] duplicated resource: ${resource}`)
        }
        usedResources.add(resource)

        const storeName = String(config.storeName ?? resource).trim()
        if (!storeName) {
            throw new Error(`[Sync] storeName must be non-empty for resource: ${resource}`)
        }

        const collectionName = ensureUniqueCollectionName(
            String(config.collectionName ?? resource),
            usedCollectionNames
        )

        const schema = isRecord(config.schema)
            ? config.schema as RxJsonSchema<SyncDoc>
            : createDefaultSchema(resource)

        return {
            resource,
            storeName,
            collectionName,
            schema
        }
    })

    return result
}

function createDefaultSchema(resource: string): RxJsonSchema<SyncDoc> {
    const schema = {
        title: `atoma_sync_${normalizeName(resource)}`,
        version: 0,
        type: 'object',
        primaryKey: 'id',
        properties: {
            id: {
                type: 'string',
                maxLength: 200
            },
            version: {
                type: 'integer',
                minimum: 1,
                maximum: 9007199254740991,
                multipleOf: 1
            },
            _deleted: {
                type: 'boolean'
            },
            atomaSync: {
                type: 'object',
                properties: {
                    resource: {
                        type: 'string'
                    },
                    source: {
                        type: 'string'
                    },
                    idempotencyKey: {
                        type: 'string'
                    },
                    changedAtMs: {
                        type: 'number'
                    },
                    clientId: {
                        type: 'string'
                    }
                },
                additionalProperties: true,
                required: ['resource']
            }
        },
        required: ['id', 'version'],
        additionalProperties: true
    }

    return schema as unknown as RxJsonSchema<SyncDoc>
}

function ensureUniqueCollectionName(rawName: string, used: Set<string>): string {
    const base = normalizeName(rawName) || 'resource'

    let name = base
    let suffix = 1
    while (used.has(name)) {
        suffix += 1
        name = `${base}_${suffix}`
    }

    used.add(name)
    return name
}
