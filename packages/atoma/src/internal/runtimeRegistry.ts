import type { AtomaClient } from '#client/types'

const runtimeByClient = new WeakMap<object, unknown>()

export function registerClientRuntime(client: AtomaClient<any, any>, runtime: unknown) {
    runtimeByClient.set(client, runtime)
}

export function getClientRuntime(client: AtomaClient<any, any>): unknown | undefined {
    return runtimeByClient.get(client)
}

export function requireClientRuntime(client: AtomaClient<any, any>, tag: string): unknown {
    const runtime = getClientRuntime(client)
    if (!runtime) {
        throw new Error(`[Atoma] ${tag}: 未找到 client runtime（请使用 createClient() 创建的 client）`)
    }
    return runtime
}
