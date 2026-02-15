import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { createClientInspector } from './runtime/create-client-inspector'
import { createHub } from './runtime/hub'
import { registerBuiltinSources } from './runtime/sources'

export type DevtoolsPluginOptions = Readonly<{
    /**
     * Optional label shown in the devtools UI.
     * - Useful when multiple clients exist on the same page.
     */
    label?: string
}>

function safeDispose(dispose?: () => void): void {
    if (typeof dispose !== 'function') return
    try {
        dispose()
    } catch {
        // ignore
    }
}

export function devtoolsPlugin(options: DevtoolsPluginOptions = {}): ClientPlugin {
    return {
        id: 'atoma-devtools',
        provides: [HUB_TOKEN],
        setup: (ctx: PluginContext) => {
            const hub = createHub()
            const unregisterHub = ctx.services.register(HUB_TOKEN, hub)
            let unregisterSources: (() => void) | undefined

            try {
                unregisterSources = registerBuiltinSources({
                    ctx,
                    hub
                })
                const inspector = createClientInspector({
                    clientId: ctx.clientId,
                    hub,
                    label: options.label
                })

                return {
                    dispose: () => {
                        safeDispose(inspector.dispose)
                        safeDispose(unregisterSources)
                        safeDispose(unregisterHub)
                    }
                }
            } catch (error) {
                safeDispose(unregisterSources)
                safeDispose(unregisterHub)
                throw error
            }
        }
    }
}
