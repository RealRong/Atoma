import type { Entity, Store } from '../core'
import type { Runtime } from '../runtime'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'

export type ClientRuntime = Runtime

export interface PluginCapableClient {
    dispose: () => void
}

export type AtomaStore<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>,
    Name extends keyof Entities & string
> = Store<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>

export type AtomaStores<
    Entities extends Record<string, Entity>,
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
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = PluginCapableClient & {
    stores: AtomaStores<Entities, Schema>
}
