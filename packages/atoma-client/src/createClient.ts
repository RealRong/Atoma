import type { Entity } from 'atoma-types/core'
import { registerOpsClient } from 'atoma-types/client/ops'
import { createId } from 'atoma-shared'
import { assertQueryResultData, assertWriteResultData, buildQueryOp, buildWriteOp, createOpId } from 'atoma-types/protocol-tools'
import type { WriteEntry, WriteItemResult } from 'atoma-types/protocol'
import type { QueryInput, QueryOutput, Schema, WriteInput, WriteOutput } from 'atoma-types/runtime'
import { Runtime } from 'atoma-runtime'
import type {
    AtomaClient,
    AtomaSchema,
    CreateClientOptions,
} from 'atoma-types/client'
import { DEBUG_HUB_CAPABILITY } from 'atoma-types/devtools'
import { createDebugHub } from './debug/debugHub'
import { registerRuntimeDebugProviders } from './debug/registerRuntimeDebugProviders'
import { setupPlugins } from './plugins'
import { CapabilitiesRegistry } from './plugins/CapabilitiesRegistry'
import { RegistryOpsClient } from './plugins/RegistryOpsClient'
import { OpsHandlerRegistry } from './plugins/OpsHandlerRegistry'

function initDebugHub(capabilities: CapabilitiesRegistry): (() => void) | undefined {
    const existing = capabilities.get(DEBUG_HUB_CAPABILITY)
    if (existing) {
        return
    }
    return capabilities.register(DEBUG_HUB_CAPABILITY, createDebugHub())
}

type EntryGroup = {
    entries: WriteEntry[]
}

function optionsKey(options: WriteEntry['options']): string {
    if (!options || typeof options !== 'object') return ''
    return JSON.stringify(options)
}

function groupEntries(entries: ReadonlyArray<WriteEntry>): EntryGroup[] {
    const groupsByKey = new Map<string, EntryGroup>()
    const groups: EntryGroup[] = []

    for (const entry of entries) {
        const key = `${entry.action}::${optionsKey(entry.options)}`
        const existing = groupsByKey.get(key)
        if (existing) {
            existing.entries.push(entry)
            continue
        }

        const group: EntryGroup = {
            entries: [entry]
        }
        groupsByKey.set(key, group)
        groups.push(group)
    }

    return groups
}

/**
 * Creates an Atoma client instance.
 *
 * This is the unified entry point for creating a client.
 * It handles options validation, plugin assembly, and runtime wiring.
 */
export function createClient<
    const E extends Record<string, Entity>,
    const S extends AtomaSchema<E> = AtomaSchema<E>
>(opt: CreateClientOptions<E, S>): AtomaClient<E, S> {
    const input = (typeof opt === 'object' && opt !== null ? opt : {}) as {
        schema?: unknown
        plugins?: unknown
    }

    const capabilities = new CapabilitiesRegistry()
    const clientId = createId()

    const opsRegistry = new OpsHandlerRegistry()

    const runtime = new Runtime({
        id: clientId,
        schema: (input.schema ?? {}) as Schema
    })

    const context = {
        clientId: runtime.id,
        capabilities,
        runtime,
        hooks: runtime.hooks
    }

    const plugins = setupPlugins({
        context,
        rawPlugins: Array.isArray(input.plugins) ? input.plugins : [],
        opsRegistry
    })

    const opsClient = new RegistryOpsClient({
        opsRegistry,
        clientId: runtime.id
    })

    const disposers: Array<() => void> = []

    disposers.push(registerOpsClient(capabilities, opsClient))

    const unregisterDebugHub = initDebugHub(capabilities)
    if (unregisterDebugHub) {
        disposers.push(unregisterDebugHub)
    }

    const debugHub = capabilities.get(DEBUG_HUB_CAPABILITY)
    if (debugHub) {
        disposers.push(registerRuntimeDebugProviders(runtime, debugHub))
    }

    disposers.push(plugins.dispose)

    const unregisterDirectStrategy = runtime.strategy.register('direct', {
        query: async <T extends Entity>(input: QueryInput<T>): Promise<QueryOutput> => {
            const opId = createOpId('q', { now: runtime.now })
            const envelope = await opsRegistry.executeOps({
                req: {
                    ops: [buildQueryOp({
                        opId,
                        resource: input.storeName,
                        query: input.query
                    })],
                    meta: {
                        v: 1,
                        clientTimeMs: runtime.now(),
                        requestId: opId,
                        traceId: opId
                    },
                    ...(input.signal ? { signal: input.signal } : {})
                },
                ctx: {
                    clientId: runtime.id
                }
            })

            const result = envelope.results[0]
            if (!result) {
                throw new Error('[Atoma] direct.query: missing query result')
            }

            if (!result.ok) {
                throw new Error(result.error.message || '[Atoma] direct.query failed')
            }

            const parsed = assertQueryResultData(result.data)
            return {
                data: parsed.data,
                ...(parsed.pageInfo !== undefined ? { pageInfo: parsed.pageInfo } : {})
            }
        },
        write: async <T extends Entity>(input: WriteInput<T>): Promise<WriteOutput<T>> => {
            if (!input.writeEntries.length) {
                return { status: 'confirmed' }
            }

            const groups = groupEntries(input.writeEntries)
            const envelope = await opsRegistry.executeOps({
                req: {
                    ops: groups.map(group => buildWriteOp({
                        opId: createOpId('w', { now: runtime.now }),
                        write: {
                            resource: input.storeName,
                            entries: group.entries
                        }
                    })),
                    meta: {
                        v: 1,
                        clientTimeMs: input.opContext.timestamp,
                        requestId: input.opContext.actionId,
                        traceId: input.opContext.actionId
                    },
                    ...(input.signal ? { signal: input.signal } : {})
                },
                ctx: {
                    clientId: runtime.id
                }
            })

            const results: WriteItemResult[] = []
            for (let index = 0; index < groups.length; index++) {
                const group = groups[index]
                const result = envelope.results[index]
                if (!result) {
                    throw new Error('[Atoma] direct.write: missing write result')
                }

                if (!result.ok) {
                    for (const entry of group.entries) {
                        results.push({
                            entryId: entry.entryId,
                            ok: false,
                            error: result.error
                        })
                    }
                    continue
                }

                const parsed = assertWriteResultData(result.data)
                results.push(...parsed.results)
            }

            return {
                status: 'confirmed',
                ...(results.length ? { results } : {})
            }
        }
    })

    const restoreDefaultStrategy = runtime.strategy.setDefault('direct')
    disposers.push(restoreDefaultStrategy)
    disposers.push(unregisterDirectStrategy)

    let disposed = false
    const dispose = () => {
        if (disposed) return
        disposed = true

        for (let i = disposers.length - 1; i >= 0; i--) {
            try {
                disposers[i]()
            } catch {
                // ignore
            }
        }
    }

    const client: AtomaClient<E, S> = {
        stores: ((name: keyof E & string) => {
            return runtime.stores.ensure(String(name))
        }) as AtomaClient<E, S>['stores'],
        dispose
    }

    const pluginInitDisposers = plugins.init(client)
    disposers.push(...pluginInitDisposers)

    return client
}
