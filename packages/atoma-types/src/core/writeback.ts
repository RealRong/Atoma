import type { Entity } from './entity'
import type { EntityId } from '../shared'

export type StoreWritebackArgs<T extends Entity> = Readonly<{
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ id: EntityId; version: number }>
}>

export type StoreChange<T extends Entity> = Readonly<{
    id: EntityId
    before?: T
    after?: T
}>

export type ChangeDirection = 'forward' | 'backward'

export type StoreDelta<T extends Entity> = Readonly<{
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: ReadonlySet<EntityId>
    changes: ReadonlyArray<StoreChange<T>>
}>
