import type { EntityId } from '../shared'

export interface Entity {
    id: EntityId
}

export type KeySelector<T> =
    | (keyof T & string)
    | string
    | ((item: T) => EntityId | EntityId[] | undefined | null)

export interface Base extends Entity {
    createdAt: number
    updatedAt: number
    deleted?: boolean
    deletedAt?: number
    version?: number
}

export type PartialWithId<T> = Partial<T> & { id: EntityId }
