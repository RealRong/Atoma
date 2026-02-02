import type { DebugConfig, DebugEvent, ObservabilityContext } from 'atoma-observability'
import type { Entity, Query, StoreToken } from 'atoma-core'
import { Protocol, type OperationResult } from 'atoma-protocol'
import type { RuntimeIo, RuntimeObservability, StoreHandle } from 'atoma-runtime/types/runtimeTypes'
import { createRuntime } from 'atoma-runtime'
import type { AtomaClient, AtomaSchema, CreateClientOptions } from '#client/types'
import { registerClientRuntime } from './runtimeRegistry'
import { zod } from 'atoma-shared'
import { CreateClientSchemas } from '#client/schemas'
import { EndpointRegistry } from '../drivers/EndpointRegistry'
import { PluginRegistry } from '../plugins/PluginRegistry'
import { HandlerChain } from '../plugins/HandlerChain'
import type { HandlerEntry, IoContext, ObserveContext, ObserveHandler, ObserveRequest, PluginContext, QueryResult, ReadContext, ReadRequest } from '../plugins/types'
import { ClientPlugin } from '../plugins/ClientPlugin'
import { HttpBackendPlugin } from '../defaults/HttpBackendPlugin'
import { DefaultObservePlugin } from '../defaults/DefaultObservePlugin'
import { LocalBackendPlugin } from '../defaults/LocalBackendPlugin'

const { parseOrThrow } = zod

function toSchema<E extends Record<string, Entity>>(schema: AtomaSchema<E> | undefined): AtomaSchema<E> {
    return (schema ?? {}) as AtomaSchema<E>
}

function toPlugins(input?: ReadonlyArray<ClientPlugin>): ClientPlugin[] {
    return Array.isArray(input) ? [...input] : []
}

function createStubIo(): RuntimeIo {
    return {
        executeOps: async () => {
            throw new Error('[Atoma] io not ready')
        },
        query: async () => {
            throw new Error('[Atoma] io not ready')
        }
    }
}

function requireSingleResult(results: OperationResult[], missingMessage: string): OperationResult {
    const result = results[0]
    if (!result) throw new Error(missingMessage)
    return result
}

function toOpsError(result: OperationResult, tag: string): Error {
    if ((result as any).ok) return new Error(`[${tag}] Operation failed`)
    const message = ((result as any).error && typeof ((result as any).error as any).message === 'string')
        ? ((result as any).error as any).message
        : `[${tag}] Operation failed`
    const err = new Error(message)
    ;(err as any).error = (result as any).error
    return err
}

function toProtocolValidationError(error: unknown, fallbackMessage: string): Error {
    const standard = Protocol.error.wrap(error, {
        code: 'INVALID_RESPONSE',
        message: fallbackMessage,
        kind: 'validation'
    })
    const err = new Error(`[Atoma] ${standard.message}`)
    ;(err as any).error = standard
    return err
}

class PluginRuntimeIo implements RuntimeIo {
    private readonly ioChain: HandlerChain
    private readonly readChain: HandlerChain
    private readonly now: () => number
    private readonly clientId: string

    constructor(args: {
        io: HandlerChain
        read: HandlerChain
        now?: () => number
        clientId: string
    }) {
        this.ioChain = args.io
        this.readChain = args.read
        this.now = args.now ?? (() => Date.now())
        this.clientId = args.clientId
    }

    executeOps: RuntimeIo['executeOps'] = async (input) => {
        const context = input.context
        const traceId = (typeof context?.traceId === 'string' && context.traceId) ? context.traceId : undefined
        const opsWithTrace = Protocol.ops.build.withTraceMeta({
            ops: input.ops,
            traceId,
            ...(context ? { nextRequestId: context.requestId } : {})
        })
        const meta = Protocol.ops.build.buildRequestMeta({
            now: this.now,
            traceId,
            requestId: context ? context.requestId() : undefined
        })
        Protocol.ops.validate.assertOutgoingOps({ ops: opsWithTrace, meta })

        const res = await this.ioChain.execute({
            ops: opsWithTrace,
            meta,
            ...(input.signal ? { signal: input.signal } : {}),
            ...(context ? { context } : {})
        }, { clientId: this.clientId } as IoContext)

        try {
            return Protocol.ops.validate.assertOperationResults((res as any).results)
        } catch (error) {
            throw toProtocolValidationError(error, 'Invalid ops response')
        }
    }

    query: RuntimeIo['query'] = async <T extends Entity>(
        handle: StoreHandle<T>,
        query: Query,
        context?: ObservabilityContext,
        signal?: AbortSignal
    ): Promise<QueryResult> => {
        const req: ReadRequest = {
            storeName: handle.storeName,
            query,
            ...(context ? { context } : {}),
            ...(signal ? { signal } : {})
        }
        const ctx: ReadContext = {
            clientId: this.clientId,
            store: String(handle.storeName)
        }
        return await this.readChain.execute(req, ctx)
    }
}

class PluginRuntimeObserve implements RuntimeObservability {
    private readonly handlers: ObserveHandler[]
    private readonly clientId: string
    private readonly base?: RuntimeObservability

    constructor(args: {
        entries: HandlerEntry[]
        clientId: string
        base?: RuntimeObservability
    }) {
        this.handlers = args.entries.map(entry => entry.handler as ObserveHandler)
        this.clientId = args.clientId
        this.base = args.base
    }

    createContext: RuntimeObservability['createContext'] = (storeName, ctxArgs) => {
        const req: ObserveRequest = {
            storeName,
            ...(ctxArgs?.traceId ? { traceId: ctxArgs.traceId } : {}),
            ...(ctxArgs?.explain !== undefined ? { explain: ctxArgs.explain } : {})
        }
        const ctx: ObserveContext = { clientId: this.clientId }

        const run = (index: number): ObservabilityContext => {
            const handler = this.handlers[index]
            if (!handler) {
                throw new Error('[Atoma] ObserveChain: missing terminal handler')
            }
            return handler(req, ctx, () => run(index + 1))
        }

        return run(0)
    }

    registerStore = (args: { storeName: StoreToken; debug?: DebugConfig; debugSink?: (e: DebugEvent) => void }) => {
        this.base?.registerStore?.(args)
    }
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
    const args = parseOrThrow(CreateClientSchemas.createClientBuildArgsSchema, opt, { prefix: '[Atoma] createClient: ' }) as any

    const client: any = {}

    const endpointRegistry = new EndpointRegistry()
    const pluginRegistry = new PluginRegistry()

    const schema = toSchema(args.schema as S)
    const clientRuntime = createRuntime({
        schema: schema as any,
        io: createStubIo(),
        ownerClient: () => client
    }) as any

    const pluginContext: PluginContext = {
        clientId: clientRuntime.id,
        endpoints: endpointRegistry,
        runtime: clientRuntime as any
    }

    const plugins: ClientPlugin[] = [...toPlugins(args.plugins)]

    const backend = args.backend
    let hasBackend = false
    if (typeof backend === 'string') {
        plugins.push(new HttpBackendPlugin({ baseURL: backend }))
        hasBackend = true
    } else if (backend && typeof backend === 'object') {
        const baseURL = String((backend as any).baseURL ?? '').trim()
        if (baseURL) {
            plugins.push(new HttpBackendPlugin({ baseURL }))
            hasBackend = true
        }
    }
    if (!hasBackend) {
        plugins.push(new LocalBackendPlugin())
    }

    plugins.push(new DefaultObservePlugin())

    for (const plugin of plugins) {
        if (!plugin || typeof plugin.setup !== 'function') {
            throw new Error('[Atoma] createClient: plugin 必须提供 setup(ctx, register)')
        }
        plugin.setup(pluginContext, pluginRegistry.register)
    }

    const ioEntries = pluginRegistry.list('io')
    const persistEntries = pluginRegistry.list('persist')
    const readEntries = pluginRegistry.list('read')
    const observeEntries = pluginRegistry.list('observe')
    if (!ioEntries.length) throw new Error('[Atoma] io handler missing')
    if (!persistEntries.length) throw new Error('[Atoma] persist handler missing')
    if (!readEntries.length) throw new Error('[Atoma] read handler missing')
    if (!observeEntries.length) throw new Error('[Atoma] observe handler missing')

    const ioChain = new HandlerChain(ioEntries)
    const persistChain = new HandlerChain(persistEntries)
    const readChain = new HandlerChain(readEntries)

    const runtimeIo = new PluginRuntimeIo({
        io: ioChain,
        read: readChain,
        now: clientRuntime.now,
        clientId: clientRuntime.id
    })

    const baseObserve = clientRuntime.observe
    const runtimeObserve = new PluginRuntimeObserve({
        entries: observeEntries,
        clientId: clientRuntime.id,
        base: baseObserve
    })

    clientRuntime.io = runtimeIo
    clientRuntime.persistence.register('direct', {
        persist: async ({ req }) => {
            return await persistChain.execute(req, {
                clientId: clientRuntime.id,
                store: String(req.storeName)
            } as any)
        }
    })
    clientRuntime.observe = runtimeObserve

    const resolveStore = (<Name extends keyof E & string>(name: Name) => {
        return clientRuntime.stores.ensure(String(name)) as any
    })

    const stores = new Proxy(resolveStore as any, {
        get: (target, prop, receiver) => {
            if (prop === 'then') return undefined
            if (prop === Symbol.toStringTag) return 'AtomaStores'
            if (typeof prop !== 'string' || prop in target) {
                return Reflect.get(target, prop, receiver)
            }
            return resolveStore(prop as any)
        },
        apply: (_target, _thisArg, argArray) => {
            return resolveStore(argArray[0] as any)
        }
    }) as unknown as AtomaClient<E, S>['stores']

    client.stores = stores
    client.dispose = () => {
        for (const endpoint of endpointRegistry.list()) {
            try {
                endpoint.driver.dispose?.()
            } catch {
                // ignore
            }
        }
    }

    registerClientRuntime(client, clientRuntime)

    return client as AtomaClient<E, S>
}
