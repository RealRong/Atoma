import type { ClientRuntime as CoreClientRuntime, CoreStore, OutboxEnqueuer, OutboxQueueMode } from '#core'
import type { SyncStore } from '#core'

export type ClientRuntime = CoreClientRuntime & Readonly<{
    Store: (name: string) => CoreStore<any, any>
    SyncStore: (name: string) => SyncStore<any, any>
    listStores: () => Iterable<CoreStore<any, any>>
    onStoreCreated: (listener: (store: CoreStore<any, any>) => void, options?: { replay?: boolean }) => () => void
    installOutboxRuntime: (args: { queueMode: OutboxQueueMode; ensureEnqueuer: () => OutboxEnqueuer }) => void
}>
