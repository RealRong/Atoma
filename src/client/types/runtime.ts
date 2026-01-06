import type { CoreStore, IStore, JotaiStore, StoreHandle } from '#core'
import type { SyncStore } from '#core'

export type ClientRuntime = Readonly<{
    Store: (name: string) => CoreStore<any, any>
    SyncStore: (name: string) => SyncStore<any, any>
    resolveStore: (name: string) => IStore<any>
    listStores: () => Iterable<IStore<any>>
    onHandleCreated: (listener: (handle: StoreHandle<any>) => void, options?: { replay?: boolean }) => () => void
    jotaiStore: JotaiStore
}>

