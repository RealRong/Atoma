import type { OperationContext, PersistWriteback, StoreToken } from '#core'
import type { EntityId } from '#protocol'
import type { Patch } from 'immer'
import type { ClientRuntime } from '#client/types'
import type { ObservabilityContext } from '#observability'

export type ClientRuntimeInternal = ClientRuntime & Readonly<{
    internal: Readonly<{
        getStoreSnapshot: (storeName: string) => ReadonlyMap<EntityId, any>
        applyWriteback: (storeName: string, args: PersistWriteback<any>) => Promise<void>
        commitWriteback: (storeName: StoreToken, writeback: PersistWriteback<any>, options?: { context?: ObservabilityContext }) => Promise<void>
        dispatchPatches: (args: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => Promise<void>
    }>
}>
