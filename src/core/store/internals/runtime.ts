import type { PrimitiveAtom } from 'jotai/vanilla'
import { StoreIndexes } from '../../indexes/StoreIndexes'
import type { IndexDefinition, IDataSource, JotaiStore, StoreConfig, StoreHandle, StoreKey, StoreOperationOptions, StoreReadOptions, Entity, StoreServices } from '../../types'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import { Observability } from '#observability'
import type { ObservabilityContext } from '#observability'

export function createStoreHandle<T extends Entity>(params: {
    atom: PrimitiveAtom<Map<StoreKey, T>>
    dataSource: IDataSource<T>
    config: StoreConfig<T> & {
        store: JotaiStore
        services: StoreServices
        storeName: string
    }
}): StoreHandle<T> {
    const { atom, dataSource, config } = params

    const jotaiStore = config.store
    const services = config.services

    const storeName = config.storeName || dataSource.name || 'store'

    const indexes = config.indexes && config.indexes.length ? new StoreIndexes<T>(config.indexes) : null

    const matcher = buildQueryMatcherOptions(config.indexes)

    const transform = (item: T): T => {
        return config.transformData ? config.transformData(item) : item
    }

    const observability = Observability.runtime.create({
        scope: storeName,
        debug: services.debug,
        onEvent: services.debugSink
    })

    return {
        atom,
        dataSource,
        jotaiStore,
        services,
        storeName,
        observability,
        createObservabilityContext: observability.createContext.bind(observability),
        indexes,
        matcher,
        hooks: config.hooks,
        schema: config.schema,
        idGenerator: config.idGenerator,
        transform,
        writePolicies: {
            allowImplicitFetchForWrite: true
        }
    }
}

export function resolveObservabilityContext<T extends Entity>(
    handle: StoreHandle<T>,
    options?: StoreOperationOptions | StoreReadOptions | { explain?: boolean }
): ObservabilityContext {
    const anyOptions = options as any
    return handle.observability.createContext({
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
