import type * as Types from '../core'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'
export interface PluginCapableClient {
    dispose: () => void
}

export type AtomaStore<
    Entities extends Record<string, Types.Entity>,
    Schema extends AtomaSchema<Entities>,
    Name extends keyof Entities & string
> = Types.StoreApi<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>

export type AtomaStores<
    Entities extends Record<string, Types.Entity>,
    Schema extends AtomaSchema<Entities>
> =
    & (<Name extends keyof Entities & string>(name: Name) => AtomaStore<Entities, Schema, Name>)

export type AtomaHistory = {
    canUndo: (scope?: string) => boolean
    canRedo: (scope?: string) => boolean
    clear: (scope?: string) => void
    undo: (args?: { scope?: string }) => Promise<boolean>
    redo: (args?: { scope?: string }) => Promise<boolean>
}

export type AtomaClient<
    Entities extends Record<string, Types.Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = PluginCapableClient & {
    /**
     * Unified store accessor.
     * - `client.stores('Todo')` (dynamic name)
     */
    stores: AtomaStores<Entities, Schema>
}
