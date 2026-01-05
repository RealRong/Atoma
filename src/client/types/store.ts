import type { CoreStore, CoreStoreConfig, Entity, IDataSource, IStore, JotaiStore, RelationMap, StoreConfig, StoreKey } from '#core'
import type { RelationMapFromSchema, RelationsDsl, RelationsSchema, StoreOverrideConstraint, InferRelationsFromStoreOverride } from './relations'

export type CreateAtomaStoreOptions<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores = {},
    Relations = {}
> = Omit<CoreStoreConfig<Entities[Name]>, 'name' | 'dataSource' | 'relations' | 'store'> & {
    name: Name
    dataSource?: IDataSource<Entities[Name]>
    relations?: Relations
}

type CreateAtomaStoreOptionsFactory<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores,
    Relations extends RelationMap<Entities[Name]>
> = Omit<CoreStoreConfig<Entities[Name]>, 'name' | 'dataSource' | 'relations' | 'store'> & {
    name: Name
    dataSource?: IDataSource<Entities[Name]>
    relations?: (dsl: RelationsDsl<Entities, Stores, Entities[Name]>) => Relations
}

type CreateAtomaStoreOptionsSchema<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string,
    Stores,
    Schema extends RelationsSchema<Entities, Stores, Name>
> = Omit<CoreStoreConfig<Entities[Name]>, 'name' | 'dataSource' | 'relations' | 'store'> & {
    name: Name
    dataSource?: IDataSource<Entities[Name]>
    relations?: Schema
}

export type StoresConstraint<Entities extends Record<string, Entity>> =
    Partial<{ [Name in keyof Entities & string]: StoreOverrideConstraint<Entities, Name> }>

export type AtomaStoresConfig<Entities extends Record<string, Entity>> =
    StoresConstraint<Entities>

export type AtomaClientContext<
    Entities extends Record<string, Entity>,
    Stores = {}
> = {
    jotaiStore: JotaiStore
    defaults: {
        dataSourceFactory: <Name extends keyof Entities & string>(name: Name) => IDataSource<Entities[Name]>
        idGenerator?: () => StoreKey
    }
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    resolveStore: <Name extends keyof Entities & string>(name: Name) => IStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
}

export type CreateAtomaStore = {
    <
        Entities extends Record<string, Entity>,
        Name extends keyof Entities & string,
        Stores,
        const Schema extends RelationsSchema<Entities, Stores, Name> = {}
    >(
        ctx: AtomaClientContext<Entities, Stores>,
        options: CreateAtomaStoreOptionsSchema<Entities, Name, Stores, Schema>
    ): CoreStore<Entities[Name], RelationMapFromSchema<Entities, Stores, Name, Schema>>

    <
        Entities extends Record<string, Entity>,
        Name extends keyof Entities & string,
        Stores,
        const Relations extends RelationMap<Entities[Name]> = {}
    >(
        ctx: AtomaClientContext<Entities, Stores>,
        options: CreateAtomaStoreOptionsFactory<Entities, Name, Stores, Relations>
    ): CoreStore<Entities[Name], Relations>

    <
        Entities extends Record<string, Entity>,
        Name extends keyof Entities & string,
        Stores
    >(
        ctx: AtomaClientContext<Entities, Stores>,
        options: CreateAtomaStoreOptions<Entities, Name, Stores, any>
    ): CoreStore<Entities[Name], any>
}

