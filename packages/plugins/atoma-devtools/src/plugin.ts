import type { ClientPlugin, PluginContext } from 'atoma-types/client/plugins'
import { HUB_TOKEN } from 'atoma-types/devtools'
import { createClientInspector } from './runtime/create-client-inspector'

export type DevtoolsPluginOptions = Readonly<{
    /**
     * Optional label shown in the devtools UI.
     * - Useful when multiple clients exist on the same page.
     */
    label?: string
}>

export function devtoolsPlugin(options: DevtoolsPluginOptions = {}): ClientPlugin {
    return {
        id: 'atoma-devtools',
        setup: (ctx: PluginContext) => {
            const hub = ctx.services.resolve(HUB_TOKEN)
            if (!hub) {
                throw new Error('[Atoma Devtools] debug hub missing')
            }

            const inspector = createClientInspector({
                clientId: ctx.clientId,
                hub,
                label: options.label
            })

            return {
                dispose: () => {
                    inspector.dispose()
                }
            }
        }
    }
}
