import type { PageInfo } from '../batch/pagination'

export type StandardEnvelope<T> = {
    data: T | T[]
    pageInfo?: PageInfo
    message?: string
    code?: string | number
    isError?: boolean
    meta?: unknown
}

