import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        core: 'src/core/index.ts',
        runtime: 'src/runtime/index.ts',
        client: 'src/client/index.ts',
        protocol: 'src/protocol/index.ts',
        observability: 'src/observability/index.ts',
        sync: 'src/sync/index.ts',
        devtools: 'src/devtools/index.ts',
        internal: 'src/internal/index.ts'
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ['immer', 'jotai']
})
