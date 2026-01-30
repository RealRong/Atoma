import type { PrimitiveAtom } from 'jotai/vanilla'
import { StoreIndexes } from '../../indexes/StoreIndexes'
import type {
    CoreRuntime,
    Entity,
    IndexDefinition,
    JotaiStore,
    StoreConfig,
    StoreOperationOptions,
    StoreReadOptions
} from '../../types'
import type { EntityId } from 'atoma-protocol'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import type { ObservabilityContext } from 'atoma-observability'
import type { StoreHandle } from './handleTypes'

// Internal helpers for building store handles and attaching context.
//
// 注意：这里不再维护任何 “store object -> handle/runtime” 的全局映射。
// - handle 的唯一权威来源是 `runtime.stores.resolveHandle`。
// - store 对象（用户态 facade）应保持无状态，不应持有 handle。

function buildQueryMatcherOptions<T>(indexes?: Array<IndexDefinition<T>>): QueryMatcherOptions | undefined {
    const defs = indexes || []
    if (!defs.length) return undefined

    const fields: QueryMatcherOptions['fields'] = {}
    defs.forEach(def => {
        if (def.type !== 'text') return
        fields[def.field] = {
            match: {
                minTokenLength: def.options?.minTokenLength,
                tokenizer: def.options?.tokenizer
            },
            fuzzy: {
                distance: def.options?.fuzzyDistance,
                minTokenLength: def.options?.minTokenLength,
                tokenizer: def.options?.tokenizer
            }
        }
    })

    return Object.keys(fields).length ? { fields } : undefined
}

export function createStoreHandle<T extends Entity>(params: {
    atom: PrimitiveAtom<Map<EntityId, T>>
    jotaiStore: JotaiStore
    config: StoreConfig<T> & {
        storeName: string
    }
}): StoreHandle<T> {
    const { atom, config, jotaiStore } = params
    const storeName = config.storeName || 'store'

    const indexes = config.indexes && config.indexes.length ? new StoreIndexes<T>(config.indexes) : null
    const matcher = buildQueryMatcherOptions(config.indexes)

    let opSeq = 0
    const nextOpId = (prefix: 'q' | 'w') => {
        opSeq += 1
        return `${prefix}_${Date.now()}_${opSeq}`
    }

    return {
        atom,
        jotaiStore,
        storeName,
        defaultWriteStrategy: config.write?.strategy,
        indexes,
        matcher,
        hooks: config.hooks,
        idGenerator: config.idGenerator,
        dataProcessor: config.dataProcessor,
        nextOpId
    }
}

export function resolveObservabilityContext<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions | StoreReadOptions | { explain?: boolean }
): ObservabilityContext {
    const anyOptions = options as any
    return clientRuntime.observe.createContext(handle.storeName, {
        explain: anyOptions?.explain === true
    })
}
