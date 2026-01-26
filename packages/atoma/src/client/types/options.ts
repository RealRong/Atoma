import type { Backend } from '#backend'
import type { Entity, StoreDataProcessor } from '#core'
import type { AtomaSchema } from './schema'
import type { ClientPlugin } from './plugin'

export type CreateClientOptions<
    Entities extends Record<string, Entity>,
    Schema extends AtomaSchema<Entities> = AtomaSchema<Entities>
> = Readonly<{
    /** Domain schema (indexes/relations/validators/etc). */
    schema?: Schema

    /** Global dataProcessor applied to all stores (per-store config overrides). */
    dataProcessor?: StoreDataProcessor<any>

    /** The fully assembled backend implementation (store/remote/notify/etc). */
    backend: Backend

    /** Optional plugins to install immediately (equivalent to calling `client.use(...)` in order). */
    plugins?: ReadonlyArray<ClientPlugin<any>>
}>

