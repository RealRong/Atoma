export function normalizePath(path: string) {
    return path.endsWith('/') && path !== '/' ? path.slice(0, -1) : path
}

export function stripBasePath(url: string, basePath: string): string | undefined {
    const u = new URL(url, 'http://localhost')
    const pathname = u.pathname
    const base = normalizePath(basePath)
    if (!base || base === '/') return u.pathname + u.search
    if (!pathname.startsWith(base)) return undefined
    const rest = pathname.slice(base.length) || '/'
    return (rest.startsWith('/') ? rest : `/${rest}`) + u.search
}

