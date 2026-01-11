import type { CoreStore, IStore, JotaiStore, MutationPipeline, OutboxEnqueuer, OutboxQueueMode, StoreHandle } from '#core'
import type { SyncStore } from '#core'

export type ClientRuntime = Readonly<{
    mutation: MutationPipeline
    Store: (name: string) => CoreStore<any, any>
    SyncStore: (name: string) => SyncStore<any, any>
    resolveStore: (name: string) => IStore<any>
    listStores: () => Iterable<IStore<any>>
    onHandleCreated: (listener: (handle: StoreHandle<any>) => void, options?: { replay?: boolean }) => () => void
    installOutboxRuntime: (args: { queueMode: OutboxQueueMode; ensureEnqueuer: () => OutboxEnqueuer }) => void
    jotaiStore: JotaiStore
}>
