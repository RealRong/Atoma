import type { UpsertWriteOptions, WriteIntentOptions } from 'atoma-types/core'

export function buildUpsertIntentOptions(options?: UpsertWriteOptions): WriteIntentOptions | undefined {
    if (!options) return undefined
    const out: WriteIntentOptions = {}
    if (typeof options.merge === 'boolean') out.merge = options.merge
    if (options.mode === 'strict' || options.mode === 'loose') out.upsert = { mode: options.mode }
    return Object.keys(out).length ? out : undefined
}
