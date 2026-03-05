export function TabButtonRow(props: {
    tabs: Array<{ id: string; title: string }>
    tab?: string
    setTab: (tab: string) => void
}) {
    const { tabs, tab, setTab } = props
    return (
        <div className="mb-2 flex gap-1.5">
            {tabs.map(({ id, title }) => (
                <button
                    key={id}
                    className={
                        tab === id
                            ? 'rounded-lg border border-slate-900 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white'
                            : 'rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                    }
                    onClick={() => setTab(id)}
                >
                    {title}
                </button>
            ))}
        </div>
    )
}
