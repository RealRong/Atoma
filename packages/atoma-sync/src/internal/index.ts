import type { CursorStore } from '#sync/types'
import type { Cursor } from 'atoma/protocol'

export function toError(error: unknown): Error {
    return error instanceof Error ? error : new Error(String(error))
}

export async function readCursorOrInitial(args: {
    cursor: CursorStore
    initialCursor?: Cursor
}): Promise<Cursor> {
    const cur = await args.cursor.get()
    if (cur !== undefined && cur !== null && cur !== '') return cur
    return args.initialCursor ?? '0'
}
