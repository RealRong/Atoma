import type { Entity, Store } from '../core'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'

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

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = PluginCapableClient & {
    stores: AtomaStores<Entities, Schema>
}
