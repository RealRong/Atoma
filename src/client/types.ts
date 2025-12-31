import type {
    BelongsToConfig,
    CoreStore,
    CoreStoreConfig,
    Entity,
    HasManyConfig,
    HasOneConfig,
    IDataSource,
    IStore,
    InferIncludeType,
    KeySelector,
    JotaiStore,
    RelationIncludeOptions,
    RelationMap,
    StoreKey,
    StoreConfig
} from '#core'
import type { AtomaClientSyncConfig } from './controllers/SyncController'
import type { BackendConfig } from './backend'
import type { BatchQueryConfig } from '../datasources/http/config/types'

type IncludeForRelations<Relations> =
    Partial<{ [K in keyof Relations]: InferIncludeType<Relations[K]> }>

type TargetRelations<
    Entities extends Record<string, Entity>,
    Stores,
    TargetName extends keyof Entities & string
> = InferRelationsFromStoreOverride<Entities, Stores, TargetName>

export type BelongsToSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'belongsTo'
    to: TargetName
    foreignKey: KeySelector<Entities[SourceName]>
    primaryKey?: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
}

export type HasManySchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'hasMany'
    to: TargetName
    primaryKey?: KeySelector<Entities[SourceName]>
    foreignKey: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
}

export type HasOneSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    TargetName extends keyof Entities & string
> = {
    type: 'hasOne'
    to: TargetName
    primaryKey?: KeySelector<Entities[SourceName]>
    foreignKey: keyof Entities[TargetName] & string
    options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
}

export type RelationSchemaItem<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string
> =
    | { [TargetName in keyof Entities & string]: BelongsToSchema<Entities, Stores, SourceName, TargetName> }[keyof Entities & string]
    | { [TargetName in keyof Entities & string]: HasManySchema<Entities, Stores, SourceName, TargetName> }[keyof Entities & string]
    | { [TargetName in keyof Entities & string]: HasOneSchema<Entities, Stores, SourceName, TargetName> }[keyof Entities & string]

export type RelationsSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string
> = Readonly<Record<string, RelationSchemaItem<Entities, Stores, SourceName>>>

export type RelationMapFromSchema<
    Entities extends Record<string, Entity>,
    Stores,
    SourceName extends keyof Entities & string,
    Schema extends RelationsSchema<Entities, Stores, SourceName>
> = {
        readonly [K in keyof Schema]:
        Schema[K] extends { type: 'belongsTo'; to: infer TargetName }
        ? (TargetName extends keyof Entities & string
            ? BelongsToConfig<Entities[SourceName], Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
            : never)
        : Schema[K] extends { type: 'hasMany'; to: infer TargetName }
        ? (TargetName extends keyof Entities & string
            ? HasManyConfig<Entities[SourceName], Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
            : never)
        : Schema[K] extends { type: 'hasOne'; to: infer TargetName }
        ? (TargetName extends keyof Entities & string
            ? HasOneConfig<Entities[SourceName], Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
            : never)
        : never
    }

export type RelationsDsl<
    Entities extends Record<string, Entity>,
    Stores,
    TSource extends Entity
> = {
    belongsTo: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            foreignKey: KeySelector<TSource>
            primaryKey?: keyof Entities[TargetName] & string
            options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
        }
    ) => BelongsToConfig<TSource, Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>

    hasMany: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
        }
    ) => HasManyConfig<TSource, Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>

    hasOne: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: RelationIncludeOptions<Entities[TargetName], IncludeForRelations<TargetRelations<Entities, Stores, TargetName>>>
        }
    ) => HasOneConfig<TSource, Entities[TargetName], TargetRelations<Entities, Stores, TargetName>>
}

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

export type InferRelationsFromStoreOverride<
    Entities extends Record<string, Entity>,
    Stores,
    Name extends keyof Entities & string
> = Name extends keyof Stores
    ? Stores[Name] extends (ctx: any) => infer R
        ? R extends IStore<Entities[Name], infer Relations>
            ? Relations
            : {}
        : Stores[Name] extends { relations?: infer Relations }
            ? Relations extends (...args: any[]) => infer R2
                ? (R2 extends RelationMap<Entities[Name]> ? R2 : {})
                : Relations extends RelationsSchema<Entities, Stores, Name>
                    ? RelationMapFromSchema<Entities, Stores, Name, Relations>
                    : Relations extends RelationMap<Entities[Name]>
                        ? Relations
                        : {}
            : {}
    : {}

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

export type DefineClientConfig<
    Entities extends Record<string, Entity>
> = {
    backend: BackendConfig
    /** Default remote dataSource defaults (applied to all resources). */
    remote?: {
        batch?: boolean | BatchQueryConfig
        usePatchForUpdate?: boolean
    }
    defaults?: {
        dataSourceFactory?: <Name extends keyof Entities & string>(name: Name) => IDataSource<Entities[Name]>
        idGenerator?: () => StoreKey
    }
    sync?: AtomaClientSyncConfig
}

type StoreOverrideConstraint<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string
> =
    | ((ctx: any) => any)
    | (Partial<StoreConfig<Entities[Name]>> & {
        relations?: unknown | ((dsl: RelationsDslForConstraint<Entities, Entities[Name]>) => unknown)
    })

export type StoresConstraint<Entities extends Record<string, Entity>> =
    Partial<{ [Name in keyof Entities & string]: StoreOverrideConstraint<Entities, Name> }>

export type AtomaStoresConfig<Entities extends Record<string, Entity>> =
    StoresConstraint<Entities>

export type AtomaHistory = {
    canUndo: (scope: string) => boolean
    canRedo: (scope: string) => boolean
    undo: (args: { scope: string }) => Promise<boolean>
    redo: (args: { scope: string }) => Promise<boolean>
}

export type AtomaSyncStatus = {
    started: boolean
    configured: boolean
}

export type AtomaSync = {
    start: () => void
    stop: () => void
    status: () => AtomaSyncStatus
    pull: () => Promise<void>
    flush: () => Promise<void>
    setSubscribed: (enabled: boolean) => void
}

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    sync: AtomaSync
    history: AtomaHistory
}

export type StoresDefinition<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities>
> = {
    defineClient: (config: DefineClientConfig<Entities>) => AtomaClient<Entities, Stores>
}

export type EntitiesDefinition<
    Entities extends Record<string, Entity>
> = {
    defineStores: {
        (): StoresDefinition<Entities, {}>
        <const Stores extends StoresConstraint<Entities>>(
            stores: Stores
        ): StoresDefinition<Entities, Stores>
    }
}

type RelationsDslForConstraint<
    Entities extends Record<string, Entity>,
    TSource extends Entity
> = {
    belongsTo: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            foreignKey: KeySelector<TSource>
            primaryKey?: keyof Entities[TargetName] & string
            options?: any
        }
    ) => BelongsToConfig<TSource, Entities[TargetName], any>

    hasMany: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: any
        }
    ) => HasManyConfig<TSource, Entities[TargetName], any>

    hasOne: <TargetName extends keyof Entities & string>(
        name: TargetName,
        config: {
            primaryKey?: KeySelector<TSource>
            foreignKey: keyof Entities[TargetName] & string
            options?: any
        }
    ) => HasOneConfig<TSource, Entities[TargetName], any>
}
