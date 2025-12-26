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
        'server/adapters': 'src/server/adapters/index.ts',
        'server/adapters/typeorm': 'src/server/adapters/typeorm/index.ts',
        'server/adapters/prisma': 'src/server/adapters/prisma/index.ts'
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
            '#core': 'src/core/index.ts',
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
