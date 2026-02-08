import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        shared: 'src/shared/index.ts',
        core: 'src/core/index.ts',
        runtime: 'src/runtime/index.ts',
        client: 'src/client/index.ts',
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
