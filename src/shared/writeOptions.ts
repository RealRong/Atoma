import type { WriteOptions } from '#protocol'

export function upsertWriteOptionsFromDispatch(op: unknown): WriteOptions | undefined {
    if (!op || typeof op !== 'object') return undefined
    if ((op as any).type !== 'upsert') return undefined

    const mode = (op as any).upsert?.mode
    const merge = (op as any).upsert?.merge

    const out: WriteOptions = {}
    if (typeof merge === 'boolean') out.merge = merge
    if (mode === 'strict' || mode === 'loose') out.upsert = { mode }
    return Object.keys(out).length ? out : undefined
}

