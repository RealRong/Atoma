import type { Types } from 'atoma-core'
import type { DebugConfig, DebugEvent } from 'atoma-observability'
import type { RelationsSchema } from './relations'

type ObservabilityStoreConfig = Readonly<{
    debug?: DebugConfig
    debugSink?: (e: DebugEvent) => void
}>

export type AtomaStoreSchema<
    Entities extends Record<string, Types.Entity>,
    Name extends keyof Entities & string
> = {
    relations?: RelationsSchema<Entities, Name>
} & ObservabilityStoreConfig & Pick<
    Types.StoreConfig<Entities[Name]>,
    'indexes' | 'hooks' | 'idGenerator' | 'dataProcessor' | 'write'
>

export type AtomaSchema<
    Entities extends Record<string, Types.Entity>
> = Readonly<Partial<{ [Name in keyof Entities & string]: AtomaStoreSchema<Entities, Name> }>>
