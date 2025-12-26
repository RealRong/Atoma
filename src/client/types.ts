import type {
    BelongsToConfig,
    CoreStore,
    Entity,
    HasManyConfig,
    HasOneConfig,
    IAdapter,
    IStore,
    KeySelector,
    JotaiStore,
    OperationContext,
    RelationMap,
    StoreConfig
} from '#core'
import type { RelationsSchema, RelationMapFromSchema } from './createAtomaStore'
import type { AtomaClientSyncConfig } from './sync'

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
    defaultAdapterFactory: <Name extends keyof Entities & string>(name: Name) => IAdapter<Entities[Name]>
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    resolveStore: <Name extends keyof Entities & string>(name: Name) => IStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
}

export type DefineClientConfig<
    Entities extends Record<string, Entity>
> = {
    defaultAdapterFactory: <Name extends keyof Entities & string>(name: Name) => IAdapter<Entities[Name]>
    sync?: AtomaClientSyncConfig
}

export type CreateOpContextArgs = Readonly<{
    scope: string
    origin?: OperationContext['origin']
    label?: string
}>

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
    pullNow: () => Promise<void>
    flush: () => Promise<void>
}

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => CoreStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    resolveStore: (name: string) => IStore<any>
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
