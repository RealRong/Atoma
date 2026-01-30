import type { Entity, StoreConfig } from 'atoma-core'
import type { RelationsSchema } from './relations'

export type AtomaStoreSchema<
    Entities extends Record<string, Entity>,
    Name extends keyof Entities & string
> = {
    relations?: RelationsSchema<Entities, Name>
} & Pick<
    StoreConfig<Entities[Name]>,
    'indexes' | 'hooks' | 'idGenerator' | 'dataProcessor' | 'write'
>

export type AtomaSchema<
    Entities extends Record<string, Entity>
> = Readonly<Partial<{ [Name in keyof Entities & string]: AtomaStoreSchema<Entities, Name> }>>
