export type HeadersLike = Record<string, string> | { get?: (name: string) => string | null } | undefined
