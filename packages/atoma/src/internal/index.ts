export {
    resolveStore,
    getStoreSource,
    getStoreSnapshotMap,
    getStoreIndexes,
    getStoreMatcher,
    getStoreRelations,
    hydrateStore
} from './bindings'

export { registerClientRuntime, getClientRuntime, requireClientRuntime } from 'atoma-client'

export type { StoreFacade } from './storeFacade'
export { assertStoreFacade } from './storeFacade'
