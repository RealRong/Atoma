import { markTerminalResult } from './HandlerChain'
import { HandlerChain } from './HandlerChain'
import { PluginRegistry } from './PluginRegistry'

export function createHandlerChains(pluginRegistry: PluginRegistry): {
    io: HandlerChain<'io'>
    persist: HandlerChain<'persist'>
    read: HandlerChain<'read'>
} {
    const ioEntries = pluginRegistry.list('io')
    const persistEntries = pluginRegistry.list('persist')
    const readEntries = pluginRegistry.list('read')

    if (!ioEntries.length) throw new Error('[Atoma] io handler missing')
    if (!persistEntries.length) throw new Error('[Atoma] persist handler missing')
    if (!readEntries.length) throw new Error('[Atoma] read handler missing')

    return {
        io: new HandlerChain<'io'>(ioEntries, {
            name: 'io',
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
