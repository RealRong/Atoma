import type { ExecutionEvent } from 'atoma-types/runtime'

export class ExecutionEvents {
    private readonly listeners = new Set<(event: ExecutionEvent) => void>()

    subscribe = (listener: (event: ExecutionEvent) => void): (() => void) => {
        this.listeners.add(listener)
        return () => {
            this.listeners.delete(listener)
        }
    }

    emit = (event: ExecutionEvent): void => {
        for (const listener of this.listeners) {
            try {
                listener(event)
            } catch {
                // ignore
            }
        }
    }
}

