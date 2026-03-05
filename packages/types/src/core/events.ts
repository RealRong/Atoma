/**
 * Event emitter type
 */
export type EventHandler<T = unknown> = (data: T) => void

export interface EventEmitter {
    on(event: string, handler: EventHandler): void
    off(event: string, handler: EventHandler): void
    emit(event: string, data?: unknown): void
}
