import type { Entity } from '../core'
import type { AtomaSchema } from './schema'
import type { ClientPlugin } from './plugins'
import type { StoresConfig } from '../runtime'

export type CreateClientStoresOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities>
> = StoresConfig<Entities, Schema>

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = Readonly<{
    stores?: CreateClientStoresOptions<Entities, Schema>
    plugins?: ReadonlyArray<ClientPlugin>
}>
