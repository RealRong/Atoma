import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'core/index': 'src/core/index.ts',
        'adapters/index': 'src/adapters/index.ts',
        'react/index': 'src/react/index.ts',
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
    external: [
        'react',
        'jotai',
        'jotai/utils',
        'jotai/vanilla',
        'jotai/vanilla/utils',
        'immer',
        'dexie',
        'lodash',
        'typeorm',
        '@prisma/client'
    ]
})
