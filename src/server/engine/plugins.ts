import type { AtomaServerConfig } from '../config'
import type { AtomaServerServices } from '../services/types'
import type { RouteHandler, RouterMiddleware } from './router'

export type ServerPluginSetupArgs<Ctx> = {
    config: AtomaServerConfig<Ctx>
    services: AtomaServerServices<Ctx>
    routing: {
        batchPath: string
        restEnabled: boolean
        syncEnabled: boolean
        syncPushPath: string
        syncPullPath: string
        syncSubscribePath: string
    }
}

export type ServerPluginSetup = {
    routes?: RouteHandler[]
    middleware?: RouterMiddleware[]
}

export type ServerPlugin<Ctx> = {
    name: string
    setup: (args: ServerPluginSetupArgs<Ctx>) => ServerPluginSetup
}

