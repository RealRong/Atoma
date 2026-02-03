import type {
    RuntimeHookRegistry,
    RuntimeHooks,
    RuntimeReadFinishArgs,
    RuntimeReadStartArgs,
    RuntimeWriteCommittedArgs,
    RuntimeWriteFailedArgs,
    RuntimeWritePatchesArgs,
    RuntimeWriteStartArgs
} from 'atoma-types/runtime'

type HookEntry = Readonly<{
    hooks: RuntimeHooks
}>

type StoreCreatedArgs = Parameters<RuntimeHookRegistry['emit']['storeCreated']>[0]

export class HookRegistry implements RuntimeHookRegistry {
    private readonly entries: HookEntry[] = []
    private writePatchesCount = 0

    get has() {
        return {
            writePatches: this.writePatchesCount > 0
        }
    }

    register = (hooks: RuntimeHooks) => {
        if (!hooks) return () => {}

        const entry: HookEntry = { hooks }
        this.entries.push(entry)
        if (hooks.write?.onPatches) this.writePatchesCount += 1

        let active = true
        return () => {
            if (!active) return
            active = false
            const index = this.entries.indexOf(entry)
            if (index >= 0) this.entries.splice(index, 1)
            if (hooks.write?.onPatches) {
                this.writePatchesCount = Math.max(0, this.writePatchesCount - 1)
            }
        }
    }

    readonly emit = {
        readStart: (args: RuntimeReadStartArgs) => {
            this.dispatchReadStart(args)
        },
        readFinish: (args: RuntimeReadFinishArgs) => {
            this.dispatchReadFinish(args)
        },
        writeStart: (args: RuntimeWriteStartArgs) => {
            this.dispatchWriteStart(args)
        },
        writePatches: (args: RuntimeWritePatchesArgs) => {
            this.dispatchWritePatches(args)
        },
        writeCommitted: (args: RuntimeWriteCommittedArgs) => {
            this.dispatchWriteCommitted(args)
        },
        writeFailed: (args: RuntimeWriteFailedArgs) => {
            this.dispatchWriteFailed(args)
        },
        storeCreated: (args: StoreCreatedArgs) => {
            this.dispatchStoreCreated(args)
        }
    }

    private dispatchReadStart(args: RuntimeReadStartArgs) {
        for (const entry of this.entries) {
            const fn = entry.hooks.read?.onStart
            if (!fn) continue
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }

    private dispatchReadFinish(args: RuntimeReadFinishArgs) {
        for (const entry of this.entries) {
            const fn = entry.hooks.read?.onFinish
            if (!fn) continue
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }

    private dispatchWriteStart(args: RuntimeWriteStartArgs) {
        for (const entry of this.entries) {
            const fn = entry.hooks.write?.onStart
            if (!fn) continue
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }

    private dispatchWritePatches(args: RuntimeWritePatchesArgs) {
        for (const entry of this.entries) {
            const fn = entry.hooks.write?.onPatches
            if (!fn) continue
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }

    private dispatchWriteCommitted(args: RuntimeWriteCommittedArgs) {
        for (const entry of this.entries) {
            const fn = entry.hooks.write?.onCommitted
            if (!fn) continue
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }

    private dispatchWriteFailed(args: RuntimeWriteFailedArgs) {
        for (const entry of this.entries) {
            const fn = entry.hooks.write?.onFailed
            if (!fn) continue
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }

    private dispatchStoreCreated(args: StoreCreatedArgs) {
        for (const entry of this.entries) {
            const fn = entry.hooks.store?.onCreated
            if (!fn) continue
            try {
                fn(args)
            } catch {
                // ignore
            }
        }
    }
}
