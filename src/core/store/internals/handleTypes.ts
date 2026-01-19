import type { PrimitiveAtom } from 'jotai/vanilla'
import type { Entity, JotaiStore, StoreConfig } from '../../types'
import type { EntityId } from '#protocol'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import type { StoreIndexes } from '../../indexes/StoreIndexes'

/**
 * Store 内部写入策略（仅影响“隐式行为”）
 */
export type StoreWritePolicies = {
    /**
     * 写入时遇到 cache 缺失，是否允许自动补读（bulkGet/get）：
     * - direct：通常允许（提升 DX）
     * - sync/outbox：必须禁止（enqueue 阶段不触网），需由上层显式 fetch
     */
    allowImplicitFetchForWrite: boolean
}

/**
 * Store internal handle bindings.
 * - Internal store operations use it alongside CoreRuntime for cross-store abilities.
 * - Internal layers access atom/jotaiStore/indexes without bloating public store API.
 */
export type StoreHandle<T extends Entity = any> = {
    atom: PrimitiveAtom<Map<EntityId, T>>
    jotaiStore: JotaiStore
    matcher?: QueryMatcherOptions
    storeName: string
    relations?: () => any | undefined
    indexes: StoreIndexes<T> | null
    hooks: StoreConfig<T>['hooks']
    idGenerator: StoreConfig<T>['idGenerator']
    dataProcessor: StoreConfig<T>['dataProcessor']

    /** 内部：生成本 store 的 opId */
    nextOpId: (prefix: 'q' | 'w') => string

    /** 运行时写入策略（允许被 client/controller 动态切换） */
    writePolicies?: StoreWritePolicies
}
