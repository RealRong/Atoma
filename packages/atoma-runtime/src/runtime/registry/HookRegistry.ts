import type { RuntimeHookEventName, RuntimeHookRegistry, RuntimeHooks } from 'atoma-types/runtime'

type StoreCreatedArgs = Parameters<RuntimeHookRegistry['emit']['storeCreated']>[0]
type ReadStartArgs = Parameters<RuntimeHookRegistry['emit']['readStart']>[0]
type ReadFinishArgs = Parameters<RuntimeHookRegistry['emit']['readFinish']>[0]
type WriteStartArgs = Parameters<RuntimeHookRegistry['emit']['writeStart']>[0]
type WritePatchesArgs = Parameters<RuntimeHookRegistry['emit']['writePatches']>[0]
type WriteCommittedArgs = Parameters<RuntimeHookRegistry['emit']['writeCommitted']>[0]
type WriteFailedArgs = Parameters<RuntimeHookRegistry['emit']['writeFailed']>[0]

type HookEventMap = Readonly<{
    readStart: (args: ReadStartArgs) => void
    readFinish: (args: ReadFinishArgs) => void
    writeStart: (args: WriteStartArgs) => void
    writePatches: (args: WritePatchesArgs) => void
    writeCommitted: (args: WriteCommittedArgs) => void
    writeFailed: (args: WriteFailedArgs) => void
    storeCreated: (args: StoreCreatedArgs) => void
}>

type HookEventName = keyof HookEventMap

export class HookRegistry implements RuntimeHookRegistry {
    private readonly handlers: { [K in HookEventName]: Set<HookEventMap[K]> } = {
        readStart: new Set(),
        readFinish: new Set(),
        writeStart: new Set(),
        writePatches: new Set(),
        writeCommitted: new Set(),
        writeFailed: new Set(),
        storeCreated: new Set()
    }

    get has() {
        return {
            event: (name: RuntimeHookEventName) => this.handlers[name].size > 0,
            writePatches: this.handlers.writePatches.size > 0
        }
    }

    register = (hooks: RuntimeHooks) => {
        if (!hooks) return () => {}

        const cleanups: Array<() => void> = []

        const add = <K extends HookEventName>(name: K, fn?: HookEventMap[K]) => {
            if (!fn) return
            this.handlers[name].add(fn)
            cleanups.push(() => {
                this.handlers[name].delete(fn)
            })
        }

        add('readStart', hooks.read?.onStart)
        add('readFinish', hooks.read?.onFinish)
        add('writeStart', hooks.write?.onStart)
        add('writePatches', hooks.write?.onPatches)
        add('writeCommitted', hooks.write?.onCommitted)
        add('writeFailed', hooks.write?.onFailed)
        add('storeCreated', hooks.store?.onCreated)

        let active = true
        return () => {
            if (!active) return
            active = false
            cleanups.forEach(cleanup => cleanup())
        }
    }

    readonly emit = {
        readStart: (args: ReadStartArgs) => {
            this.dispatch('readStart', args)
        },
        readFinish: (args: ReadFinishArgs) => {
            this.dispatch('readFinish', args)
        },
        writeStart: (args: WriteStartArgs) => {
            this.dispatch('writeStart', args)
        },
        writePatches: (args: WritePatchesArgs) => {
            this.dispatch('writePatches', args)
        },
        writeCommitted: (args: WriteCommittedArgs) => {
            this.dispatch('writeCommitted', args)
        },
        writeFailed: (args: WriteFailedArgs) => {
            this.dispatch('writeFailed', args)
        },
        storeCreated: (args: StoreCreatedArgs) => {
            this.dispatch('storeCreated', args)
        }
    }

    private dispatch = <K extends HookEventName>(name: K, args: Parameters<HookEventMap[K]>[0]) => {
        const list = this.handlers[name] as Set<(payload: Parameters<HookEventMap[K]>[0]) => void>
        if (!list.size) return
        for (const fn of list) {
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }
}
