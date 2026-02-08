import type { Entity } from './entity'
import type { EntityId } from '../shared'

export type StoreWritebackArgs<T extends Entity> = Readonly<{
    upserts?: T[]
    deletes?: EntityId[]
    versionUpdates?: Array<{ key: EntityId; version: number }>
}>

export type StoreWritebackResult<T extends Entity> = Readonly<{
    before: Map<EntityId, T>
    after: Map<EntityId, T>
    changedIds: Set<EntityId>
}>

export type StoreWritebackOptions<T extends Entity> = Readonly<{
    preserve?: (existing: T, incoming: T) => T
}>
