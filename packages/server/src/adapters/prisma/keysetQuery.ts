import type { SortRule } from '@atoma-js/types/protocol'
import {
    compareOpForAfter,
    decodeCursorToken,
    encodeCursorToken,
    getCursorValuesFromRow,
    isSameSort,
    readNullCursorField,
    reverseOrderBy
} from '../shared/keyset'
import { throwError } from '../../error'

function assertCursorValuesComparable(values: unknown[], orderBy: SortRule[], path: string) {
    if (values.length < orderBy.length) {
        throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path })
    }
    const nullField = readNullCursorField(values, orderBy)
    if (nullField) {
        throwError('INVALID_QUERY', 'Cursor pagination does not support null sort values', {
            kind: 'validation',
            path,
            field: nullField
        })
    }
}

function buildPrismaKeysetWhere(orderBy: SortRule[], values: unknown[], path: string) {
    assertCursorValuesComparable(values, orderBy, path)

    const or: any[] = []
    for (let i = 0; i < orderBy.length; i++) {
        const and: any[] = []
        for (let j = 0; j < i; j++) {
            and.push({ [orderBy[j].field]: values[j] })
        }
        const op = compareOpForAfter(orderBy[i].dir)
        and.push({ [orderBy[i].field]: { [op]: values[i] } })
        or.push({ AND: and })
    }

    return { OR: or }
}

export function buildKeysetWhere(args: {
    cursor: { token: string; before: boolean } | undefined
    orderBy: SortRule[]
    buildOrderBy: (orderBy: SortRule[]) => any
}) {
    if (!args.cursor?.token) {
        return {
            prismaOrderBy: args.buildOrderBy(args.orderBy),
            reverseResult: false,
            keysetWhere: undefined as any
        }
    }

    const queryOrderBy = args.cursor.before ? reverseOrderBy(args.orderBy) : args.orderBy
    const path = args.cursor.before ? 'before' : 'after'
    let decoded: ReturnType<typeof decodeCursorToken>
    try {
        decoded = decodeCursorToken(args.cursor.token)
    } catch {
        throwError('INVALID_QUERY', 'Invalid cursor token', { kind: 'validation', path })
    }

    if (!isSameSort(decoded.sort, args.orderBy)) {
        throwError('INVALID_QUERY', 'Cursor token sort does not match query.sort', { kind: 'validation', path })
    }

    return {
        prismaOrderBy: args.buildOrderBy(queryOrderBy),
        reverseResult: args.cursor.before,
        keysetWhere: buildPrismaKeysetWhere(queryOrderBy, decoded.values, path)
    }
}

export function encodePageCursor(row: any, orderBy: SortRule[]) {
    const values = getCursorValuesFromRow(row, orderBy)
    assertCursorValuesComparable(values, orderBy, 'page.cursor')
    return encodeCursorToken(values, orderBy)
}
