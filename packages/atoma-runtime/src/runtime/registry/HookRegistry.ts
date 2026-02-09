import type { Entity } from 'atoma-types/core'
import type {
    RuntimeHookEventName,
    RuntimeHookRegistry,
    RuntimeHooks,
    RuntimeReadStartArgs,
    RuntimeReadFinishArgs,
    RuntimeStoreCreatedArgs,
    RuntimeWriteCommittedArgs,
    RuntimeWriteFailedArgs,
    RuntimeWritePatchesArgs,
    RuntimeWriteStartArgs
} from 'atoma-types/runtime'

type ReadStartHandler = NonNullable<NonNullable<RuntimeHooks['read']>['onStart']>
type ReadFinishHandler = NonNullable<NonNullable<RuntimeHooks['read']>['onFinish']>
type WriteStartHandler = NonNullable<NonNullable<RuntimeHooks['write']>['onStart']>
type WritePatchesHandler = NonNullable<NonNullable<RuntimeHooks['write']>['onPatches']>
type WriteCommittedHandler = NonNullable<NonNullable<RuntimeHooks['write']>['onCommitted']>
type WriteFailedHandler = NonNullable<NonNullable<RuntimeHooks['write']>['onFailed']>
type StoreCreatedHandler = NonNullable<NonNullable<RuntimeHooks['store']>['onCreated']>

export class HookRegistry implements RuntimeHookRegistry {
    private readonly readStartHandlers = new Set<ReadStartHandler>()
    private readonly readFinishHandlers = new Set<ReadFinishHandler>()
    private readonly writeStartHandlers = new Set<WriteStartHandler>()
    private readonly writePatchesHandlers = new Set<WritePatchesHandler>()
    private readonly writeCommittedHandlers = new Set<WriteCommittedHandler>()
    private readonly writeFailedHandlers = new Set<WriteFailedHandler>()
    private readonly storeCreatedHandlers = new Set<StoreCreatedHandler>()

    get has() {
        return {
            event: (name: RuntimeHookEventName) => {
                switch (name) {
                    case 'readStart':
                        return this.readStartHandlers.size > 0
                    case 'readFinish':
                        return this.readFinishHandlers.size > 0
                    case 'writeStart':
                        return this.writeStartHandlers.size > 0
                    case 'writePatches':
                        return this.writePatchesHandlers.size > 0
                    case 'writeCommitted':
                        return this.writeCommittedHandlers.size > 0
                    case 'writeFailed':
                        return this.writeFailedHandlers.size > 0
                    case 'storeCreated':
                        return this.storeCreatedHandlers.size > 0
                    default:
                        return false
                }
            },
            writePatches: this.writePatchesHandlers.size > 0
        }
    }

    register = (hooks: RuntimeHooks) => {
        if (!hooks) return () => {}

        const cleanups: Array<() => void> = []

        const add = <H>(set: Set<H>, fn?: H) => {
            if (!fn) return
            set.add(fn)
            cleanups.push(() => {
                set.delete(fn)
            })
        }

        add(this.readStartHandlers, hooks.read?.onStart)
        add(this.readFinishHandlers, hooks.read?.onFinish)
        add(this.writeStartHandlers, hooks.write?.onStart)
        add(this.writePatchesHandlers, hooks.write?.onPatches)
        add(this.writeCommittedHandlers, hooks.write?.onCommitted)
        add(this.writeFailedHandlers, hooks.write?.onFailed)
        add(this.storeCreatedHandlers, hooks.store?.onCreated)

        let active = true
        return () => {
            if (!active) return
            active = false
            cleanups.forEach(cleanup => cleanup())
        }
    }

    readonly emit = {
        readStart: <T extends Entity>(args: RuntimeReadStartArgs<T>) => {
            for (const fn of this.readStartHandlers) {
                try {
                    fn(args)
                } catch {
                    // ignore
                }
            }
        },
        readFinish: <T extends Entity>(args: RuntimeReadFinishArgs<T>) => {
            for (const fn of this.readFinishHandlers) {
                try {
                    fn(args)
                } catch {
                    // ignore
                }
            }
        },
        writeStart: <T extends Entity>(args: RuntimeWriteStartArgs<T>) => {
            for (const fn of this.writeStartHandlers) {
                try {
                    fn(args)
                } catch {
                    // ignore
                }
            }
        },
        writePatches: <T extends Entity>(args: RuntimeWritePatchesArgs<T>) => {
            for (const fn of this.writePatchesHandlers) {
                try {
                    fn(args)
                } catch {
                    // ignore
                }
            }
        },
        writeCommitted: <T extends Entity>(args: RuntimeWriteCommittedArgs<T>) => {
            for (const fn of this.writeCommittedHandlers) {
                try {
                    fn(args)
                } catch {
                    // ignore
                }
            }
        },
        writeFailed: <T extends Entity>(args: RuntimeWriteFailedArgs<T>) => {
            for (const fn of this.writeFailedHandlers) {
                try {
                    fn(args)
                } catch {
                    // ignore
                }
            }
        },
        storeCreated: <T extends Entity>(args: RuntimeStoreCreatedArgs<T>) => {
            for (const fn of this.storeCreatedHandlers) {
                try {
                    fn(args)
                } catch {
                    // ignore
                }
            }
        }
    }
}
