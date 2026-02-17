import type { Entity } from 'atoma-types/core'
import type {
    StoreEventEmit,
    StoreEventName,
    StoreEventHandlers,
    StoreEventPayloadMap,
    StoreEventRegistry as StoreEventRegistryType,
    StoreEvents
} from 'atoma-types/runtime'

const STORE_EVENT_NAMES: StoreEventName[] = [
    'readStart',
    'readFinish',
    'writeStart',
    'writeCommitted',
    'writeFailed',
    'storeCreated'
]

type HandlerSetMap = {
    [K in StoreEventName]: Set<NonNullable<StoreEventHandlers[K]>>
}

type HandlerInputMap = {
    [K in StoreEventName]: StoreEventHandlers[K] | undefined
}

function createHandlerSets(): HandlerSetMap {
    return {
        readStart: new Set(),
        readFinish: new Set(),
        writeStart: new Set(),
        writeCommitted: new Set(),
        writeFailed: new Set(),
        storeCreated: new Set()
    }
}

export class StoreEventRegistry implements StoreEventRegistryType {
    private readonly handlers: HandlerSetMap = createHandlerSets()

    get has() {
        return {
            event: (name: StoreEventName) => this.handlers[name].size > 0
        }
    }

    register = (events: StoreEvents) => {
        if (!events) return () => {}

        const cleanups: Array<() => void> = []
        const entries = this.toHandlerInputMap(events)

        for (const eventName of STORE_EVENT_NAMES) {
            this.addHandler(eventName, entries[eventName], cleanups)
        }

        let active = true
        return () => {
            if (!active) return
            active = false
            cleanups.forEach(cleanup => cleanup())
        }
    }

    readonly emit: StoreEventEmit = {
        readStart: <T extends Entity>(args: StoreEventPayloadMap<T>['readStart']) => this.emitEvent('readStart', args),
        readFinish: <T extends Entity>(args: StoreEventPayloadMap<T>['readFinish']) => this.emitEvent('readFinish', args),
        writeStart: <T extends Entity>(args: StoreEventPayloadMap<T>['writeStart']) => this.emitEvent('writeStart', args),
        writeCommitted: <T extends Entity>(args: StoreEventPayloadMap<T>['writeCommitted']) => this.emitEvent('writeCommitted', args),
        writeFailed: <T extends Entity>(args: StoreEventPayloadMap<T>['writeFailed']) => this.emitEvent('writeFailed', args),
        storeCreated: <T extends Entity>(args: StoreEventPayloadMap<T>['storeCreated']) => this.emitEvent('storeCreated', args)
    }

    private toHandlerInputMap = (events: StoreEvents): HandlerInputMap => {
        return {
            readStart: events.read?.onStart,
            readFinish: events.read?.onFinish,
            writeStart: events.write?.onStart,
            writeCommitted: events.write?.onCommitted,
            writeFailed: events.write?.onFailed,
            storeCreated: events.store?.onCreated
        }
    }

    private addHandler = <K extends StoreEventName>(
        eventName: K,
        handler: StoreEventHandlers[K] | undefined,
        cleanups: Array<() => void>
    ) => {
        if (!handler) return

        const set = this.handlers[eventName] as Set<NonNullable<StoreEventHandlers[K]>>
        const entry = handler as NonNullable<StoreEventHandlers[K]>
        set.add(entry)
        cleanups.push(() => {
            set.delete(entry)
        })
    }

    private emitEvent = <K extends StoreEventName>(eventName: K, args: unknown) => {
        const set = this.handlers[eventName] as Set<(args: unknown) => void>
        for (const handler of set) {
            try {
                handler(args)
            } catch {
                // ignore
            }
        }
    }
}
