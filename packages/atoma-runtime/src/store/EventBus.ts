import type { Entity } from 'atoma-types/core'
import type {
    StoreEventName,
    StoreEventListener,
    StoreEventListenerOptions,
    StoreEventPayloadMap,
    StoreEventBus as StoreEventBusType,
} from 'atoma-types/runtime'

type HandlerSetMap = {
    [K in StoreEventName]: Map<StoreEventListener<StoreEventName>, Readonly<{ once: boolean }>>
}

function createHandlerSets(): HandlerSetMap {
    return {
        readStart: new Map(),
        readFinish: new Map(),
        writeStart: new Map(),
        writeCommitted: new Map(),
        writeFailed: new Map(),
        changeStart: new Map(),
        changeCommitted: new Map(),
        changeFailed: new Map(),
        storeCreated: new Map()
    }
}

export class EventBus implements StoreEventBusType {
    private readonly handlers: HandlerSetMap = createHandlerSets()

    get has() {
        return {
            event: (name: StoreEventName) => this.handlers[name].size > 0
        }
    }

    on = <K extends StoreEventName>(
        name: K,
        listener: StoreEventListener<K>,
        options?: StoreEventListenerOptions
    ): (() => void) => {
        const listeners = this.handlers[name]
        listeners.set(listener as StoreEventListener<StoreEventName>, {
            once: options?.once === true
        })

        let active = true
        const signal = options?.signal
        const onAbort = () => {
            this.off(name, listener)
        }

        if (signal) {
            if (signal.aborted) {
                this.off(name, listener)
                return () => {}
            }
            signal.addEventListener('abort', onAbort, { once: true })
        }

        return () => {
            if (!active) return
            active = false
            if (signal) {
                signal.removeEventListener('abort', onAbort)
            }
            this.off(name, listener)
        }
    }

    off = <K extends StoreEventName>(name: K, listener: StoreEventListener<K>): void => {
        const listeners = this.handlers[name]
        listeners.delete(listener as StoreEventListener<StoreEventName>)
    }

    once = <K extends StoreEventName>(name: K, listener: StoreEventListener<K>): (() => void) => {
        return this.on(name, listener, { once: true })
    }

    emit = <K extends StoreEventName, T extends Entity = Entity>(name: K, payload: StoreEventPayloadMap<T>[K]): void => {
        const listeners = this.handlers[name]
        if (!listeners.size) return

        const entries = Array.from(listeners.entries())
        for (const [listener, options] of entries) {
            if (options.once) {
                listeners.delete(listener)
            }
            try {
                listener(payload as StoreEventPayloadMap<Entity>[K])
            } catch {
                // ignore
            }
        }
    }
}
