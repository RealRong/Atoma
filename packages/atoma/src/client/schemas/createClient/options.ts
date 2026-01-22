import { Shared } from '#shared'
import { httpEndpointOptionsSchema } from '#client/schemas/createClient/http'
import { storeBatchArgsSchema, storeConfigSchema } from '#client/schemas/createClient/store'
import { syncInputSchema } from '#client/schemas/createClient/sync'
import { getEchoEndpointError } from '#client/schemas/createClient/validation'

const { z } = Shared.zod

function resolveSyncUrl(sync: any): string | undefined {
    if (!sync) return undefined
    if (typeof sync.url === 'string' && sync.url.trim()) return sync.url.trim()
    const endpoint = sync.endpoint
    if (typeof endpoint === 'string' && endpoint.trim()) return endpoint.trim()
    if (endpoint && typeof endpoint === 'object' && typeof endpoint.url === 'string' && endpoint.url.trim()) return endpoint.url.trim()
    return undefined
}

export const createClientOptionsSchema = z.object({
    schema: z.any().optional(),
    dataProcessor: z.any().optional(),
    http: httpEndpointOptionsSchema.optional(),
    store: storeConfigSchema,
    storeBatch: storeBatchArgsSchema.optional(),
    sync: syncInputSchema.optional()
})
    .loose()
    .superRefine((value: any, ctx) => {
        if (value?.store?.type !== 'localServer') return
        const syncUrl = resolveSyncUrl(value?.sync)
        if (!syncUrl) return

        const msg = getEchoEndpointError({ localServerUrl: value.store.url, syncUrl })
        if (msg) ctx.addIssue({ code: 'custom', message: msg })
    })
