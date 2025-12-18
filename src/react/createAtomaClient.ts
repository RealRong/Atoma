import type {
    BelongsToConfig,
    Entity,
    HasManyConfig,
    HasOneConfig,
    IAdapter,
    IStore,
    KeySelector,
    RelationMap,
    StoreConfig
} from '../core/types'
import { ATOMA_STORE_REF } from '../core/storeRef'
import type { ReactStore } from './createReactStore'
import { createAtomaStore, type RelationMapFromSchema, type RelationsSchema } from './createAtomaStore'

export type InferRelationsFromStoreOverride<
    Entities extends Record<string, Entity>,
    Stores,
    Name extends keyof Entities & string
> = Name extends keyof Stores
    ? Stores[Name] extends (ctx: any) => infer R
        ? R extends ReactStore<Entities[Name], infer Relations>
            ? (Relations extends RelationMap<Entities[Name]> ? Relations : {})
            : {}
        : Stores[Name] extends { relations?: infer Relations }
            ? Relations extends (...args: any[]) => infer R2
                ? (R2 extends RelationMap<Entities[Name]> ? R2 : {})
                : Relations extends RelationsSchema<Entities, Stores, Name>
                    ? RelationMapFromSchema<Entities, Stores, Name, Relations>
                    : {}
            : {}
    : {}

export type AtomaClientContext<
    Entities extends Record<string, Entity>,
    Stores = {}
> = {
    defaultAdapterFactory: <Name extends keyof Entities & string>(name: Name) => IAdapter<Entities[Name]>
    Store: <Name extends keyof Entities & string>(name: Name) => ReactStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    getStoreRef: <Name extends keyof Entities & string>(name: Name) => IStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
}

export type DefineClientConfig<
    Entities extends Record<string, Entity>
> = {
    defaultAdapterFactory: <Name extends keyof Entities & string>(name: Name) => IAdapter<Entities[Name]>
}

export type AtomaStoresConfig<Entities extends Record<string, Entity>> =
    StoresConstraint<Entities>

export type AtomaClient<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => ReactStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
}

type StoreOverrideConstraint<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string
> =
    | ((ctx: any) => any)
    | (Partial<StoreConfig<Entities[Name]>> & {
        relations?: RelationsSchema<Entities, any, Name> | ((dsl: RelationsDslForConstraint<Entities, Entities[Name]>) => unknown)
    })

type StoresConstraint<Entities extends Record<string, Entity>> =
    Partial<{ [Name in keyof Entities & string]: StoreOverrideConstraint<Entities, Name> }>

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

const createLazyStoreRef = <Entities extends Record<string, Entity>, Name extends keyof Entities & string>(
    name: Name,
    getStore: (n: Name) => ReactStore<Entities[Name], any>
): IStore<Entities[Name], any> => {
    const target = {
        [ATOMA_STORE_REF]: () => getStore(name)
    } as any

    return new Proxy(target, {
        get(_t, prop) {
            if (prop === ATOMA_STORE_REF) return () => getStore(name)
            const store = getStore(name) as any
            const val = store[prop as any]
            return typeof val === 'function' ? val.bind(store) : val
        }
    }) as any
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
            stores: Stores & StoresConstraint<Entities>
        ): StoresDefinition<Entities, Stores>
    }
}

const defineStoresInternal = <
    const Entities extends Record<string, Entity>,
    const Stores extends StoresConstraint<Entities>
>(stores: Stores): StoresDefinition<Entities, Stores> => {
    return {
        defineClient: (config) => {
            const storeCache = new Map<string, ReactStore<any, any>>()
            const refCache = new Map<string, IStore<any, any>>()

            const Store = (name: any): any => {
                const key = String(name)
                const existing = storeCache.get(key)
                if (existing) return existing as any

                const ctx: AtomaClientContext<any, any> = {
                    defaultAdapterFactory: config.defaultAdapterFactory as any,
                    Store: Store as any,
                    getStoreRef: getStoreRef as any
                }

                const override = (stores as any)?.[name]
                const created = (() => {
                    if (!override) return createAtomaStore(ctx, { name } as any)
                    if (typeof override === 'function') return override(ctx)
                    if (typeof (override as any)?.name === 'string' && (override as any).name !== name) {
                        throw new Error(`[Atoma] defineStores(...).defineClient: stores["${String(name)}"].name 不一致（收到 "${String((override as any).name)}"）`)
                    }
                    return createAtomaStore(ctx, { ...(override as any), name } as any)
                })()

                storeCache.set(key, created as any)
                return created as any
            }

            const getStoreRef = (name: any): any => {
                const key = String(name)
                const existing = refCache.get(key)
                if (existing) return existing as any
                const ref = createLazyStoreRef<any, any>(name, Store)
                refCache.set(key, ref as any)
                return ref as any
            }

            return { Store } as any
        }
    }
}

export function defineEntities<
    const Entities extends Record<string, Entity>
>(): EntitiesDefinition<Entities> {
    function defineStores(): StoresDefinition<Entities, {}>
    function defineStores<const Stores extends StoresConstraint<Entities>>(
        stores: Stores & StoresConstraint<Entities>
    ): StoresDefinition<Entities, Stores>
    function defineStores(stores?: any): StoresDefinition<Entities, any> {
        return defineStoresInternal<Entities, any>((stores ?? {}) as any)
    }

    return {
        defineStores
    }
}
