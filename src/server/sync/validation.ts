import { throwError } from '../error'

export function validateSyncSubscribeQuery(args: { cursor: any }): { cursor: number } {
    const cursorRaw = args.cursor
    const cursor = (() => {
        if (cursorRaw === undefined || cursorRaw === null || cursorRaw === '') return 0
        const n = Number(cursorRaw)
        return Number.isFinite(n) && n >= 0 ? Math.floor(n) : NaN
    })()
    if (!Number.isFinite(cursor)) {
        throwError('INVALID_REQUEST', 'Invalid cursor', { kind: 'validation', path: 'cursor' })
    }
    return { cursor }
}

