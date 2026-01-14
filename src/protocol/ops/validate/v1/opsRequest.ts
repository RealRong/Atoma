import type { Meta } from '../../../core/meta'
import type { Operation } from '../../types'
import { invalid, isObject } from './common'
import { assertMetaV1 } from './meta'
import { assertOperationV1 } from './operation'

export function assertOpsRequestV1(value: unknown): { meta: Meta; ops: Operation[] } {
    if (!isObject(value)) throw invalid('INVALID_REQUEST', 'Invalid body', { kind: 'validation', part: 'body' })
    const meta = assertMetaV1((value as any).meta)
    const opsRaw = (value as any).ops
    if (!Array.isArray(opsRaw)) throw invalid('INVALID_REQUEST', 'Missing ops', { kind: 'validation', part: 'body', field: 'ops' })
    const ops = opsRaw.map(op => assertOperationV1(op))
    return { meta, ops }
}

export function assertOutgoingOpsV1(args: { meta: Meta; ops: Operation[] }) {
    assertMetaV1(args.meta)
    if (!Array.isArray(args.ops)) throw invalid('INVALID_REQUEST', 'Missing ops', { kind: 'validation', part: 'body', field: 'ops' })
    args.ops.forEach(op => { void assertOperationV1(op) })
}

