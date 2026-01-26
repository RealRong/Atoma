import { Shared } from '#shared'

const { z } = Shared.zod

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const createClientOptionsSchema = z.object({
    schema: z.any().optional(),
    dataProcessor: z.any().optional(),
    backend: z.any(),
    plugins: z.array(z.any()).optional(),
})
    .loose()
    .superRefine((value: any, ctx) => {
        const backend = value.backend
        if (!isRecord(backend)) {
            ctx.addIssue({ code: 'custom', message: 'backend 必须是对象（createHttpBackend 或其它 backend 工厂的返回值）' })
            return
        }
        if (typeof backend.key !== 'string' || !backend.key.trim()) {
            ctx.addIssue({ code: 'custom', message: 'backend.key 必须是非空字符串' })
        }

        const store = backend.store
        if (!isRecord(store) || !isRecord(store.opsClient) || typeof store.opsClient.executeOps !== 'function') {
            ctx.addIssue({ code: 'custom', message: 'backend.store.opsClient.executeOps 必须是函数' })
        }

        const remote = backend.remote
        if (remote !== undefined && (!isRecord(remote) || !isRecord(remote.opsClient) || typeof remote.opsClient.executeOps !== 'function')) {
            ctx.addIssue({ code: 'custom', message: 'backend.remote.opsClient.executeOps 必须是函数（如提供 remote）' })
        }
    })
