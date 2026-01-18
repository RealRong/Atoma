import type { OperationContext, PersistWriteback } from '#core'
import type { EntityId } from '#protocol'
import type { Patch } from 'immer'
import type { ClientRuntime } from '../types'

export type ClientRuntimeInternal = ClientRuntime & Readonly<{
    internal: Readonly<{
        getStoreSnapshot: (storeName: string) => ReadonlyMap<EntityId, any>
        applyWriteback: (storeName: string, args: PersistWriteback<any>) => Promise<void>
        dispatchPatches: (args: { storeName: string; patches: Patch[]; inversePatches: Patch[]; opContext: OperationContext }) => Promise<void>
    }>
}>
