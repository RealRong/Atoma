import type { ClientRuntime } from './runtime'

export type AtomaClientContext<
    Entities extends Record<string, any>,
    Schema extends Record<string, any> = Record<string, any>
> = ClientRuntime
