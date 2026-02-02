import type { EntityId } from 'atoma-protocol'

/**
 * Minimal entity interface - all stored entities must have an id
 */
export interface Entity {
    id: EntityId
}

/**
 * 键选择器：字段名、点路径或函数
 */
export type KeySelector<T> =
    | (keyof T & string)
    | string
    | ((item: T) => EntityId | EntityId[] | undefined | null)

/**
 * Base interface for all entities stored in the sync engine
 */
export interface IBase extends Entity {
    createdAt: number
    updatedAt: number
    deleted?: boolean
    deletedAt?: number
    version?: number
}

/**
 * 通用实体基类别名，包含 id / createdAt / updatedAt / deleted*
 */
export type BaseEntity = IBase

/**
 * Partial type with required id field
 */
export type PartialWithId<T> = Partial<T> & { id: EntityId }
