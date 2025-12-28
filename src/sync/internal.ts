import type { CursorStore, SyncTransport, SyncWriteAck, SyncWriteReject } from './types'
import type { Change, Cursor, Meta, Operation, OperationResult } from '#protocol'

export interface SyncApplier {
    applyChanges: (changes: Change[]) => Promise<void> | void
    applyWriteAck: (ack: SyncWriteAck) => Promise<void> | void
    applyWriteReject: (reject: SyncWriteReject, conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual') => Promise<void> | void
}

export function createApplier(args: {
    defaultConflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual'
    onPullChanges?: (changes: Change[]) => Promise<void> | void
    onWriteAck?: (ack: SyncWriteAck) => Promise<void> | void
    onWriteReject?: (reject: SyncWriteReject, conflictStrategy?: 'server-wins' | 'client-wins' | 'reject' | 'manual') => Promise<void> | void
}): SyncApplier {
    return {
        applyChanges: async (changes) => {
            if (args.onPullChanges) {
                await Promise.resolve(args.onPullChanges(changes))
            }
        },
        applyWriteAck: async (ack) => {
            await Promise.resolve(args.onWriteAck?.(ack))
        },
        applyWriteReject: async (reject, conflictStrategy) => {
            await Promise.resolve(args.onWriteReject?.(reject, conflictStrategy ?? args.defaultConflictStrategy))
        }
    }
}

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
