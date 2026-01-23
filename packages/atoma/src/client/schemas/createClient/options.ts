import { Shared } from '#shared'
import { httpEndpointOptionsSchema } from '#client/schemas/createClient/http'
import { storeBatchArgsSchema, storeConfigSchema } from '#client/schemas/createClient/store'

const { z } = Shared.zod

export const createClientOptionsSchema = z.object({
    schema: z.any().optional(),
    dataProcessor: z.any().optional(),
    http: httpEndpointOptionsSchema.optional(),
    store: storeConfigSchema,
    storeBatch: storeBatchArgsSchema.optional()
})
    .loose()
