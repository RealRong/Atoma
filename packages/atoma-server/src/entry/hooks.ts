import type { AtomaServerRoute } from '../config'
import { serializeErrorForLog } from './response'

export async function invokeOnResponseSafely(args: {
    runtime: any
    route: AtomaServerRoute
    method: string
    pathname: string
    status: number
}) {
    if (!args.runtime.hooks?.onResponse) return

    try {
        await args.runtime.hooks.onResponse({ ...args.runtime.hookArgs, status: args.status })
    } catch (err) {
        args.runtime.logger?.error?.('onResponse hook failed', {
            route: args.route,
            method: args.method,
            pathname: args.pathname,
            status: args.status,
            error: serializeErrorForLog(err)
        })
    }
}

export async function invokeOnErrorSafely(args: {
    runtime: any
    route: AtomaServerRoute
    method: string
    pathname: string
    error: unknown
}) {
    if (!args.runtime.hooks?.onError) return

    try {
        await args.runtime.hooks.onError({ ...args.runtime.hookArgs, error: args.error })
    } catch (hookErr) {
        args.runtime.logger?.error?.('onError hook failed', {
            route: args.route,
            method: args.method,
            pathname: args.pathname,
            error: serializeErrorForLog(hookErr),
            sourceError: serializeErrorForLog(args.error)
        })
    }
}
