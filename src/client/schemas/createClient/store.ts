import type { StoreBatchArgs } from '#client/types'
import type { ZodType } from 'zod/v4'
import { Shared } from '#shared'
import { nonEmptyString } from '#client/schemas/common'
import { remoteStoreBackendEndpointConfigSchema, storeBackendEndpointConfigSchema } from '#client/schemas/backend'
import { httpEndpointOptionsSchema } from '#client/schemas/createClient/http'

const { z } = Shared.zod

export const storeBatchArgsSchema: ZodType<StoreBatchArgs> = z.union([
    z.boolean(),
    z.object({
        enabled: z.boolean().optional(),
        maxBatchSize: z.number().finite().positive().optional(),
        flushIntervalMs: z.number().finite().nonnegative().optional(),
        devWarnings: z.boolean().optional()
    }).loose()
])

export const storeConfigSchema = z.discriminatedUnion('type', [
    z.object({
        type: z.literal('http'),
        url: nonEmptyString(),
        http: httpEndpointOptionsSchema.optional()
    }).loose(),
    z.object({
        type: z.literal('indexeddb'),
        tables: z.record(z.string(), z.any())
    }).loose(),
    z.object({
        type: z.literal('localServer'),
        url: nonEmptyString(),
        http: httpEndpointOptionsSchema.optional()
    }).loose(),
    z.object({
        type: z.literal('memory'),
        seed: z.record(z.string(), z.array(z.any())).optional()
    }).loose(),
    z.object({
        type: z.literal('custom'),
        role: z.union([z.literal('local'), z.literal('remote')]),
        backend: storeBackendEndpointConfigSchema
    }).loose()
])
    .superRefine((storeConfig: any, ctx) => {
        if (storeConfig.type !== 'custom') return
        if (storeConfig.role !== 'remote') return

        const ok = remoteStoreBackendEndpointConfigSchema.safeParse(storeConfig.backend).success
        if (!ok) {
            ctx.addIssue({
                code: 'custom',
                message: 'store.type="custom" 且 role="remote" 时，store.backend 必须是远端能力（http 或自定义 opsClient），不能使用 memory/indexeddb'
            })
        }
    })
