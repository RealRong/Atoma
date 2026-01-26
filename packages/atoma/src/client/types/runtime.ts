import type { CoreRuntime, RuntimeStores, StoreApi } from '#core'

export interface ClientRuntimeStoresApi extends RuntimeStores {
    listStores: () => Iterable<StoreApi<any, any> & { name: string }>
    onStoreCreated: (listener: (store: StoreApi<any, any> & { name: string }) => void, options?: { replay?: boolean }) => () => void
}

export type ClientRuntime = Omit<CoreRuntime, 'stores'> & Readonly<{
    stores: ClientRuntimeStoresApi
}>
