import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const SRC_DIR = resolve(__dirname, '../src')

const layerOrder = {
    interface: ['interface', 'application', 'domain', 'shared'],
    application: ['application', 'domain', 'shared'],
    domain: ['domain', 'shared'],
    infra: ['infra', 'domain', 'shared'],
    shared: ['shared']
}

function walk(dir) {
    const items = readdirSync(dir)
    const files = []

    for (const item of items) {
        const fullPath = join(dir, item)
        const stat = statSync(fullPath)
        if (stat.isDirectory()) {
            files.push(...walk(fullPath))
            continue
        }
        if (extname(fullPath) === '.ts') {
            files.push(fullPath)
        }
    }

    return files
}

function getLayer(absolutePath) {
    const rel = normalize(absolutePath).replace(`${normalize(SRC_DIR)}${sep}`, '')
    const first = rel.split(sep)[0]
    if (!first) return undefined
    return first
}

function resolveImportPath(filePath, specifier) {
    if (!specifier.startsWith('.')) return undefined

    const base = resolve(dirname(filePath), specifier)
    const candidates = [
        base,
        `${base}.ts`,
        join(base, 'index.ts')
    ]

    return candidates.find(path => {
        try {
            return statSync(path).isFile()
        } catch {
            return false
        }
    })
}

function collectImports(filePath) {
    const source = readFileSync(filePath, 'utf8')
    const regex = /from\s+['\"]([^'\"]+)['\"]/g
    const imports = []
    let matched

    while ((matched = regex.exec(source)) !== null) {
        imports.push(matched[1])
    }

    return imports
}

const files = walk(SRC_DIR)
const violations = []

for (const filePath of files) {
    const sourceLayer = getLayer(filePath)
    if (!sourceLayer || !Object.prototype.hasOwnProperty.call(layerOrder, sourceLayer)) {
        continue
    }

    const imports = collectImports(filePath)
    for (const specifier of imports) {
        const resolved = resolveImportPath(filePath, specifier)
        if (!resolved) continue

        const targetLayer = getLayer(resolved)
        if (!targetLayer || !Object.prototype.hasOwnProperty.call(layerOrder, targetLayer)) {
            continue
        }

        const allow = layerOrder[sourceLayer]
        if (!allow.includes(targetLayer)) {
            const from = filePath.replace(`${SRC_DIR}/`, '')
            const to = resolved.replace(`${SRC_DIR}/`, '')
            violations.push(`${sourceLayer} -> ${targetLayer} is forbidden: ${from} imports ${to}`)
        }
    }
}

if (violations.length) {
    console.error('Layering violations detected:')
    for (const line of violations) {
        console.error(`- ${line}`)
    }
    process.exit(1)
}

console.log('Layering check passed.')
