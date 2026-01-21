import { Shared } from '#shared'
import { anyFunction } from '#client/schemas/common'

const { z } = Shared.zod

export const httpEndpointOptionsSchema = z.object({
    opsPath: z.string().optional(),
    headers: z.any().optional(),
    retry: z.any().optional(),
    fetchFn: anyFunction().optional(),
    onRequest: anyFunction().optional(),
    onResponse: anyFunction().optional(),
    responseParser: anyFunction().optional()
}).loose()
