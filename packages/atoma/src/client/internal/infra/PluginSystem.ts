import type { ClientPlugin, ClientPluginContext } from '#client/types'

export class PluginSystem<TClient extends object> {
    private readonly installed = new Set<string>()
    private readonly pluginDisposers: Array<() => void> = []

    constructor(
        private readonly client: TClient,
        private readonly ctx: ClientPluginContext
    ) {}

    use = (plugin: ClientPlugin<any>) => {
        const name = String((plugin as any)?.name ?? '')
        if (!name) throw new Error('[Atoma] client.use(plugin): plugin.name 必填')
        if (this.installed.has(name)) return this.client
        this.installed.add(name)

        const res = (plugin as any).setup(this.ctx) ?? {}
        const extension = res.extension
        if (extension && typeof extension === 'object') {
            for (const [k, v] of Object.entries(extension)) {
                if (k in this.client) throw new Error(`[Atoma] client.use(${name}): extension 冲突字段 "${k}"`)
                ;(this.client as any)[k] = v
            }
        }

        if (typeof res.dispose === 'function') {
            this.pluginDisposers.push(res.dispose)
        }

        return this.client
    }

    installAll = (plugins?: ReadonlyArray<ClientPlugin<any>>) => {
        if (!plugins?.length) return
        for (const plugin of plugins) {
            this.use(plugin)
        }
    }

    dispose = () => {
        for (let i = this.pluginDisposers.length - 1; i >= 0; i--) {
            try {
                this.pluginDisposers[i]!()
            } catch {
                // ignore
            }
        }
    }
}
