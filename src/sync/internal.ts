import type { CursorStore, SyncTransport } from './types'
import type { Change, Cursor, Meta, Operation, OperationResult } from '#protocol'

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}

export function findOpResult(results: OperationResult[], opId: string): OperationResult {
    const found = results.find(r => r.opId === opId)
    if (found) return found
    return {
        opId,
        ok: false,
        error: {
            code: 'INTERNAL',
            message: 'Missing result',
            kind: 'internal'
        }
    }
}

export function toOperationError(result: OperationResult): Error {
    if (result.ok) return new Error('Operation failed')
    const message = typeof (result.error as any)?.message === 'string'
        ? (result.error as any).message
        : 'Operation failed'
    const err = new Error(message)
    ;(err as any).error = result.error
    return err
}

export async function executeSingleOp(args: {
    transport: SyncTransport
    op: Operation
    meta: Meta
}): Promise<OperationResult> {
    const res = await args.transport.opsClient.executeOps({ ops: [args.op], meta: args.meta })
    return findOpResult(res.results, args.op.opId)
}

export async function readCursorOrInitial(args: {
    cursor: CursorStore
    initialCursor?: Cursor
}): Promise<Cursor> {
    const cur = await args.cursor.get()
    if (cur !== undefined && cur !== null && cur !== '') return cur
    return args.initialCursor ?? '0'
}
