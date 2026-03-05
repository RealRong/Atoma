import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'adapters/index': 'src/adapters/index.ts',
        'adapters/prisma/index': 'src/adapters/prisma/index.ts',
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: [
        '@atoma-js/atoma',
        '@atoma-js/shared',
        '@atoma-js/observability',
    ]
})
