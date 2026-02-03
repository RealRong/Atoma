import type * as Types from '../core'
import type { AtomaSchema } from './schema'
import type { ClientPlugin } from './plugins'

export type CreateClientOptions<
    Entities extends Record<string, Types.Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = Readonly<{
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema
    backend?: string | BackendInput
    plugins?: ReadonlyArray<ClientPlugin>
}>

export type BackendInput = Readonly<{
    baseURL: string
}>
