import type { JotaiStore, OperationContext, PersistWriteback } from 'atoma-core'
import type { EntityId } from 'atoma-protocol'
import type { Patch } from 'immer'
import type { ClientRuntime } from '#client/types'

export type ClientRuntimeInternal = ClientRuntime & Readonly<{
    jotaiStore: JotaiStore
    internal: Readonly<{
        getStoreSnapshot: (storeName: string) => ReadonlyMap<EntityId, any>
        applyWriteback: (storeName: string, args: PersistWriteback<any>) => Promise<void>
        dispatchPatches: (args: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => Promise<void>
    }>
}>
