import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        shared: 'src/shared/index.ts',
        core: 'src/core/index.ts',
        runtime: 'src/runtime/index.ts',
        client: 'src/client/index.ts',
        'client/client': 'src/client/client.ts',
        'client/options': 'src/client/options.ts',
        'client/plugins': 'src/client/plugins/index.ts',
        'client/services': 'src/client/services.ts',
        'client/ops': 'src/client/ops.ts',
        'client/relations': 'src/client/relations.ts',
        'client/schema': 'src/client/schema.ts',
        protocol: 'src/protocol/index.ts',
        protocolTools: 'src/protocol-tools/index.ts',
        observability: 'src/observability/index.ts',
        sync: 'src/sync/index.ts',
        devtools: 'src/devtools/index.ts',
        internal: 'src/internal/index.ts'
    },
    format: ['esm'],
    dts: false,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ['immer']
})
