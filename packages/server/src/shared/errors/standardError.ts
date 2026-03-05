import type { StandardError } from '@atoma-js/types/protocol'
import { errorStatus, toStandardError } from '../../error'

export function toStandard(reason: unknown, fallbackCode: string = 'INTERNAL'): StandardError {
    return toStandardError(reason, fallbackCode)
}

export function statusOf(error: Pick<StandardError, 'code'>): number {
    return errorStatus(error)
}
