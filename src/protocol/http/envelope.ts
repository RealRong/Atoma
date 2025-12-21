import type { PageInfo } from '../batch/pagination'
import type { StandardError } from '../error/types'

export type StandardEnvelope<T> = {
    ok: boolean
    data?: T | T[] | null
    pageInfo?: PageInfo
    error?: StandardError
    meta?: unknown
}
