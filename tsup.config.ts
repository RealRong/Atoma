import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'core/index': 'src/core/index.ts',
        'observability/index': 'src/observability/index.ts',
        'protocol/index': 'src/protocol/index.ts',
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
    esbuildOptions(options) {
        options.alias = {
            ...(options.alias ?? {}),
            '#observability': 'src/observability/index.ts',
            '#protocol': 'src/protocol/index.ts',
            '#batch': 'src/batch/index.ts'
        }
    },
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
