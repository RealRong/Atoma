import type { Endpoint } from './drivers/types'

export type EndpointRegistry = Readonly<{
    register: (ep: Endpoint) => () => void
    getById: (id: string) => Endpoint | undefined
    getByRole: (role: string) => Endpoint[]
    list: () => Endpoint[]
}>

export type CapabilitiesRegistry = Readonly<{
    register: (key: string, value: unknown) => () => void
    get: <T = unknown>(key: string) => T | undefined
    list: (prefix?: string) => Array<{ key: string; value: unknown }>
}>
