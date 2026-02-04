import type * as Types from '../core'
import type { RelationsSchema } from './relations'

export type AtomaStoreSchema<
    Entities extends Record<string, Types.Entity>,
    Name extends keyof Entities & string
> = {
    relations?: RelationsSchema<Entities, Name>
} & Pick<
    Types.StoreConfig<Entities[Name]>,
    'indexes' | 'hooks' | 'idGenerator' | 'dataProcessor' | 'write'
>

export type AtomaSchema<
    Entities extends Record<string, Types.Entity>
> = Readonly<Partial<{ [Name in keyof Entities & string]: AtomaStoreSchema<Entities, Name> }>>
