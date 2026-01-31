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
        options.plugins = [
            ...(options.plugins ?? []),
            {
                name: 'atoma-client-hash-alias-subpaths',
                setup(build) {
                    const exact: Record<string, string> = {
                        '#client': path.resolve(__dirname, 'src/index.ts'),
                    }

                    const map: Record<string, string> = {
                        '#client/': path.resolve(__dirname, 'src/'),
                    }

                    build.onResolve({ filter: /^#client(\/.*)?$/ }, (args) => {
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
        'atoma-core',
        'atoma-runtime',
        'atoma-shared',
        'atoma-protocol',
        'atoma-observability',
        'jotai',
        'jotai/utils',
        'jotai/vanilla',
        'jotai/vanilla/utils',
        'immer'
    ]
})
