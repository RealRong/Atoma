import type { Patch } from 'immer'
import type { Entity } from './entity'
import type { EntityId } from '../shared'

export type StoreWritebackArgs<T extends Entity> = Readonly<{
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ key: EntityId; version: number }>
}>

export type StoreDelta<T extends Entity> = Readonly<{
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: ReadonlySet<EntityId>
    patches: Patch[]
    inversePatches: Patch[]
}>
