import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'adapters/index': 'src/adapters/index.ts',
        'hooks/index': 'src/hooks/index.ts',
        'registry/index': 'src/registry/index.ts',
        'server/index': 'src/server/index.ts',
        'server/typeorm': 'src/server/typeorm/index.ts',
        'server/prisma': 'src/server/prisma/index.ts'
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    external: ['react', 'jotai', 'immer', 'dexie', 'lodash', 'typeorm', '@prisma/client']
})
