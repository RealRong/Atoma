import { Patch } from 'immer'
import { PatchMetadata, StoreKey } from '../../core/types'

export type PatchHandlers<T> = {
    sendDeleteRequest: (key: StoreKey) => Promise<void>
    sendCreateRequest: (key: StoreKey, value: T) => Promise<void>
    sendPatchRequest: (id: StoreKey, patches: Patch[], metadata: PatchMetadata) => Promise<void>
    sendPutRequest: (key: StoreKey, value: T) => Promise<void>
}

export async function applyPatchesWithFallback<T>(
    patches: Patch[],
    metadata: PatchMetadata,
    handlers: PatchHandlers<T>,
    supportsPatch: boolean
): Promise<void> {
    if (!supportsPatch) {
        return applyPatchesViaOperations(patches, handlers)
    }

    // Group patches by ID
    const patchesByItemId = new Map<StoreKey, Patch[]>()

    patches.forEach(patch => {
        const itemId = patch.path[0] as StoreKey
        if (!patchesByItemId.has(itemId)) {
            patchesByItemId.set(itemId, [])
        }
        patchesByItemId.get(itemId)!.push(patch)
    })

    for (const [itemId, itemPatches] of patchesByItemId.entries()) {
        // Check for entity-level delete: op='remove' AND path length is 1 (just the ID)
        const isEntityDelete = itemPatches.some(patch => patch.op === 'remove' && patch.path.length === 1)
        if (isEntityDelete) {
            await handlers.sendDeleteRequest(itemId)
            continue
        }

        // Check for entity-level create: op='add' AND path length is 1
        const isEntityCreate = itemPatches.some(patch => patch.op === 'add' && patch.path.length === 1)
        if (isEntityCreate) {
            // Find the value from the add patch
            const addPatch = itemPatches.find(patch => patch.op === 'add' && patch.path.length === 1)
            if (addPatch) {
                await handlers.sendCreateRequest(itemId, addPatch.value as T)
                continue
            }
        }

        // Otherwise it's a patch (property update)
        await handlers.sendPatchRequest(itemId, itemPatches, metadata)
    }
}

export async function applyPatchesViaOperations<T>(
    patches: Patch[],
    handlers: PatchHandlers<T>
): Promise<void> {
    for (const patch of patches) {
        const key = patch.path[0] as StoreKey

        // Entity Delete
        if (patch.op === 'remove' && patch.path.length === 1) {
            await handlers.sendDeleteRequest(key)
            continue
        }

        // Entity Create
        if (patch.op === 'add' && patch.path.length === 1) {
            await handlers.sendCreateRequest(key, patch.value as T)
            continue
        }

        // Property Update -> Treat as PUT (Replace whole object) if we can't PATCH
        // Note: This is imperfect because we might not have the full object value in a property patch.
        // But for 'replace' on root properties, it might work if the value is the whole object (unlikely for Immer patches on Map).
        // If we are here, it means we are trying to update a property but don't support PATCH.
        // We probably need to fetch-merge-put or just fail. 
        // For now, we assume 'replace' on path length 1 is a full PUT.
        if (patch.op === 'replace' && patch.path.length === 1) {
            await handlers.sendPutRequest(key, patch.value as T)
        }

        // If path.length > 1, we can't easily map a single property change to a PUT without the full object.
        // This is a limitation of "no patch support".
    }
}
