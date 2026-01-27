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
        'atoma',
        'atoma/client',
        'atoma/core',
        'atoma/shared',
        'atoma/observability',
        'atoma/protocol',
        'atoma/backend'
    ]
})

