import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts'
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    esbuildOptions(options) {
        options.plugins = [...(options.plugins ?? [])]
    },
    external: [
        '@atoma-js/client',
        '@atoma-js/core',
        '@atoma-js/shared',
        '@atoma-js/observability',
        'react',
        'lodash'
    ]
})
