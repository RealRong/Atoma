import type { QueryParams } from '../types'

export function mergeForcedWhere(params: QueryParams, forcedWhere: Record<string, any>) {
    if (!forcedWhere || typeof forcedWhere !== 'object' || Array.isArray(forcedWhere)) return
    const base = (params.where && typeof params.where === 'object' && !Array.isArray(params.where))
        ? params.where
        : undefined
    params.where = { ...(base ?? {}), ...forcedWhere }
}

