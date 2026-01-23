import type { CoreRuntime, CoreStore, RuntimeStores } from '#core'

export interface ClientRuntimeStoresApi extends RuntimeStores {
    Store: (name: string) => CoreStore<any, any>
    listStores: () => Iterable<CoreStore<any, any>>
    onStoreCreated: (listener: (store: CoreStore<any, any>) => void, options?: { replay?: boolean }) => () => void
}

export type ClientRuntime = Omit<CoreRuntime, 'stores'> & Readonly<{
    stores: ClientRuntimeStoresApi
}>
