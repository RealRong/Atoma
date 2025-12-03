import { IndexType, StoreKey } from '../types'

export const normalizeNumber = (value: any, field: string, kind: IndexType, id: StoreKey): number => {
    const num = typeof value === 'number' ? value : kind === 'date' ? new Date(value).getTime() : Number(value)
    if (Number.isNaN(num)) {
        throw new Error(`[Atoma Index] Field "${field}" expects type "${kind}", but got invalid value for item ${String(id)}.`)
    }
    return num
}

export const validateString = (value: any, field: string, id: StoreKey): string => {
    if (typeof value !== 'string') {
        throw new Error(`[Atoma Index] Field "${field}" expects type "string", but got "${typeof value}" for item ${String(id)}.`)
    }
    return value
}
