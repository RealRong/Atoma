import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        internal: 'src/internal.ts'
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: [
        'atoma-shared',
        'atoma-protocol',
        'atoma-observability',
        'jotai',
        'jotai/vanilla',
        'jotai/vanilla/utils',
        'immer'
    ]
})
