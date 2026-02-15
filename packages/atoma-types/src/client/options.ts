import type { Entity, ExecutionRoute } from '../core'
import type { AtomaSchema } from './schema'
import type { ClientPlugin } from './plugins'

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = Readonly<{
    schema?: Schema
    plugins?: ReadonlyArray<ClientPlugin>
    defaultRoute?: ExecutionRoute
}>
