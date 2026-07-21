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

  // Mark all remaining quantity as found
  const markFound = async (line: ChecklistLine) => {
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
    return <div className="text-center py-20 text-gray-400">Loading…</div>
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link href={`/sets/${setNum}`} className="text-sm text-gray-400">← Back</Link>
        <h1 className="text-xl font-bold text-brand-900">Missing Parts</h1>
      </div>

      {/* Progress summary */}
      <div className="card space-y-2">
        <div className="flex items-center justify-between">
          <div>
            <p className="font-semibold">{foundCount} of {nonSpares.length} part types found</p>
            <p className="text-sm text-gray-400">{missing.length} type{missing.length !== 1 ? 's' : ''} still missing</p>
          </div>
          <p className="text-4xl font-bold text-brand-500">{pct}%</p>
        </div>
        <div className="h-2.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-status-needed rounded-full transition-all duration-700"
            style={{ width: `${pct}%` }}
          />
        </div>
      </div>

      {/* All complete */}
      {missing.length === 0 && (
        <div className="card text-center py-14 space-y-3">
          <p className="text-6xl">🎉</p>
          <p className="text-2xl font-bold">Set Complete!</p>
          <p className="text-sm text-gray-400">Every part is accounted for</p>
          <Link href={`/sets/${setNum}`} className="btn-primary inline-block px-8 mt-2">
            Done
          </Link>
        </div>
      )}

      {/* Sort + scan actions */}
      {missing.length > 0 && (
        <>
          <div className="flex items-center justify-between gap-3">
            {/* Sort tabs */}
            <div className="flex gap-1 bg-gray-100 rounded-xl p-1">
              {(['quantity', 'name', 'color'] as SortMode[]).map(s => (
                <button
                  key={s}
                  onClick={() => setSort(s)}
                  className={`px-3 py-1 rounded-lg text-xs font-medium transition-colors capitalize
                    ${sort === s
                      ? 'bg-white text-brand-900 shadow-sm'
                      : 'text-gray-400 hover:text-gray-600'
                    }`}
                >
                  {s}
                </button>
              ))}
            </div>

            <Link href={`/sets/${setNum}/scan`} className="btn-primary text-sm px-4 py-2">
              📷 Scan
            </Link>
          </div>

          <p className="text-xs text-gray-400">
            Tap a row to mark it as found manually
          </p>

          {/* Missing list */}
          <div className="space-y-2">
            {sorted.map(line => {
              const still = line.quantityNeeded - line.quantityFound
              return (
                <button
                  key={line.lineId}
                  onClick={() => markFound(line)}
                  disabled={ticking === line.lineId}
                  className="card w-full text-left flex items-center gap-3 py-3
                             active:scale-[0.99] transition-all
                             hover:border-brand-300 hover:shadow-sm
                             disabled:opacity-50"
                >
                  {/* Part image */}
                  <div className="w-12 h-12 flex-shrink-0 rounded-lg bg-gray-50
                                  flex items-center justify-center overflow-hidden">
                    {line.partImgUrl ? (
                      <img src={line.partImgUrl} alt={line.partNum}
                           className="w-full h-full object-contain" />
                    ) : (
                      <span className="text-xs text-gray-400 text-center px-1 leading-tight">
                        {line.partNum}
                      </span>
                    )}
                  </div>

                  {/* Part info */}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm font-medium leading-tight truncate">
                      {line.partName || line.partNum}
                    </p>
                    <div className="flex items-center gap-1.5 mt-0.5">
                      {line.colorRgb && (
                        <span
                          className="w-3 h-3 rounded-sm border border-gray-200 flex-shrink-0"
                          style={{ backgroundColor: `#${line.colorRgb}` }}
                        />
                      )}
                      <span className="text-xs text-gray-400 truncate">{line.colorName}</span>
                    </div>
                  </div>

                  {/* Count */}
                  <div className="text-right flex-shrink-0">
                    {ticking === line.lineId ? (
                      <span className="text-xs text-gray-400">Saving…</span>
                    ) : (
                      <>
                        <p className="text-sm font-bold text-red-500">
                          need {still}
                        </p>
                        <p className="text-xs text-gray-400">
                          {line.quantityFound}/{line.quantityNeeded}
                        </p>
                      </>
                    )}
                  </div>
                </button>
              )
            })}
          </div>
        </>
      )}
    </div>
  )
}
