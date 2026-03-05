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
    external: [
        'react',
        '@atoma-js/atoma',
        '@atoma-js/client',
        '@atoma-js/shared',
        '@atoma-js/observability',
        '@atoma-js/types',
        '@atoma-js/types/internal',
    ]
})
