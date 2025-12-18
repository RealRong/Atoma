const tabs = ['store', 'index', 'queue', 'history', 'trace'] as const

export function TabButtonRow(props: {
    tab: typeof tabs[number]
    setTab: (tab: typeof tabs[number]) => void
}) {
    const { tab, setTab } = props
    return (
        <div className="mb-2 flex gap-1.5">
            {tabs.map(key => (
                <button
                    key={key}
                    className={
                        tab === key
                            ? 'rounded-lg border border-slate-900 bg-slate-900 px-2.5 py-1 text-xs font-semibold text-white'
                            : 'rounded-lg border border-slate-200 bg-white px-2.5 py-1 text-xs text-slate-700 hover:bg-slate-50 hover:text-slate-900'
                    }
                    onClick={() => setTab(key)}
                >
                    {key}
                </button>
            ))}
        </div>
    )
}
