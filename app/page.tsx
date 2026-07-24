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

  const active   = sets.filter(s => s.status !== 'complete')
  const complete = sets.filter(s => s.status === 'complete')

  return (
    <div className="space-y-6">

      {/* Page header */}
      <div className="flex items-center justify-between pt-1">
        <div>
          <h1 className="text-2xl font-black text-brand-900">Your Sets</h1>
          {!loading && sets.length > 0 && (
            <p className="text-sm text-brand-900/40 mt-0.5">
              {sets.length} set{sets.length !== 1 ? 's' : ''} in collection
            </p>
          )}
        </div>
        <Link href="/sets/add"
              className="btn-primary text-sm py-2.5 px-5 flex items-center gap-1.5">
          <span className="text-base leading-none">+</span> Add Set
        </Link>
      </div>

      {/* Loading shimmer */}
      {loading && (
        <div className="space-y-3">
          {[1,2,3].map(i => (
            <div key={i} className="card h-24 animate-pulse bg-gray-50" />
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && sets.length === 0 && (
        <div className="card text-center py-16 space-y-4">
          <p className="text-6xl">🧱</p>
          <div>
            <p className="text-xl font-black text-brand-900">No sets yet</p>
            <p className="text-sm text-brand-900/50 mt-1">
              Search for a LEGO set to get started
            </p>
          </div>
          <Link href="/sets/add" className="btn-primary inline-flex items-center gap-2 mt-2 px-8">
            Find your first set →
          </Link>
        </div>
      )}

      {/* Active sets */}
      {active.length > 0 && (
        <div className="space-y-3">
          {active.map(set => <SetCard key={set.setNum} set={set} />)}
        </div>
      )}

      {/* Completed sets */}
      {complete.length > 0 && (
        <div className="space-y-3">
          <p className="section-label">Complete 🎉</p>
          <div className="space-y-3 opacity-70">
            {complete.map(set => <SetCard key={set.setNum} set={set} />)}
          </div>
        </div>
      )}
    </div>
  )
}

function SetCard({ set }: { set: PSSet }) {
  return (
    <Link href={`/sets/${set.setNum}`} className="block">
      <div className="card flex items-center gap-4 transition-all
                      hover:shadow-card-hover active:scale-[0.98] active:shadow-none cursor-pointer">

        {/* Set image */}
        <div className="w-20 h-20 flex-shrink-0 rounded-xl bg-gray-50
                        flex items-center justify-center overflow-hidden border border-gray-100">
          {set.imageUrl
            ? <img src={set.imageUrl} alt={set.name}
                   className="w-full h-full object-contain" />
            : <span className="text-3xl">🧱</span>
          }
        </div>

        {/* Info */}
        <div className="flex-1 min-w-0">
          <p className="font-bold text-brand-900 leading-snug line-clamp-2">{set.name}</p>
          <p className="text-xs text-brand-900/40 mt-0.5 font-medium">
            {set.setNum} · {set.year} · {set.totalParts.toLocaleString()} pieces
          </p>
          {/* Status badge */}
          <span className={`inline-block mt-1.5 text-[10px] font-bold uppercase tracking-wide
                            px-2 py-0.5 rounded-full
            ${set.status === 'complete'
              ? 'bg-green-100 text-green-700'
              : 'bg-lego-cream text-brand-900/50 border border-gray-200'
            }`}>
            {set.status === 'complete' ? '✓ Complete' : 'In progress'}
          </span>
        </div>

        {/* Arrow */}
        <span className="text-brand-900/20 text-xl flex-shrink-0">›</span>
      </div>
    </Link>
  )
}
