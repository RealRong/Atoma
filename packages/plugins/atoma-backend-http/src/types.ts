import type { HttpOpsClientConfig } from './ops-client'

export type HttpBackendPluginOptions = Readonly<{
    baseURL: string
    opsPath?: HttpOpsClientConfig['opsPath']
    headers?: HttpOpsClientConfig['headers']
    retry?: HttpOpsClientConfig['retry']
    fetchFn?: HttpOpsClientConfig['fetchFn']
    onRequest?: NonNullable<HttpOpsClientConfig['interceptors']>['onRequest']
    onResponse?: NonNullable<HttpOpsClientConfig['interceptors']>['onResponse']
    responseParser?: NonNullable<HttpOpsClientConfig['interceptors']>['responseParser']
    batch?: HttpOpsClientConfig['batch']
}>
