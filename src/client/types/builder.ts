import type { IDataSource, Entity, StoreKey } from '#core'
import type { BackendEndpointConfig, HttpBackendConfig, HttpSyncBackendConfig, IndexedDBBackendConfig, StoreBackendEndpointConfig } from './backend'
import type { AtomaClient } from './client'
import type { StoresConstraint } from './store'
import type { SyncDefaultsArgs, SyncQueueWriteMode, SyncQueueWritesArgs } from './sync'

export type StoreDefaultsArgs<
    Entities extends Record<string, Entity>
> = {
    dataSourceFactory?: <Name extends keyof Entities & string>(name: Name) => IDataSource<Entities[Name]>
    idGenerator?: () => StoreKey
}

export type StoreBatchArgs =
    | boolean
    | {
        enabled?: boolean
        maxBatchSize?: number
        flushIntervalMs?: number
        devWarnings?: boolean
    }

export type StoreBackendHttpArgs = HttpBackendConfig
export type StoreBackendServerArgs = HttpBackendConfig
export type StoreBackendIndexedDBArgs = IndexedDBBackendConfig

export type SyncTargetHttpArgs = HttpSyncBackendConfig

export type AtomaClientBuilder<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities> = {}
> = {
    store: {
        defaults: (args: StoreDefaultsArgs<Entities>) => AtomaClientBuilder<Entities, Stores>
        batch: (args: StoreBatchArgs) => AtomaClientBuilder<Entities, Stores>
        backend: {
            http: (args: StoreBackendHttpArgs) => AtomaClientBuilder<Entities, Stores>
            server: (args: StoreBackendServerArgs) => AtomaClientBuilder<Entities, Stores>
            indexedDB: (args: StoreBackendIndexedDBArgs) => AtomaClientBuilder<Entities, Stores>
            custom: (args: { role: 'local' | 'remote'; backend: StoreBackendEndpointConfig }) => AtomaClientBuilder<Entities, Stores>
        }
    }
    sync: {
        target: {
            http: (args: SyncTargetHttpArgs) => AtomaClientBuilder<Entities, Stores>
            custom: (args: BackendEndpointConfig) => AtomaClientBuilder<Entities, Stores>
        }
        queueWrites: (args: SyncQueueWritesArgs) => AtomaClientBuilder<Entities, Stores>
        defaults: (args: SyncDefaultsArgs) => AtomaClientBuilder<Entities, Stores>
    }
    build: () => AtomaClient<Entities, Stores>
}

export type StoresDefinition<
    Entities extends Record<string, Entity>,
    Stores extends StoresConstraint<Entities>
> = {
    defineClient: () => AtomaClientBuilder<Entities, Stores>
}

export type EntitiesDefinition<
    Entities extends Record<string, Entity>
> = {
    defineStores: {
        (): StoresDefinition<Entities, {}>
        <const Stores extends StoresConstraint<Entities>>(
            stores: Stores
        ): StoresDefinition<Entities, Stores>
    }
}
