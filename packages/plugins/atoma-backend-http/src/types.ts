import type { HttpOperationClientConfig } from './operation-client'

export type HttpBackendPluginOptions = Readonly<{
    baseURL: string
    operationsPath?: HttpOperationClientConfig['operationsPath']
    headers?: HttpOperationClientConfig['headers']
    retry?: HttpOperationClientConfig['retry']
    fetchFn?: HttpOperationClientConfig['fetchFn']
    onRequest?: NonNullable<HttpOperationClientConfig['interceptors']>['onRequest']
    onResponse?: NonNullable<HttpOperationClientConfig['interceptors']>['onResponse']
    responseParser?: NonNullable<HttpOperationClientConfig['interceptors']>['responseParser']
    batch?: HttpOperationClientConfig['batch']
}>
