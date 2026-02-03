/**
 * Event emitter type
 */
export type EventHandler<T = any> = (data: T) => void

export interface IEventEmitter {
    on(event: string, handler: EventHandler): void
    off(event: string, handler: EventHandler): void
    emit(event: string, data?: any): void
}
