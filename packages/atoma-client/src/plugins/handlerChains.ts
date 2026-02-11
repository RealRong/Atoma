import { markTerminalResult } from './HandlerChain'
import { HandlerChain } from './HandlerChain'
import { PluginRegistry } from './PluginRegistry'

export function createHandlerChains(pluginRegistry: PluginRegistry): {
    ops: HandlerChain<'ops'>
    persist: HandlerChain<'persist'>
    read: HandlerChain<'read'>
} {
    const opsEntries = pluginRegistry.list('ops')
    const persistEntries = pluginRegistry.list('persist')
    const readEntries = pluginRegistry.list('read')

    if (!opsEntries.length) throw new Error('[Atoma] ops handler missing')
    if (!persistEntries.length) throw new Error('[Atoma] persist handler missing')
    if (!readEntries.length) throw new Error('[Atoma] read handler missing')

    return {
        ops: new HandlerChain<'ops'>(opsEntries, {
            name: 'ops',
            terminal: () => markTerminalResult({ results: [] })
        }),
        persist: new HandlerChain<'persist'>(persistEntries, {
            name: 'persist',
            terminal: () => markTerminalResult({ status: 'confirmed' as const })
        }),
        read: new HandlerChain<'read'>(readEntries, {
            name: 'read',
            terminal: () => markTerminalResult({ data: [] })
        })
    }
}
