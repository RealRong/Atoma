import type { OperationClientConfig } from './client'

export type BackendPluginOptions = Readonly<{
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
