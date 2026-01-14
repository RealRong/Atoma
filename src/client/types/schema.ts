import type { Entity, StoreBackend, StoreConfig } from '#core'
import type { RelationsSchema } from './relations'

export type AtomaStoreSchema<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string
> = {
    relations?: RelationsSchema<Entities, Name>
    backend?: StoreBackend
} & Pick<
    StoreConfig<Entities[Name]>,
    'indexes' | 'schema' | 'transformData' | 'hooks' | 'idGenerator'
>

export type AtomaSchema<
    Entities extends Record<string, Entity>
> = Readonly<Partial<{ [Name in keyof Entities & string]: AtomaStoreSchema<Entities, Name> }>>
