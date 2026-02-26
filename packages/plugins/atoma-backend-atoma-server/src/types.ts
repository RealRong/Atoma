import type { OperationClientConfig } from 'atoma-backend-http'

export type AtomaServerBackendPluginOptions = Readonly<{
    baseURL: string
    operationsPath?: OperationClientConfig['operationsPath']
    headers?: OperationClientConfig['headers']
    retry?: OperationClientConfig['retry']
    fetchFn?: OperationClientConfig['fetchFn']
    onRequest?: NonNullable<OperationClientConfig['interceptors']>['onRequest']
    onResponse?: NonNullable<OperationClientConfig['interceptors']>['onResponse']
    responseParser?: NonNullable<OperationClientConfig['interceptors']>['responseParser']
    batch?: OperationClientConfig['batch']
}>
