import { zod } from 'atoma-shared'

const { z } = zod

function isRecord(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

export const createClientOptionsSchema = z.object({
    schema: z.any().optional(),
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
            ctx.addIssue({ code: 'custom', message: 'backend 必须是 string(url) | { baseURL }' })
            return
        }

        const baseURL = (backend as any).baseURL
        if (typeof baseURL !== 'string' || !baseURL.trim()) {
            ctx.addIssue({ code: 'custom', message: 'backend.baseURL 必填' })
        }
    })
