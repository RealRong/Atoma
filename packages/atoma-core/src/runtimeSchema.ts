import type { Entity, StoreConfig } from 'atoma-types/core'

export type RuntimeStoreSchema<T extends Entity = any> = {
    relations?: Record<string, any>
    [key: string]: unknown
} & Partial<Pick<StoreConfig<T>, 'indexes' | 'hooks' | 'idGenerator' | 'dataProcessor' | 'write'>>

export type RuntimeSchema<
    Entities extends Record<string, Entity> = Record<string, Entity>
> = Readonly<Partial<{ [Name in keyof Entities & string]: RuntimeStoreSchema<Entities[Name]> }>>
