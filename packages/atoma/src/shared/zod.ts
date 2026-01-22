import { z } from 'zod/v4'

export { z }

type ZodIssueLike = { path?: Array<string | number>; message?: string }

function formatPath(path: Array<string | number> | undefined): string {
    if (!path || !path.length) return ''
    return path
        .map(seg => (typeof seg === 'number' ? `[${seg}]` : String(seg)))
        .join('.')
        .replace(/\.?\[(\d+)\]/g, '[$1]')
}

export function formatZodErrorMessage(error: unknown, prefix?: string): string {
    const anyErr = error as any
    const issues = Array.isArray(anyErr?.issues) ? (anyErr.issues as ZodIssueLike[]) : undefined
    if (!issues?.length) {
        const msg = typeof anyErr?.message === 'string' ? anyErr.message : String(error)
        return prefix ? `${prefix}${msg}` : msg
    }

    const lines = issues.map(issue => {
        const p = formatPath(issue.path)
        const m = issue.message ? String(issue.message) : 'Invalid input'
        return p ? `${p}: ${m}` : m
    })

    const head = prefix ? `${prefix}配置校验失败：` : '配置校验失败：'
    return `${head}\n- ${lines.join('\n- ')}`
}

export function parseOrThrow<TSchema extends z.ZodTypeAny>(
    schema: TSchema,
    value: unknown,
    args?: { prefix?: string }
): z.infer<TSchema> {
    const result = schema.safeParse(value)
    if (result.success) return result.data
    throw new Error(formatZodErrorMessage(result.error, args?.prefix))
}

