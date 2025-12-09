import type { Entity, IAdapter } from './types'

export type GlobalAdapterFactory = <T extends Entity>(name: string) => IAdapter<T>

let defaultAdapterFactory: GlobalAdapterFactory | null = null

export const setDefaultAdapterFactory = (factory: GlobalAdapterFactory): void => {
    defaultAdapterFactory = factory
}

export const getDefaultAdapterFactory = (): GlobalAdapterFactory | null => defaultAdapterFactory

export const clearDefaultAdapterFactory = (): void => {
    defaultAdapterFactory = null
}
