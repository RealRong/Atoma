import React, { useEffect, useMemo, useRef, useState } from 'react'
import type { StoreKey, FindManyOptions } from 'atoma'
import {
    DemoStore,
    DemoTask,
    addTask,
    areas,
    boostImpact,
    cycleStatus,
    ensureSeedData,
    removeTask,
    runBurstMutation,
    subscribeHistory,
    HistoryEntry
} from './demoStore'

const defaultCode = `// 完整 React 风格示例：确保返回 options（FindManyOptions<DemoTask>）
function useDemoQuery() {
  const options = {
    where: { impact: { gte: 3 } },
    orderBy: [
      { field: 'impact', direction: 'desc' },
      { field: 'updatedAt', direction: 'desc' }
    ],
    limit: 6
  }

  return options
}

// playground 会执行本函数，返回 options 给 useFindMany
return useDemoQuery()`

const presets: Record<string, string> = {
    'Impact≥4 + 最新': `function useDemoQuery() {
  const options = {
    where: { impact: { gte: 4 } },
    orderBy: [
      { field: 'impact', direction: 'desc' },
      { field: 'updatedAt', direction: 'desc' }
    ],
    limit: 4
  }
  return options
}
return useDemoQuery()`,
    '只看 offline': `function useDemoQuery() {
  const options = {
    where: { area: 'offline' },
    orderBy: [{ field: 'updatedAt', direction: 'desc' }]
  }
  return options
}
return useDemoQuery()`,
    'active 或 synced': `function useDemoQuery() {
  const options = {
    where: { status: { in: ['active', 'synced'] } },
    orderBy: [{ field: 'title', direction: 'asc' }]
  }
  return options
}
return useDemoQuery()`,
    '全量列表': `function useDemoQuery() { return {} }\nreturn useDemoQuery()`
}

const statusLabels: Record<DemoTask['status'], string> = {
    queued: 'Queued',
    active: 'Active',
    synced: 'Synced',
    shipped: 'Shipped'
}

const useRenderCount = () => {
    const ref = useRef(0)
    ref.current += 1
    return ref.current
}

function App() {
    const all = DemoStore.useAll()
    const [codeText, setCodeText] = useState(defaultCode)
    const [queryOptions, setQueryOptions] = useState<FindManyOptions<DemoTask>>({})
    const [parseError, setParseError] = useState<string | undefined>()
    const query = DemoStore.useFindMany(queryOptions)
    const [history, setHistory] = useState<HistoryEntry[]>([])
    const [title, setTitle] = useState('Adapter-aware workload')
    const [area, setArea] = useState<DemoTask['area']>('state-core')

    useEffect(() => {
        ensureSeedData()
        const unsub = subscribeHistory(setHistory)
        return () => unsub()
    }, [])

    useEffect(() => {
        const timer = setTimeout(() => {
            try {
                const result = new Function(
                    '"use strict"; const DemoStore = arguments[0]; const FindManyOptions = arguments[1];' +
                    '\n' +
                    codeText
                )(DemoStore, null) as FindManyOptions<DemoTask>

                if (typeof result !== 'object' || result === null) {
                    throw new Error('请返回一个对象作为 options')
                }
                setQueryOptions(result)
                setParseError(undefined)
            } catch (error) {
                setParseError((error as Error).message)
            }
        }, 400)
        return () => clearTimeout(timer)
    }, [codeText])

    const reactSnippet = useMemo(() => {
        const lines = codeText.split('\n').map(line => `  ${line}`)
        return [
            "import { DemoStore } from './demoStore'",
            '',
            '// 你可以修改 useDemoQuery 返回的 options，左侧列表会实时更新',
            'function useDemoQuery() {',
            ...lines,
            '}',
            '',
            'export function DemoList() {',
            '  const query = DemoStore.useFindMany(useDemoQuery())',
            '  return (',
            '    <div>',
            '      {query.loading && <div>Loading...</div>}',
            '      {query.data.map(item => (',
            '        <div key={item.id}>{item.title}</div>',
            '      ))}',
            '    </div>',
            '  )',
            '}'
        ].join('\n')
    }, [codeText])

    const handleAdd = async () => {
        await addTask(title, area)
        setTitle('')
    }

    return (
        <div className="page">
            <header className="hero">
                <div className="eyebrow">Atoma • useFindMany Playground (IndexedDB)</div>
                <h1>左侧列表，右侧查询代码。改代码，结果即刻用 useFindMany 渲染。</h1>
                <p className="lede">
                    同一套引擎：Jotai 原子、队列→Immer patch、IndexedDB Adapter。查询用索引和 Top-K
                    过滤，渲染只订阅匹配 ID。
                </p>
                <div className="cta-row">
                    <button className="cta" onClick={handleAdd}>
                        新增一条（写入 IndexedDB）
                    </button>
                    <button onClick={() => runBurstMutation()}>批量更新 4 条（单次补丁）</button>
                    <button onClick={() => query.refetch()}>Refetch（重建索引）</button>
                </div>
                <div className="pill-row">
                    <div className="pill">缓存实体：{all.length}</div>
                    <div className="pill">匹配结果：{query.data.length}</div>
                    <div className="pill">useFindMany 状态：{query.loading ? 'loading' : 'ready'}</div>
                    <div className="pill">{query.isStale ? 'stale（有错误或离线）' : 'fresh'}</div>
                </div>
            </header>

            <section className="main-grid">
                <div className="panel">
                    <div className="panel-header">
                        <div>
                            <p className="eyebrow">实时结果（useFindMany）</p>
                            <h2>索引驱动查询 + 精准订阅</h2>
                            <p className="muted">
                                左侧列表只订阅匹配到的 ID，行内用 useValue(id)；改右侧 JSON 立即触发
                                findMany→索引→筛选→渲染。
                            </p>
                        </div>
                        <div className="toolbar">
                            <button onClick={() => runBurstMutation()}>触发补丁</button>
                            <button onClick={() => query.refetch()}>Refetch</button>
                        </div>
                    </div>

                    <form
                        className="add-form"
                        onSubmit={e => {
                            e.preventDefault()
                            handleAdd()
                        }}
                    >
                        <div className="input">
                            <label>标题</label>
                            <input
                                value={title}
                                onChange={e => setTitle(e.target.value)}
                                placeholder="例如：仅筛选 impact ≥ 4 的离线任务"
                            />
                        </div>
                        <div className="input">
                            <label>Area</label>
                            <div className="chips">
                                {areas.map(option => (
                                    <button
                                        key={option}
                                        type="button"
                                        className={option === area ? 'chip selected' : 'chip'}
                                        onClick={() => setArea(option)}
                                    >
                                        {option}
                                    </button>
                                ))}
                            </div>
                        </div>
                        <button type="submit" className="cta">
                            写入 IndexedDB
                        </button>
                    </form>

                    <div className="task-list">
                        {query.data.map(item => (
                            <TaskRow key={item.id as string} id={item.id} />
                        ))}
                        {!query.data.length && (
                            <div className="empty">当前查询无结果，修改右侧 JSON 试试。</div>
                        )}
                    </div>
                </div>

                <div className="panel code-panel">
                    <div className="panel-header">
                        <div>
                            <p className="eyebrow">右侧可编辑</p>
                            <h2>完整 React 风格代码（返回 options）</h2>
                            <p className="muted">
                                编辑代码，确保最终 return 一个 FindManyOptions 对象；playground 会执行它并将结果传给
                                useFindMany。
                            </p>
                        </div>
                        <div className="toolbar">
                            <button className="ghost" onClick={() => setCodeText(defaultCode)}>
                                重置
                            </button>
                        </div>
                    </div>

                    <div className="preset-row">
                        {Object.entries(presets).map(([label, value]) => (
                            <button key={label} onClick={() => setCodeText(value)}>
                                {label}
                            </button>
                        ))}
                    </div>

                    <textarea
                        className="code"
                        value={codeText}
                        onChange={e => setCodeText(e.target.value)}
                        spellCheck={false}
                    />
                    {parseError ? (
                        <div className="error">代码执行失败：{parseError}</div>
                    ) : (
                        <div className="ok">代码执行成功，已把 options 传给 useFindMany</div>
                    )}

                    <div className="note">
                        <strong>完整示例：</strong> 下方展示包含 useFindMany 的 React 片段（只读）。上方代码区仍可编辑并驱动左侧。
                    </div>

                    <pre className="code-preview">
                        <code>{reactSnippet}</code>
                    </pre>

                    <div className="note">
                        <strong>测试提示：</strong> 编辑完整代码（非纯 JSON）→ 左侧列表实时更新；Refetch 会从
                        IndexedDB 重拉并重建索引；批量更新会合并为一组 Immer patches。
                    </div>

                    <HistoryFeed entries={history} />
                </div>
            </section>
        </div>
    )
}

const TaskRowComponent = ({ id }: { id: StoreKey }) => {
    const task = DemoStore.useValue(id) as DemoTask | undefined
    const renders = useRenderCount()

    if (!task) return null

    return (
        <div className="task-row">
            <div className="task-meta">
                <div className="title">{task.title}</div>
                <p className="muted">{task.note}</p>
                <div className="badges">
                    <span className={`badge status-${task.status}`}>{statusLabels[task.status]}</span>
                    <span className="badge ghost">{task.area}</span>
                </div>
            </div>
            <div className="task-actions">
                <div className="impact">
                    <div className="impact-label">Impact {task.impact}/5</div>
                    <div className="impact-bar">
                        <div
                            className="impact-fill"
                            style={{ width: `${(task.impact / 5) * 100}%` }}
                        />
                    </div>
                </div>
                <div className="buttons">
                    <button onClick={() => cycleStatus(task)}>下一状态</button>
                    <button onClick={() => boostImpact(task)}>Boost</button>
                    <button className="ghost" onClick={() => removeTask(task.id)}>
                        Delete
                    </button>
                </div>
            </div>
            <div className="render-chip">renders: {renders}</div>
        </div>
    )
}

const TaskRow = React.memo(TaskRowComponent)
TaskRow.displayName = 'TaskRow'

const HistoryFeed = ({ entries }: { entries: HistoryEntry[] }) => (
    <div className="history">
        <div className="history-head">
            <div>
                <p className="eyebrow">补丁轨迹</p>
                <h3>Immer patches（IndexedDB Adapter）</h3>
            </div>
            <div className="muted">最新 {entries.length} 条</div>
        </div>
        <div className="history-list">
            {entries.map(entry => (
                <div key={entry.id} className="history-row">
                    <div className="summary">{entry.summary}</div>
                    <div className="muted">{new Date(entry.timestamp).toLocaleTimeString()}</div>
                    <div className="badge">{entry.patches} patches</div>
                </div>
            ))}
            {!entries.length && <div className="muted">触发一次新增或更新看看。</div>}
        </div>
    </div>
)

export default App
