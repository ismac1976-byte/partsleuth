'use client'

import { useEffect, useState } from 'react'
import { collection, onSnapshot, doc, updateDoc, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import type { ChecklistLine } from '@/lib/types'
import Link from 'next/link'

type SortMode = 'quantity' | 'name' | 'color'

export default function MissingPage() {
  const { setNum } = useParams<{ setNum: string }>()

  const [checklist, setChecklist] = useState<ChecklistLine[]>([])
  const [loading, setLoading]     = useState(true)
  const [sort, setSort]           = useState<SortMode>('quantity')
  const [ticking, setTicking]     = useState<string | null>(null)

  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
      setLoading(false)
    })
  }, [setNum])

  const nonSpares  = checklist.filter(l => !l.isSpare)
  const missing    = nonSpares.filter(l => l.quantityFound < l.quantityNeeded)
  const foundCount = nonSpares.filter(l => l.quantityFound >= l.quantityNeeded).length
  const pct        = nonSpares.length ? Math.round((foundCount / nonSpares.length) * 100) : 0

  const sorted = [...missing].sort((a, b) => {
    if (sort === 'quantity') return (b.quantityNeeded - b.quantityFound) - (a.quantityNeeded - a.quantityFound)
    if (sort === 'name')     return (a.partName || a.partNum).localeCompare(b.partName || b.partNum)
    if (sort === 'color')    return a.colorName.localeCompare(b.colorName)
    return 0
  })

  // Add 1 to quantityFound
  async function addOne(lineId: string) {
    if (ticking) return
    setTicking(lineId)
    try {
      await updateDoc(doc(db, 'sets', setNum, 'checklist', lineId), {
        quantityFound: increment(1),
      })
    } finally {
      setTicking(null)
    }
  }

  // Mark all remaining as found
  async function markAllFound(line: ChecklistLine) {
    if (ticking) return
    const still = line.quantityNeeded - line.quantityFound
    if (still <= 0) return
    setTicking(line.lineId)
    try {
      await updateDoc(doc(db, 'sets', setNum, 'checklist', line.lineId), {
        quantityFound: increment(still),
      })
    } finally {
      setTicking(null)
    }
  }

  if (loading) {
    return (
      <div className="space-y-4 pt-2">
        <div className="card h-24 animate-pulse bg-gray-50" />
        <div className="space-y-2">
          {[1,2,3,4].map(i => <div key={i} className="card h-16 animate-pulse bg-gray-50" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href={`/sets/${setNum}`} className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">Missing Parts</h1>
      </div>

      {/* Progress summary card */}
      <div className="card space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-bold text-brand-900">{foundCount} of {nonSpares.length} types found</p>
            <p className="text-sm text-brand-900/40">
              {missing.length === 0 ? 'All done!' : `${missing.length} type${missing.length !== 1 ? 's' : ''} still missing`}
            </p>
          </div>
          <p className="text-4xl font-black text-brand-500">{pct}%</p>
        </div>
        <div className="progress-track">
          <div className="progress-fill" style={{ width: `${pct}%` }} />
        </div>
      </div>

      {/* All complete */}
      {missing.length === 0 && (
        <div className="card text-center py-14 space-y-4">
          <p className="text-6xl">🎉</p>
          <div>
            <p className="text-2xl font-black text-brand-900">Set Complete!</p>
            <p className="text-sm text-brand-900/50 mt-1">Every part is accounted for</p>
          </div>
          <Link href={`/sets/${setNum}`} className="btn-primary inline-block px-10 mt-2">
            Done
          </Link>
        </div>
      )}

      {/* Sort + scan actions */}
      {missing.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-3">
            {/* Sort pills */}
            <div className="flex gap-1 bg-white rounded-2xl p-1 border border-gray-100 shadow-sm">
              {(['quantity', 'name', 'color'] as SortMode[]).map(s => (
                <button
                  key={s}
                  onClick={() => setSort(s)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold transition-all capitalize
                    ${sort === s
                      ? 'bg-brand-500 text-white shadow-sm'
                      : 'text-brand-900/40 hover:text-brand-900/70'
                    }`}
                >
                  {s}
                </button>
              ))}
            </div>

            <Link href={`/sets/${setNum}/scan`}
                  className="btn-primary text-sm px-4 py-2.5 flex items-center gap-1.5">
              📷 Scan
            </Link>
          </div>

          {/* Missing list */}
          <div className="space-y-2">
            {sorted.map(line => {
              const still = line.quantityNeeded - line.quantityFound
              const busy  = ticking === line.lineId
              return (
                <div
                  key={line.lineId}
                  className="card flex items-center gap-3 py-3"
                >
                  {/* Part image */}
                  <div className="w-12 h-12 flex-shrink-0 rounded-lg bg-gray-50
                                  flex items-center justify-center overflow-hidden border border-gray-100">
                    {line.partImgUrl
                      ? <img src={line.partImgUrl} alt={line.partNum}
                             className="w-full h-full object-contain" />
                      : <span className="text-[10px] text-brand-900/30 text-center px-1 leading-tight">
                          {line.partNum}
                        </span>
                    }
                  </div>

                  {/* Part info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-semibold leading-tight truncate">
                      {line.partName || line.partNum}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {line.colorRgb && (
                        <span className="w-3 h-3 rounded-sm border border-gray-200 flex-shrink-0"
                              style={{ backgroundColor: `#${line.colorRgb}` }} />
                      )}
                      <span className="text-xs text-brand-900/40 truncate">{line.colorName}</span>
                    </div>
                    <p className="text-[11px] text-brand-900/30 mt-0.5 font-medium">
                      {line.quantityFound}/{line.quantityNeeded} found
                    </p>
                  </div>

                  {/* Action buttons */}
                  {busy ? (
                    <span className="inline-block w-5 h-5 border-2 border-brand-500
                                     border-t-transparent rounded-full animate-spin flex-shrink-0" />
                  ) : (
                    <div className="flex items-center gap-2 flex-shrink-0">
                      {/* +1 button — add one at a time */}
                      <button
                        onClick={() => addOne(line.lineId)}
                        className="w-9 h-9 rounded-full border-2 border-gray-200
                                   flex items-center justify-center
                                   text-brand-900/50 text-lg font-bold leading-none
                                   hover:border-brand-500 hover:text-brand-500
                                   active:scale-90 transition-all"
                        title="I found one"
                      >
                        +
                      </button>
                      {/* Mark all found */}
                      <button
                        onClick={() => markAllFound(line)}
                        className="w-9 h-9 rounded-full bg-green-500
                                   flex items-center justify-center
                                   text-white text-base font-bold
                                   hover:bg-green-600 active:scale-90 transition-all shadow-sm"
                        title={`I have all ${still}`}
                      >
                        ✓
                      </button>
                    </div>
                  )}
                </div>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
