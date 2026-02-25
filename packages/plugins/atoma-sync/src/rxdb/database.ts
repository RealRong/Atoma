import { createRxDatabase, type RxCollection, type RxJsonSchema } from 'rxdb'
import { getRxStorageMemory } from 'rxdb/plugins/storage-memory'
import type { ReadyRuntime, DatabaseCollections, SyncDoc, SyncResourceRuntime } from '../runtime/contracts'
import { normalizeName } from '../utils/common'

export async function createReadyRuntime(args: {
    clientId: string
    resources: ReadonlyArray<SyncResourceRuntime>
}): Promise<ReadyRuntime> {
    const resourceDigest = args.resources
        .map(item => item.resource)
        .sort()
        .join('-')
    const dbName = `atoma_sync_${normalizeName(args.clientId)}_${normalizeName(resourceDigest)}`.slice(0, 90)

    const database = await createRxDatabase<DatabaseCollections>({
        name: dbName,
        storage: getRxStorageMemory(),
        multiInstance: false,
        ignoreDuplicate: true
    })

    const collectionCreators: Record<string, { schema: RxJsonSchema<SyncDoc> }> = {}
    args.resources.forEach((resource) => {
        collectionCreators[resource.collectionName] = {
            schema: resource.schema
        }
    })

    const collections = await database.addCollections(collectionCreators)
    const collectionByResource = new Map<string, RxCollection<SyncDoc>>()
    const resourceByStoreName = new Map<string, SyncResourceRuntime>()

    args.resources.forEach((resource) => {
        const collection = collections[resource.collectionName]
        if (!collection) {
            throw new Error(`[Sync] Missing RxDB collection for resource: ${resource.resource}`)
        }
        collectionByResource.set(resource.resource, collection)
        resourceByStoreName.set(resource.storeName, resource)
    })

    return {
        database,
        resources: args.resources,
        resourceByStoreName,
        collectionByResource
    }
}
