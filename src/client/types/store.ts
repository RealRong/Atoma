import type { CoreStore, Entity, IDataSource, IStore, JotaiStore, StoreKey, StoreServices } from '#core'
import type { InferRelationsFromSchema } from './relations'
import type { AtomaSchema } from './schema'

export type AtomaClientContext<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = {
    jotaiStore: JotaiStore
    services: StoreServices
    defaults: {
        dataSourceFactory: <Name extends keyof Entities & string>(name: Name) => IDataSource<Entities[Name]>
        idGenerator?: () => StoreKey
    }
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>
    resolveStore: <Name extends keyof Entities & string>(name: Name) => IStore<Entities[Name], InferRelationsFromSchema<Entities, Schema, Name>>
}
