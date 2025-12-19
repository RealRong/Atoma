import type {
    BelongsToConfig,
    Entity,
    HasManyConfig,
    HasOneConfig,
    IAdapter,
    IStore,
    KeySelector,
    RelationMap,
    StoreConfig,
    OperationContext
} from '../core/types'
import { ATOMA_STORE_REF } from '../core/storeRef'
import type { ReactStore } from '../react/createReactStore'
import { createAtomaStore, type RelationMapFromSchema, type RelationsSchema } from './createAtomaStore'
import { InMemoryHistory } from '../core/history/InMemoryHistory'
import { resolveStoreAccess } from '../core/storeAccessRegistry'
import { BaseStore } from '../core/BaseStore'
import type { Patch } from 'immer'
import { createActionId } from '../core/operationContext'
import type { OperationRecorder } from '../core/ops/OperationRecorder'

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
    scope: (scope: string, overrides?: Partial<Omit<OperationContext, 'scope'>>) => AtomaScopedClient<Entities, Stores>
}

export type AtomaScopedClient<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => ReactStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    scope: (scope: string, overrides?: Partial<Omit<OperationContext, 'scope'>>) => AtomaScopedClient<Entities, Stores>
    beginAction: (options?: { label?: string }) => AtomaAction<Entities, Stores>
    undo: () => Promise<boolean>
    redo: () => Promise<boolean>
    canUndo: () => boolean
    canRedo: () => boolean
}

export type AtomaAction<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = {
    Store: <Name extends keyof Entities & string>(name: Name) => ReactStore<Entities[Name], InferRelationsFromStoreOverride<Entities, Stores, Name>>
    commit: () => void
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
            const history = new InMemoryHistory()
            const operationRecorder: OperationRecorder = {
                record: (record) => {
                    history.recordChange({
                        storeName: record.storeName,
                        patches: record.patches,
                        inversePatches: record.inversePatches,
                        ctx: record.opContext
                    })
                }
            }

            const rawStore = (name: any): any => {
                const key = String(name)
                const existing = storeCache.get(key)
                if (existing) return existing as any

                const ctx: AtomaClientContext<any, any> = {
                    defaultAdapterFactory: config.defaultAdapterFactory as any,
                    Store: rawStore as any,
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

                const access = resolveStoreAccess(created as any)
                if (access) {
                    access.context.operationRecorder = operationRecorder
                }

                storeCache.set(key, created as any)
                return created as any
            }

            const getStoreRef = (name: any): any => {
                const key = String(name)
                const existing = refCache.get(key)
                if (existing) return existing as any
                const ref = createLazyStoreRef<any, any>(name, rawStore)
                refCache.set(key, ref as any)
                return ref as any
            }

            const dispatchPatches = async (
                storeName: string,
                patches: Patch[],
                inversePatches: Patch[],
                opContext: OperationContext
            ) => {
                const store = rawStore(storeName as any)
                const access = resolveStoreAccess(store as any)
                if (!access) {
                    throw new Error(`[Atoma] history: 未找到 storeAccess（store="${storeName}"）`)
                }
                if (!access.adapter) {
                    throw new Error(`[Atoma] history: 未找到 adapter（store="${storeName}"）`)
                }

                await new Promise<void>((resolve, reject) => {
                    BaseStore.dispatch({
                        type: 'patches',
                        patches,
                        inversePatches,
                        atom: access.atom as any,
                        adapter: access.adapter as any,
                        store: access.jotaiStore as any,
                        context: access.context as any,
                        indexes: access.indexes as any,
                        opContext,
                        onSuccess: () => resolve(),
                        onFail: (error?: Error) => reject(error ?? new Error('[Atoma] history: patches 写入失败'))
                    } as any)
                })
            }

            const bindStoreToContext = (store: any, ctx: OperationContext) => {
                return new Proxy(store, {
                    get(target, prop, receiver) {
                        if (prop === 'addOne') {
                            return (item: any, options?: any) => target.addOne(item, {
                                ...options,
                                opContext: options?.opContext ? { ...ctx, ...options.opContext } : ctx
                            })
                        }
                        if (prop === 'updateOne') {
                            return (id: any, recipe: any, options?: any) => target.updateOne(id, recipe, {
                                ...options,
                                opContext: options?.opContext ? { ...ctx, ...options.opContext } : ctx
                            })
                        }
                        if (prop === 'deleteOneById') {
                            return (id: any, options?: any) => target.deleteOneById(id, {
                                ...options,
                                opContext: options?.opContext ? { ...ctx, ...options.opContext } : ctx
                            })
                        }
                        if (prop === 'withRelations') {
                            return (factory: any) => {
                                target.withRelations(factory)
                                return receiver
                            }
                        }
                        const val = target[prop as any]
                        return typeof val === 'function' ? val.bind(target) : val
                    }
                })
            }

            const createScopedClient = (base: OperationContext): AtomaScopedClient<any, any> => {
                const scope = (nextScope: string, overrides?: Partial<Omit<OperationContext, 'scope'>>) => {
                    const next: OperationContext = {
                        scope: String(nextScope || 'default'),
                        origin: (overrides?.origin ?? base.origin) as any,
                        actionId: overrides?.actionId ?? base.actionId,
                        label: overrides?.label ?? base.label,
                        timestamp: overrides?.timestamp ?? base.timestamp,
                        traceId: overrides?.traceId ?? base.traceId
                    }
                    return createScopedClient(next)
                }

                const Store = (name: any) => bindStoreToContext(rawStore(name), base) as any

                const canUndo = () => history.canUndo(base.scope)
                const canRedo = () => history.canRedo(base.scope)

                const undo = async () => {
                    const action = history.popUndo(base.scope)
                    if (!action) return false

                    const historyActionId = createActionId()
                    const opContext: OperationContext = {
                        scope: base.scope,
                        origin: 'history',
                        actionId: historyActionId,
                        label: action.label,
                        traceId: base.traceId
                    }

                    try {
                        for (let i = action.changes.length - 1; i >= 0; i--) {
                            const change = action.changes[i]
                            await dispatchPatches(change.storeName, change.inversePatches, change.patches, opContext)
                        }
                        history.pushRedo(base.scope, action)
                        return true
                    } catch (e) {
                        history.pushUndo(base.scope, action)
                        throw e
                    }
                }

                const redo = async () => {
                    const action = history.popRedo(base.scope)
                    if (!action) return false

                    const historyActionId = createActionId()
                    const opContext: OperationContext = {
                        scope: base.scope,
                        origin: 'history',
                        actionId: historyActionId,
                        label: action.label,
                        traceId: base.traceId
                    }

                    try {
                        for (let i = 0; i < action.changes.length; i++) {
                            const change = action.changes[i]
                            await dispatchPatches(change.storeName, change.patches, change.inversePatches, opContext)
                        }
                        history.pushUndo(base.scope, action)
                        return true
                    } catch (e) {
                        history.pushRedo(base.scope, action)
                        throw e
                    }
                }

                const beginAction = (options?: { label?: string }) => {
                    const actionId = createActionId()
                    const ctx: OperationContext = {
                        ...base,
                        actionId,
                        label: options?.label ?? base.label
                    }

                    return {
                        Store: (name: any) => bindStoreToContext(rawStore(name), ctx) as any,
                        commit: () => { }
                    } as any
                }

                return {
                    Store,
                    scope,
                    beginAction,
                    undo,
                    redo,
                    canUndo,
                    canRedo
                } as any
            }

            const client: AtomaClient<any, any> = {
                Store: rawStore as any,
                scope: (scope: string, overrides?: Partial<Omit<OperationContext, 'scope'>>) => {
                    const base: OperationContext = {
                        scope: String(scope || 'default'),
                        origin: (overrides?.origin ?? 'user') as any,
                        actionId: overrides?.actionId,
                        label: overrides?.label,
                        timestamp: overrides?.timestamp,
                        traceId: overrides?.traceId
                    }
                    return createScopedClient(base) as any
                }
            }

            return client as any
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
