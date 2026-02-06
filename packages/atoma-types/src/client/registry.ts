export type CapabilitiesRegistry = Readonly<{
    register: (key: string, value: unknown) => () => void
    get: <T = unknown>(key: string) => T | undefined
    list: (prefix?: string) => Array<{ key: string; value: unknown }>
}>
