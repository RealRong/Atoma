import type { HttpOperationClientConfig } from 'atoma-backend-http'

export type AtomaServerBackendPluginOptions = Readonly<{
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
