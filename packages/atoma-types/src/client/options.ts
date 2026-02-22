import type { Entity, StoreProcessor } from '../core'
import type { EntityId } from '../shared'
import type { AtomaSchema } from './schema'
import type { ClientPlugin } from './plugins'

export type CreateClientStoresOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>
> = Readonly<{
    schema?: Schema
    createId?: () => EntityId
    processor?: StoreProcessor<Entity>
}>

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = Readonly<{
    stores?: CreateClientStoresOptions<Entities, Schema>
    plugins?: ReadonlyArray<ClientPlugin>
}>
