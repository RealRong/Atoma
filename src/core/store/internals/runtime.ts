import type { PrimitiveAtom } from 'jotai/vanilla'
import { StoreIndexes } from '../../indexes/StoreIndexes'
import type { IndexDefinition, JotaiStore, StoreBackend, StoreConfig, StoreHandle, StoreOperationOptions, StoreReadOptions, Entity, StoreServices } from '../../types'
import type { EntityId } from '#protocol'
import type { QueryMatcherOptions } from '../../query/QueryMatcher'
import { Observability } from '#observability'
import type { ObservabilityContext } from '#observability'

export function createStoreHandle<T extends Entity>(params: {
    atom: PrimitiveAtom<Map<EntityId, T>>
    backend: StoreBackend
    config: StoreConfig<T> & {
        store: JotaiStore
        services: StoreServices
        storeName: string
    }
}): StoreHandle<T> {
    const { atom, backend, config } = params

    const jotaiStore = config.store
    const services = config.services

    const storeName = config.storeName || 'store'

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

    let opSeq = 0
    const nextOpId = (prefix: 'q' | 'w') => {
        opSeq += 1
        return `${prefix}_${Date.now()}_${opSeq}`
    }

    return {
        atom,
        backend,
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
        nextOpId,
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
