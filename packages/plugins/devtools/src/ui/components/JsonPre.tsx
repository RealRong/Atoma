export function JsonPre(props: { value: unknown; maxHeight?: number }) {
    const maxHeight = typeof props.maxHeight === 'number' ? props.maxHeight : 200
    return (
        <pre
            className="mt-2 overflow-auto rounded-lg border border-slate-200 bg-white p-2 font-mono text-[11px] text-slate-900"
            style={{ maxHeight }}
        >
            {JSON.stringify(props.value, null, 2)}
        </pre>
    )
}
