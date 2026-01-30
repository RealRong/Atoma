import type { PluginContext, Register } from './types'

export abstract class ClientPlugin {
    abstract id: string

    setup(_ctx: PluginContext, _register: Register): void {}
}
