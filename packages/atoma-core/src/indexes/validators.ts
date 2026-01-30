import { IndexType } from '../types'
import type { EntityId } from 'atoma-protocol'

export const normalizeNumber = (value: any, field: string, kind: IndexType, id: EntityId | string): number => {
    const num =
        typeof value === 'number'
            ? value
            : kind === 'date'
                ? new Date(value).getTime()
                : Number(value)

    // 拒绝 NaN/Infinity，避免索引中出现不可排序的键
    if (!Number.isFinite(num)) {
        throw new Error(`[Atoma Index] Field "${field}" expects type "${kind}", but got invalid value for item ${String(id)}.`)
    }
    return num
}

export const validateString = (value: any, field: string, id: EntityId | string): string => {
    if (typeof value !== 'string') {
        throw new Error(`[Atoma Index] Field "${field}" expects type "string", but got "${typeof value}" for item ${String(id)}.`)
    }
    return value
}
