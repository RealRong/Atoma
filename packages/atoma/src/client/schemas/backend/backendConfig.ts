import { Shared } from '#shared'
import { anyFunction, nonEmptyString } from '#client/schemas/common'

const { z } = Shared.zod

type ResolvedEndpoint =
    | { type: 'http'; http: unknown }
    | { type: 'memory'; memory: unknown }
    | { type: 'indexeddb'; indexeddb: unknown }
    | { type: 'customOps'; id: string; opsClient: unknown; subscribe?: unknown; sse?: unknown }

const httpBackendConfigSchema = z.object({
    baseURL: nonEmptyString(),
    opsPath: z.string().optional(),
    headers: z.any().optional(),
    retry: z.any().optional(),
    fetchFn: anyFunction().optional(),
    onRequest: anyFunction().optional(),
    onResponse: anyFunction().optional(),
    responseParser: anyFunction().optional()
}).loose()

const httpSubscribeConfigSchema = z.object({
    subscribe: z.object({
        buildUrl: anyFunction().optional(),
        connect: anyFunction().optional()
    }).loose().optional()
}).loose()

const httpSyncBackendConfigSchema = httpBackendConfigSchema.merge(httpSubscribeConfigSchema).loose()

const memoryBackendConfigSchema = z.object({
    seed: z.record(z.string(), z.array(z.any())).optional()
}).loose()

const indexeddbBackendConfigSchema = z.object({
    tableForResource: anyFunction()
}).loose()

const opsClientSchema = z.custom<any>(value => {
    if (!value || typeof value !== 'object') return false
    return typeof (value as any).executeOps === 'function'
})

const storeCustomOpsBackendConfigSchema = z.object({
    id: nonEmptyString(),
    opsClient: opsClientSchema
}).loose()

const customOpsBackendConfigSchema = storeCustomOpsBackendConfigSchema.extend({
    subscribe: anyFunction().optional(),
    sse: z.object({
        buildUrl: anyFunction(),
        connect: anyFunction().optional()
    }).loose().optional()
}).loose()

export const remoteStoreBackendEndpointConfigSchema = z.union([
    nonEmptyString(),
    z.object({ http: httpBackendConfigSchema }).loose(),
    storeCustomOpsBackendConfigSchema
])

export const remoteBackendEndpointConfigSchema = z.union([
    nonEmptyString(),
    z.object({ http: httpSyncBackendConfigSchema }).loose(),
    customOpsBackendConfigSchema
])

export const storeBackendEndpointConfigSchema = z.union([
    nonEmptyString(),
    z.object({ http: httpBackendConfigSchema }).loose(),
    z.object({ memory: memoryBackendConfigSchema }).loose(),
    z.object({ indexeddb: indexeddbBackendConfigSchema }).loose(),
    storeCustomOpsBackendConfigSchema
])

export const backendEndpointConfigSchema = z.union([
    nonEmptyString(),
    z.object({ http: httpSyncBackendConfigSchema }).loose(),
    z.object({ memory: memoryBackendConfigSchema }).loose(),
    z.object({ indexeddb: indexeddbBackendConfigSchema }).loose(),
    customOpsBackendConfigSchema
])

export const backendConfigSchema = z.union([
    storeBackendEndpointConfigSchema,
    backendEndpointConfigSchema,
    z.object({
        local: storeBackendEndpointConfigSchema.optional(),
        remote: backendEndpointConfigSchema.optional()
    })
        .loose()
        .superRefine((value, ctx) => {
            if (!value.local && !value.remote) {
                ctx.addIssue({ code: 'custom', message: 'backend.local 或 backend.remote 至少需要提供一个' })
            }
        })
])

export const storeBackendEndpointResolvedSchema = storeBackendEndpointConfigSchema.transform((cfg): ResolvedEndpoint => {
    if (typeof cfg === 'string') return { type: 'http', http: { baseURL: cfg } }
    if ('http' in cfg) return { type: 'http', http: cfg.http }
    if ('memory' in cfg) return { type: 'memory', memory: cfg.memory }
    if ('indexeddb' in cfg) return { type: 'indexeddb', indexeddb: cfg.indexeddb }
    return { type: 'customOps', id: cfg.id, opsClient: cfg.opsClient }
})

export const backendEndpointResolvedSchema = backendEndpointConfigSchema.transform((cfg): ResolvedEndpoint => {
    if (typeof cfg === 'string') return { type: 'http', http: { baseURL: cfg } }
    if (typeof cfg === 'object' && cfg && !Array.isArray(cfg) && 'http' in cfg) return { type: 'http', http: (cfg as any).http }
    if (typeof cfg === 'object' && cfg && !Array.isArray(cfg) && 'memory' in cfg) return { type: 'memory', memory: (cfg as any).memory }
    if (typeof cfg === 'object' && cfg && !Array.isArray(cfg) && 'indexeddb' in cfg) return { type: 'indexeddb', indexeddb: (cfg as any).indexeddb }
    return {
        type: 'customOps',
        id: (cfg as any).id,
        opsClient: (cfg as any).opsClient,
        ...((cfg as any).subscribe ? { subscribe: (cfg as any).subscribe } : {}),
        ...((cfg as any).sse ? { sse: (cfg as any).sse } : {})
    }
})

export const backendResolutionConfigSchema = z.union([
    storeBackendEndpointResolvedSchema.transform(endpoint => ({ kind: 'single' as const, endpoint })),
    backendEndpointResolvedSchema.transform(endpoint => ({ kind: 'single' as const, endpoint })),
    z.object({
        local: storeBackendEndpointResolvedSchema.optional(),
        remote: backendEndpointResolvedSchema.optional()
    })
        .loose()
        .superRefine((value, ctx) => {
            if (!value.local && !value.remote) {
                ctx.addIssue({ code: 'custom', message: 'backend.local 或 backend.remote 至少需要提供一个' })
            }
        })
        .transform(value => ({ kind: 'pair' as const, local: value.local, remote: value.remote }))
])
