import type { FindManyOptions, IStore, RelationConfig, RelationMap, StoreKey, Entity, InferIncludeType } from '../core/types'
import type { UseFindManyResult } from './types'
import type { CoreStore, CoreStoreConfig } from '../core/createCoreStore'
import { createCoreStore } from '../core/createCoreStore'
import { resolveStoreAccess, registerStoreAccess } from '../core/storeAccessRegistry'
import { createUseValue } from './hooks/useValue'
import { createUseAll } from './hooks/useAll'
import { createUseFindMany } from './hooks/useFindMany'
import { createUseMultiple, UseMultipleOptions } from './hooks/useMultiple'

export interface ReactStoreConfig<T extends Entity> extends CoreStoreConfig<T> { }

export interface ReactStore<T extends Entity, Relations extends RelationMap<T> = {}> extends CoreStore<T, Relations> {
    useValue: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        id?: StoreKey,
        options?: { include?: Include }
    ) => (keyof Include extends never ? T | undefined : any)

    useAll: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        options?: { include?: Include }
    ) => (keyof Include extends never ? T[] : any)

    useFindMany: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        options?: FindManyOptions<T, Include> & {
            fetchPolicy?: import('../core/types').FetchPolicy
            include?: { [K in keyof Relations]?: InferIncludeType<Relations[K]> }
        }
    ) => UseFindManyResult<T, Relations, Include>

    useMultiple: <Include extends { [K in keyof Relations]?: InferIncludeType<Relations[K]> } = {}>(
        ids: StoreKey[],
        options?: UseMultipleOptions<T, Relations> & { include?: Include }
    ) => (keyof Include extends never ? T[] : any)

    withRelations: <const NewRelations extends Record<string, RelationConfig<any, any>>>(factory: () => NewRelations) => ReactStore<T, NewRelations>
}

export function createReactStore<T extends Entity, const Relations extends RelationMap<T>>(
    config: ReactStoreConfig<T> & { relations: () => Relations }
): ReactStore<T, Relations>

export function createReactStore<T extends Entity, const Relations extends RelationMap<T> = {}>(
    config: ReactStoreConfig<T> & { relations?: () => Relations }
): ReactStore<T, Relations>

export function createReactStore<T extends Entity, Relations extends RelationMap<T> = {}>(
    config: ReactStoreConfig<T> & { relations?: () => Relations }
): ReactStore<T, Relations> {
    const core = createCoreStore<T, Relations>(config as any) as unknown as CoreStore<T, Relations>
    const access = resolveStoreAccess(core as unknown as IStore<any>)

    if (!access) {
        throw new Error('[Atoma] createReactStore: 未找到 storeAccess（atom/jotaiStore），请确认 createCoreStore 已完成注册')
    }

    const useValue = createUseValue<T, Relations>(access.atom, core as any, access.jotaiStore)
    const useAll = createUseAll<T, Relations>(access.atom, core as any, access.jotaiStore)
    const useFindMany = createUseFindMany<T, Relations>(access.atom, core as any, access.jotaiStore)
    const useMultiple = createUseMultiple<T, Relations>(access.atom, core as any, access.jotaiStore)

    const reactStore = core as unknown as ReactStore<T, Relations>
    reactStore.useValue = useValue as any
    reactStore.useAll = useAll as any
    reactStore.useFindMany = useFindMany as any
    reactStore.useMultiple = useMultiple as any

    // 确保 relations 的 live 订阅能拿到当前 store 的 atom/jotaiStore
    registerStoreAccess(reactStore as any, access)

    return reactStore
}

export const createAtomaStore = createReactStore
