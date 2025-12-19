import type { BatchRequest } from '../types'
import { throwError } from '../error'
import { Protocol } from '../../protocol'

export function validateAndNormalizeRequest(body: any): BatchRequest {
    const res = Protocol.batch.validate.request(body)
    if (res.ok) return res.value
    throwError(res.error.code, res.error.message, (res.error as any).details)
}
