import type { ReactNode } from 'react'

export function Card(props: { title: string; right?: ReactNode; children: ReactNode }) {
    return (
        <div className="mb-2 rounded-xl border border-slate-200 bg-slate-50 p-2.5">
            <div className="flex items-center justify-between gap-2">
                <strong className="text-xs">{props.title}</strong>
                {props.right}
            </div>
            {props.children}
        </div>
    )
}
