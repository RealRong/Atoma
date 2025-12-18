import type { ChangeKind } from '../../protocol/sync'
import type { StandardError } from '../types'

export type WriteKind = 'create' | 'patch' | 'delete'

export type StoredWriteReplay =
    | {
        kind: 'ok'
        resource: string
        id: string
        changeKind: ChangeKind
        serverVersion: number
        cursor?: number
        data?: unknown
    }
    | {
        kind: 'error'
        error: StandardError
        currentValue?: unknown
        currentVersion?: number
    }

