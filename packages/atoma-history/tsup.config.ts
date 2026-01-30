import path from 'node:path'
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
    esbuildOptions(options) {
        // Keep `#history/*` internal alias working during bundling.
        options.plugins = [
            ...(options.plugins ?? []),
            {
                name: 'atoma-history-hash-alias-subpaths',
                setup(build) {
                    const exact: Record<string, string> = {
                        '#history': path.resolve(__dirname, 'src/index.ts'),
                    }

                    const map: Record<string, string> = {
                        '#history/': path.resolve(__dirname, 'src/'),
                    }

                    build.onResolve({ filter: /^#history(\/.*)?$/ }, (args) => {
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
        'atoma',
        'atoma-client',
        'atoma-core',
        'atoma-shared',
        'atoma-observability',
        'atoma-protocol',
        'atoma/backend',
    ]
})
