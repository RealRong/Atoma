import type { IndexType } from 'atoma-types/core'
import type { EntityId } from 'atoma-types/protocol'

export const normalizeNumber = (value: unknown, field: string, kind: IndexType, id: EntityId | string): number => {
    const num =
        typeof value === 'number'
            ? value
            : kind === 'date'
                ? new Date(value as string | number | Date).getTime()
                : Number(value)

    // 拒绝 NaN/Infinity，避免索引中出现不可排序的键
    if (!Number.isFinite(num)) {
        throw new Error(`[Atoma Index] Field "${field}" expects type "${kind}", but got invalid value for item ${String(id)}.`)
    }
    return num
}

export const validateString = (value: unknown, field: string, id: EntityId | string): string => {
    if (typeof value !== 'string') {
        throw new Error(`[Atoma Index] Field "${field}" expects type "string", but got "${typeof value}" for item ${String(id)}.`)
    }
    return value
}