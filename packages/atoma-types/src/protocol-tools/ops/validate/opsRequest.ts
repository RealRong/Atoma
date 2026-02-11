import type { Meta, RemoteOp } from 'atoma-types/protocol'
import { makeValidationDetails, requireArray, requireObject } from './common'
import { assertMeta } from './meta'
import { assertRemoteOp } from './operation'

export function assertRemoteOpsRequest(value: unknown): { meta: Meta; ops: RemoteOp[] } {
    const detailsFor = makeValidationDetails('body')
    const obj = requireObject(value, { code: 'INVALID_REQUEST', message: 'Invalid body', details: detailsFor() })
    const meta = assertMeta((obj as any).meta)
    const opsRaw = requireArray((obj as any).ops, { code: 'INVALID_REQUEST', message: 'Missing ops', details: detailsFor('ops') })
    const ops = opsRaw.map(op => assertRemoteOp(op))
    return { meta, ops }
}

export function assertOutgoingRemoteOps(args: { meta: Meta; ops: RemoteOp[] }) {
    const detailsFor = makeValidationDetails('body')
    assertMeta(args.meta)
    requireArray(args.ops, { code: 'INVALID_REQUEST', message: 'Missing ops', details: detailsFor('ops') })
    args.ops.forEach(op => { void assertRemoteOp(op) })
}
