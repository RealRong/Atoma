import path from 'node:path'
import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'client/index': 'src/client/index.ts',
        'devtools/index': 'src/devtools/index.ts',
        'core/index': 'src/core/index.ts',
        'shared/index': 'src/shared/index.ts',
        'observability/index': 'src/observability/index.ts',
        'protocol/index': 'src/protocol/index.ts',
        'backend/index': 'src/backend/index.ts',
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
        // Avoid `alias` here: tsup/esbuild may treat aliases as prefixes, which breaks `#client/...` resolution.
        // Resolve both exact `#client` and subpaths `#client/*` (and other `#xxx`) via a small resolver.
        options.plugins = [
            ...(options.plugins ?? []),
            {
                name: 'atoma-hash-alias-subpaths',
                setup(build) {
                    const exact: Record<string, string> = {
                        '#client': path.resolve(__dirname, 'src/client/index.ts'),
                        '#core': path.resolve(__dirname, 'src/core/index.ts'),
                        '#shared': path.resolve(__dirname, 'src/shared/index.ts'),
                        '#observability': path.resolve(__dirname, 'src/observability/index.ts'),
                        '#protocol': path.resolve(__dirname, 'src/protocol/index.ts'),
                        '#backend': path.resolve(__dirname, 'src/backend/index.ts'),
                        '#devtools': path.resolve(__dirname, 'src/devtools/index.ts'),
                    }

                    const map: Record<string, string> = {
                        '#client/': path.resolve(__dirname, 'src/client/'),
                        '#core/': path.resolve(__dirname, 'src/core/'),
                        '#shared/': path.resolve(__dirname, 'src/shared/'),
                        '#observability/': path.resolve(__dirname, 'src/observability/'),
                        '#protocol/': path.resolve(__dirname, 'src/protocol/'),
                        '#backend/': path.resolve(__dirname, 'src/backend/'),
                        '#devtools/': path.resolve(__dirname, 'src/devtools/'),
                    }

                    build.onResolve({ filter: /^#(client|core|shared|observability|protocol|backend|devtools)(\/.*)?$/ }, (args) => {
                        const direct = exact[args.path]
                        if (direct) return { path: direct }

                        for (const [prefix, base] of Object.entries(map)) {
                            if (args.path.startsWith(prefix)) {
                                return { path: path.resolve(base, args.path.slice(prefix.length)) }
                            }
                        }
                        return null
                    })
                }
            }
        ]
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
