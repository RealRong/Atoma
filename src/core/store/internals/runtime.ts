import type { PrimitiveAtom } from 'jotai/vanilla'
import { StoreIndexes } from '../../indexes/StoreIndexes'
import type { CoreRuntime, IndexDefinition, JotaiStore, StoreConfig, StoreOperationOptions, StoreReadOptions, Entity } from '../../types'
import type { EntityId } from '#protocol'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import type { ObservabilityContext } from '#observability'
import type { StoreHandle } from './handleTypes'

export function createStoreHandle<T extends Entity>(params: {
    atom: PrimitiveAtom<Map<EntityId, T>>
    config: StoreConfig<T> & {
        store: JotaiStore
        storeName: string
    }
}): StoreHandle<T> {
    const { atom, config } = params

    const jotaiStore = config.store

    const storeName = config.storeName || 'store'

    const indexes = config.indexes && config.indexes.length ? new StoreIndexes<T>(config.indexes) : null

    const matcher = buildQueryMatcherOptions(config.indexes)

    const transform = (item: T): T => {
        return config.transformData ? config.transformData(item) : item
    }

    let opSeq = 0
    const nextOpId = (prefix: 'q' | 'w') => {
        opSeq += 1
        return `${prefix}_${Date.now()}_${opSeq}`
    }

    return {
        atom,
        jotaiStore,
        storeName,
        indexes,
        matcher,
        hooks: config.hooks,
        schema: config.schema,
        idGenerator: config.idGenerator,
        transform,
        nextOpId,
        writePolicies: {
            allowImplicitFetchForWrite: true
        }
    }
}

export function resolveObservabilityContext<T extends Entity>(
    clientRuntime: CoreRuntime,
    handle: StoreHandle<T>,
    options?: StoreOperationOptions | StoreReadOptions | { explain?: boolean }
): ObservabilityContext {
    const anyOptions = options as any
    return clientRuntime.createObservabilityContext(handle.storeName, {
        explain: anyOptions?.explain === true
    })
}

export function buildQueryMatcherOptions<T>(indexes?: Array<IndexDefinition<T>>): QueryMatcherOptions | undefined {
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
