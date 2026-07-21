'use client'

import { useEffect, useState } from 'react'
import { collection, onSnapshot, query, orderBy } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { PSSet } from '@/lib/types'
import Link from 'next/link'

export default function HomePage() {
  const [sets, setSets] = useState<PSSet[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    const q = query(collection(db, 'sets'), orderBy('addedAt', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setSets(snap.docs.map(d => ({ setNum: d.id, ...d.data() } as PSSet)))
      setLoading(false)
    })
    return unsub
  }, [])

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-brand-900">Your Sets</h1>
        <Link href="/sets/add" className="btn-primary text-sm py-2 px-4">
          + Add Set
        </Link>
      </div>

      {loading && (
        <p className="text-gray-400 text-center py-12">Loading…</p>
      )}

      {!loading && sets.length === 0 && (
        <div className="card text-center py-12 space-y-3">
          <p className="text-4xl">🧱</p>
          <p className="font-semibold text-gray-700">No sets yet</p>
          <p className="text-sm text-gray-400">Add a set to get started</p>
          <Link href="/sets/add" className="btn-primary inline-block mt-2">
            Add your first set
          </Link>
        </div>
      )}

      <div className="space-y-3">
        {sets.filter(s => s.status === 'active').map(set => (
          <SetCard key={set.setNum} set={set} />
        ))}
      </div>

      {sets.some(s => s.status === 'complete') && (
        <div>
          <h2 className="text-sm font-semibold text-gray-400 uppercase tracking-wide mb-2">
            Complete
          </h2>
          <div className="space-y-3 opacity-60">
            {sets.filter(s => s.status === 'complete').map(set => (
              <SetCard key={set.setNum} set={set} />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

function SetCard({ set }: { set: PSSet }) {
  // TODO: derive from checklist subscription in Session 3
  const pct = 0

  return (
    <Link href={`/sets/${set.setNum}`}>
      <div className="card flex items-center gap-4 active:bg-gray-50">
        {set.imageUrl && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={set.imageUrl} alt={set.name}
               className="w-16 h-16 object-contain rounded-xl bg-gray-50 flex-shrink-0" />
        )}
        <div className="flex-1 min-w-0">
          <p className="font-semibold truncate">{set.name}</p>
          <p className="text-xs text-gray-400">{set.setNum} · {set.year} · {set.totalParts} parts</p>
          <div className="mt-2 h-1.5 bg-gray-100 rounded-full overflow-hidden">
            <div className="h-full bg-status-needed rounded-full transition-all"
                 style={{ width: `${pct}%` }} />
          </div>
        </div>
        <div className="text-right flex-shrink-0">
          <p className="text-lg font-bold text-brand-500">{pct}%</p>
          <p className="text-xs text-gray-400">found</p>
        </div>
      </div>
    </Link>
  )
}
