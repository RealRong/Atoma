import type { Entity, StoreApi } from '#core'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'
import type { PluginCapableClient } from './plugin'

export type AtomaStore<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>,
    Name extends keyof Entities & string
> = StoreApi<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>

export type AtomaStores<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>
> =
    & (<Name extends keyof Entities & string>(name: Name) => AtomaStore<Entities, Schema, Name>)
    & { [K in keyof Entities & string]: AtomaStore<Entities, Schema, K> }

export type AtomaHistory = {
    canUndo: (scope?: string) => boolean
    canRedo: (scope?: string) => boolean
    clear: (scope?: string) => void
    undo: (args?: { scope?: string }) => Promise<boolean>
    redo: (args?: { scope?: string }) => Promise<boolean>
}

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = PluginCapableClient & {
    /**
     * Unified store accessor.
     * - `client.stores.Todo` (best DX / autocomplete)
     * - `client.stores('Todo')` (dynamic name)
     */
    stores: AtomaStores<Entities, Schema>
    History: AtomaHistory
}
