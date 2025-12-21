import { StoreKey } from '../../core/types'

export interface QueuedOperation {
    id: string
    type: 'put' | 'delete'
    key?: StoreKey
    value?: any
    timestamp: number
    retryCount?: number
}

export interface HTTPAdapterEvents {
    onSyncStart?: (pending: number) => void
    onSyncComplete?: (remaining: number) => void
    onSyncError?: (error: Error, op: QueuedOperation) => void
    onQueueChange?: (size: number) => void
    onConflictResolved?: (serverValue: any, key: StoreKey) => void
    onQueueFull?: (droppedOp: QueuedOperation, maxSize: number) => void
}

export class HTTPEventEmitter {
    constructor(private events?: HTTPAdapterEvents) { }

    emitSyncStart(pending: number): void {
        this.events?.onSyncStart?.(pending)
    }

    emitSyncComplete(remaining: number): void {
        this.events?.onSyncComplete?.(remaining)
    }

    emitSyncError(error: Error, op: QueuedOperation): void {
        this.events?.onSyncError?.(error, op)
    }

    emitQueueChange(size: number): void {
        this.events?.onQueueChange?.(size)
    }

    emitConflictResolved(serverValue: any, key: StoreKey): void {
        this.events?.onConflictResolved?.(serverValue, key)
    }

    emitQueueFull(droppedOp: QueuedOperation, maxSize: number): void {
        this.events?.onQueueFull?.(droppedOp, maxSize)
    }
}
