export const DEVTOOLS_REGISTRY_KEY = 'devtools.registry'
export const DEVTOOLS_META_KEY = 'devtools.meta'

export type DevtoolsRegistry = Readonly<{
    get: (key: string) => any
    register: (key: string, value: any) => () => void
    subscribe: (fn: (e: { type: 'register' | 'unregister'; key: string }) => void) => () => void
}>

export type DevtoolsMeta = Readonly<{
    storeBackend: {
        role: 'local' | 'remote'
        kind: 'http' | 'indexeddb' | 'memory' | 'localServer' | 'custom'
    }
}>
