import { zod } from '#shared'

const { z } = zod

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const createClientOptionsSchema = z.object({
    schema: z.any().optional(),
    dataProcessor: z.any().optional(),
    backend: z.any().optional(),
    plugins: z.array(z.any()).optional(),
})
    .loose()
    .superRefine((value: any, ctx) => {
        const backend = value.backend
        if (backend === undefined) return

        if (typeof backend === 'string') {
            if (!backend.trim()) {
                ctx.addIssue({ code: 'custom', message: 'backend 不能为空字符串' })
            }
            return
        }

        if (!isRecord(backend)) {
            ctx.addIssue({ code: 'custom', message: 'backend 必须是 string(url) | http配置对象 | Backend 实例' })
            return
        }

        const store = backend.store
        const remote = backend.remote
        const hasBackendShape = isRecord(store) || remote !== undefined

        if (hasBackendShape) {
            if (typeof backend.key !== 'string' || !backend.key.trim()) {
                ctx.addIssue({ code: 'custom', message: 'backend.key 必须是非空字符串' })
            }

            if (!isRecord(store) || !isRecord(store.opsClient) || typeof store.opsClient.executeOps !== 'function') {
                ctx.addIssue({ code: 'custom', message: 'backend.store.opsClient.executeOps 必须是函数' })
            }

            if (remote !== undefined && (!isRecord(remote) || !isRecord(remote.opsClient) || typeof remote.opsClient.executeOps !== 'function')) {
                ctx.addIssue({ code: 'custom', message: 'backend.remote.opsClient.executeOps 必须是函数（如提供 remote）' })
            }
            return
        }

        const baseURL = (backend as any).baseURL
        if (typeof baseURL !== 'string' || !baseURL.trim()) {
            ctx.addIssue({ code: 'custom', message: 'backend.baseURL 必填（http配置）' })
        }
    })
