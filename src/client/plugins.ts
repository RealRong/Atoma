import type { AtomaClient } from './types'
import type { ClientRuntime } from './runtime'

export type ClientPlugin = Readonly<{
    name: string
    setup: (runtime: ClientRuntime) => Readonly<{
        client: Partial<AtomaClient<any, any>>
        dispose?: () => void
    }>
}>

export function applyClientPlugins(
    runtime: ClientRuntime,
    plugins: readonly ClientPlugin[]
): Readonly<{
    client: Partial<AtomaClient<any, any>>
    dispose: () => void
}> {
    const out: Partial<AtomaClient<any, any>> = {}
    const disposers: Array<() => void> = []

    for (const plugin of plugins) {
        const res = plugin.setup(runtime)
        const fragment = res.client || {}

        for (const key of Object.keys(fragment) as Array<keyof typeof fragment>) {
            if ((out as any)[key] !== undefined) {
                throw new Error(`[Atoma] plugin 冲突：key "${String(key)}" 已存在（plugin="${plugin.name}"）`)
            }
            ;(out as any)[key] = (fragment as any)[key]
        }

        if (res.dispose) disposers.push(res.dispose)
    }

    return {
        client: out,
        dispose: () => {
            for (const d of disposers) {
                try {
                    d()
                } catch {
                    // ignore
                }
            }
        }
    }
}

