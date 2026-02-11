import type { Entity } from 'atoma-types/core'
import type {
    HookEmit,
    HookEventName,
    HookHandlers,
    HookPayloadMap,
    HookRegistry as HookRegistryType,
    Hooks
} from 'atoma-types/runtime'

const HOOK_EVENT_NAMES: HookEventName[] = [
    'readStart',
    'readFinish',
    'writeStart',
    'writePatches',
    'writeCommitted',
    'writeFailed',
    'storeCreated'
]

type HandlerSetMap = {
    [K in HookEventName]: Set<NonNullable<HookHandlers[K]>>
}

type HandlerInputMap = {
    [K in HookEventName]: HookHandlers[K] | undefined
}

function createHandlerSets(): HandlerSetMap {
    return {
        readStart: new Set(),
        readFinish: new Set(),
        writeStart: new Set(),
        writePatches: new Set(),
        writeCommitted: new Set(),
        writeFailed: new Set(),
        storeCreated: new Set()
    }
}

export class HookRegistry implements HookRegistryType {
    private readonly handlers: HandlerSetMap = createHandlerSets()

    get has() {
        return {
            event: (name: HookEventName) => this.handlers[name].size > 0,
            writePatches: this.handlers.writePatches.size > 0
        }
    }

    register = (hooks: Hooks) => {
        if (!hooks) return () => {}

        const cleanups: Array<() => void> = []
        const entries = this.toHandlerInputMap(hooks)

        for (const eventName of HOOK_EVENT_NAMES) {
            this.addHandler(eventName, entries[eventName], cleanups)
        }

        let active = true
        return () => {
            if (!active) return
            active = false
            cleanups.forEach(cleanup => cleanup())
        }
    }

    readonly emit: HookEmit = {
        readStart: <T extends Entity>(args: HookPayloadMap<T>['readStart']) => this.emitEvent('readStart', args),
        readFinish: <T extends Entity>(args: HookPayloadMap<T>['readFinish']) => this.emitEvent('readFinish', args),
        writeStart: <T extends Entity>(args: HookPayloadMap<T>['writeStart']) => this.emitEvent('writeStart', args),
        writePatches: <T extends Entity>(args: HookPayloadMap<T>['writePatches']) => this.emitEvent('writePatches', args),
        writeCommitted: <T extends Entity>(args: HookPayloadMap<T>['writeCommitted']) => this.emitEvent('writeCommitted', args),
        writeFailed: <T extends Entity>(args: HookPayloadMap<T>['writeFailed']) => this.emitEvent('writeFailed', args),
        storeCreated: <T extends Entity>(args: HookPayloadMap<T>['storeCreated']) => this.emitEvent('storeCreated', args)
    }

    private toHandlerInputMap = (hooks: Hooks): HandlerInputMap => {
        return {
            readStart: hooks.read?.onStart,
            readFinish: hooks.read?.onFinish,
            writeStart: hooks.write?.onStart,
            writePatches: hooks.write?.onPatches,
            writeCommitted: hooks.write?.onCommitted,
            writeFailed: hooks.write?.onFailed,
            storeCreated: hooks.store?.onCreated
        }
    }

    private addHandler = <K extends HookEventName>(
        eventName: K,
        handler: HookHandlers[K] | undefined,
        cleanups: Array<() => void>
    ) => {
        if (!handler) return

        const set = this.handlers[eventName] as Set<NonNullable<HookHandlers[K]>>
        const entry = handler as NonNullable<HookHandlers[K]>
        set.add(entry)
        cleanups.push(() => {
            set.delete(entry)
        })
    }

    private emitEvent = <K extends HookEventName>(eventName: K, args: unknown) => {
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
