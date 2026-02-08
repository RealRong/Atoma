import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        store: 'src/store/index.ts',
        query: 'src/query/index.ts',
        relations: 'src/relations/index.ts',
        indexes: 'src/indexes/index.ts',
        operation: 'src/operation.ts'
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: [
        'atoma-types',
        'immer'
    ]
})
