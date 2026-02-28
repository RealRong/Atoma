import type { AtomaServerConfig, AtomaServerMiddleware } from '../../config'

function isObject(value: unknown): value is Record<string, any> {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function assertFunction(value: unknown, message: string): void {
    if (value !== undefined && typeof value !== 'function') {
        throw new Error(message)
    }
}

export function pickMiddlewareHandlers<Ctx, K extends keyof AtomaServerMiddleware<Ctx>>(
    middlewares: AtomaServerMiddleware<Ctx>[],
    key: K
): Array<NonNullable<AtomaServerMiddleware<Ctx>[K]>> {
    const handlers: Array<NonNullable<AtomaServerMiddleware<Ctx>[K]>> = []
    middlewares.forEach(middleware => {
        const handler = middleware[key]
        if (typeof handler === 'function') {
            handlers.push(handler as NonNullable<AtomaServerMiddleware<Ctx>[K]>)
        }
    })
    return handlers
}

export function normalizeServerConfig<Ctx>(config: AtomaServerConfig<Ctx>): AtomaServerConfig<Ctx> {
    if (!isObject(config.adapter) || !config.adapter.orm) {
        throw new Error('AtomaServerConfig.adapter.orm is required')
    }

    const syncEnabled = config.sync?.enabled ?? true
    if (syncEnabled) {
        if (!config.adapter.sync) {
            throw new Error('AtomaServerConfig.adapter.sync is required when sync is enabled')
        }
        if (typeof (config.adapter.orm as any)?.transaction !== 'function') {
            throw new Error('AtomaServerConfig.adapter.orm.transaction is required when sync is enabled')
        }
    }

    assertFunction(config.context?.create, 'AtomaServerConfig.context.create must be a function')
    assertFunction(config.errors?.format, 'AtomaServerConfig.errors.format must be a function')
    if (config.middleware !== undefined && !Array.isArray(config.middleware)) {
        throw new Error('AtomaServerConfig.middleware must be an array')
    }
    ;(config.middleware ?? []).forEach((middleware, index) => {
        if (!isObject(middleware)) {
            throw new Error(`AtomaServerConfig.middleware[${index}] must be an object`)
        }
        assertFunction((middleware as any).onRequest, `AtomaServerConfig.middleware[${index}].onRequest must be a function`)
        assertFunction((middleware as any).onResponse, `AtomaServerConfig.middleware[${index}].onResponse must be a function`)
        assertFunction((middleware as any).onError, `AtomaServerConfig.middleware[${index}].onError must be a function`)
        assertFunction((middleware as any).onOp, `AtomaServerConfig.middleware[${index}].onOp must be a function`)
    })

    return config.sync?.enabled === undefined
        ? {
            ...config,
            sync: {
                ...(config.sync ?? {}),
                enabled: syncEnabled
            }
        }
        : config
}
