import path from 'node:path'
import { defineConfig } from 'tsup'

export default defineConfig({
    entry: {
        index: 'src/index.ts',
        'client/index': 'src/client/index.ts',
        'core/index': 'src/core/index.ts',
        'shared/index': 'src/shared/index.ts',
        'observability/index': 'src/observability/index.ts',
        'protocol/index': 'src/protocol/index.ts',
        'backend/index': 'src/backend/index.ts',
        'internal/index': 'src/internal/index.ts'
    },
    format: ['esm'],
    dts: true,
    splitting: false,
    sourcemap: true,
    clean: true,
    treeshake: true,
    esbuildOptions(options) {
        // Avoid `alias` here: tsup/esbuild may treat aliases as prefixes, which breaks hash-import resolution.
        // Resolve exact `#backend` and subpaths `#backend/*` via a small resolver.
        options.plugins = [
            ...(options.plugins ?? []),
            {
                name: 'atoma-hash-alias-subpaths',
                setup(build) {
                    const exact: Record<string, string> = {
                        '#backend': path.resolve(__dirname, 'src/backend/index.ts'),
                    }

                    const map: Record<string, string> = {
                        '#backend/': path.resolve(__dirname, 'src/backend/'),
                    }

                    build.onResolve({ filter: /^#(backend)(\/.*)?$/ }, (args) => {
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
        'atoma-client',
        'atoma-core',
        'atoma-shared',
        'atoma-protocol',
        'atoma-observability',
        'react',
        'jotai',
        'jotai/utils',
        'jotai/vanilla',
        'jotai/vanilla/utils',
        'immer',
        'lodash'
    ]
})
