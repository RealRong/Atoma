import type { Entity } from './entity'
import type { EntityId } from '../shared'

export type StoreWritebackEntry<T extends Entity> =
    | Readonly<{
        action: 'upsert'
        item: T
    }>
    | Readonly<{
        action: 'delete'
        id: EntityId
    }>

export type StoreCreateChange<T extends Entity> = Readonly<{
    id: EntityId
    after: T
    before?: never
}>

export type StoreUpdateChange<T extends Entity> = Readonly<{
    id: EntityId
    before: T
    after: T
}>

export type StoreDeleteChange<T extends Entity> = Readonly<{
    id: EntityId
    before: T
    after?: never
}>

export type StoreChange<T extends Entity> =
    | StoreCreateChange<T>
    | StoreUpdateChange<T>
    | StoreDeleteChange<T>

export type ChangeDirection = 'forward' | 'backward'
