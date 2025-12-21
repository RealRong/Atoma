export type JsonPatchOp = 'add' | 'remove' | 'replace' | 'move' | 'copy' | 'test'

export type JsonPatch = {
    op: JsonPatchOp
    path: string
    value?: unknown
    from?: string
}

