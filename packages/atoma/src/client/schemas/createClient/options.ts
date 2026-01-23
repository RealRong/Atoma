import { Shared } from '#shared'
import { httpEndpointOptionsSchema } from '#client/schemas/createClient/http'
import { storeBatchArgsSchema, storeConfigSchema } from '#client/schemas/createClient/store'

const { z } = Shared.zod

const remoteConfigSchema = z.union([
    z.string(),
    z.object({
        url: z.string(),
        http: httpEndpointOptionsSchema.optional(),
        sse: z.string().optional(),
        subscribe: z.any().optional()
    }).loose()
])

export const createClientOptionsSchema = z.object({
    schema: z.any().optional(),
    dataProcessor: z.any().optional(),
    http: httpEndpointOptionsSchema.optional(),
    store: storeConfigSchema,
    remote: remoteConfigSchema.optional(),
    storeBatch: storeBatchArgsSchema.optional()
})
    .loose()
