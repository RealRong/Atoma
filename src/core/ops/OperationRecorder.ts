import type { Patch } from 'immer'
import type { OperationContext } from '../types'

export type OperationRecord = Readonly<{
    storeName: string
    opContext: OperationContext
    patches: Patch[]
    inversePatches: Patch[]
}>

export interface OperationRecorder {
    record: (record: OperationRecord) => void
}

export class NoopOperationRecorder implements OperationRecorder {
    record(_record: OperationRecord) {
        // noop
    }
}

