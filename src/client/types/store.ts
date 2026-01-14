import type { CoreStore, Entity, IStore, JotaiStore, StoreBackend, StoreServices } from '#core'
import type { EntityId } from '#protocol'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'

export type AtomaClientContext<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    jotaiStore: JotaiStore
    services: StoreServices
    defaults: {
        backendFactory: <Name extends keyof Entities & string>(name: Name) => StoreBackend
        idGenerator?: () => EntityId
    }
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>
    resolveStore: <Name extends keyof Entities & string>(name: Name) => IStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>
}
