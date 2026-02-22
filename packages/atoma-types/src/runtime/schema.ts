import type { Entity, StoreConfig } from '../core'

export type StoreSchema<T extends Entity = Entity> = {
    relations?: Record<string, unknown>
    [key: string]: unknown
} & Partial<Pick<StoreConfig<T>, 'indexes' | 'createId' | 'processor'>>

export type Schema<
    Entities extends Record<string, Entity> = Record<string, Entity>
> = Readonly<Partial<{ [Name in keyof Entities & string]: StoreSchema<Entities[Name]> }>>
