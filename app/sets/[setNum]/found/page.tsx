'use client'

// Found parts — everything you've ticked off, with undo.
// The red ✕ removes one (for mistaken ticks); + adds one back.

import { useEffect, useState } from 'react'
import { collection, onSnapshot, doc, updateDoc, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import type { ChecklistLine } from '@/lib/types'
import Link from 'next/link'

export default function FoundPage() {
  const { setNum } = useParams<{ setNum: string }>()

  const [checklist, setChecklist] = useState<ChecklistLine[]>([])
  const [loading, setLoading]     = useState(true)
  const [ticking, setTicking]     = useState<string | null>(null)

  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
      setLoading(false)
    })
  }, [setNum])

  const found = checklist
    .filter(l => !l.isSpare && l.quantityFound > 0)
    .sort((a, b) => (a.partName || a.partNum).localeCompare(b.partName || b.partNum))

  const totalFound = found.reduce((s, l) => s + Math.min(l.quantityFound, l.quantityNeeded), 0)

  // ✕ = undo this entry completely — removes it from the Found list
  async function clearLine(line: ChecklistLine) {
    if (ticking || line.quantityFound <= 0) return
    setTicking(line.lineId)
    try {
      await updateDoc(doc(db, 'sets', setNum, 'checklist', line.lineId), {
        quantityFound: 0,
      })
    } finally { setTicking(null) }
  }

  // − = remove just one (absolute clamped write — can never go below zero)
  async function removeOne(line: ChecklistLine) {
    if (ticking || line.quantityFound <= 0) return
    setTicking(line.lineId)
    try {
      await updateDoc(doc(db, 'sets', setNum, 'checklist', line.lineId), {
        quantityFound: Math.max(0, line.quantityFound - 1),
      })
    } finally { setTicking(null) }
  }

  async function addOne(line: ChecklistLine) {
    if (ticking) return
    setTicking(line.lineId)
    try {
      await updateDoc(doc(db, 'sets', setNum, 'checklist', line.lineId), {
        quantityFound: increment(1),
      })
    } finally { setTicking(null) }
  }

  if (loading) {
    return (
      <div className="space-y-4 pt-2">
        <div className="card h-24 animate-pulse bg-gray-50" />
        <div className="space-y-2">
          {[1,2,3].map(i => <div key={i} className="card h-16 animate-pulse bg-gray-50" />)}
        </div>
      </div>
    )
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href={`/sets/${setNum}`} className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">Found Parts</h1>
      </div>

      {/* Summary */}
      <div className="card flex items-center justify-between">
        <div>
          <p className="font-bold text-brand-900">
            {found.length} part type{found.length !== 1 ? 's' : ''} found
          </p>
          <p className="text-sm text-brand-900/40">{totalFound} pieces ticked off so far</p>
        </div>
        <span className="text-4xl">✅</span>
      </div>

      {found.length === 0 && (
        <div className="card text-center py-12 space-y-3">
          <p className="text-4xl">🔍</p>
          <p className="font-semibold text-brand-900/70">Nothing found yet</p>
          <p className="text-sm text-brand-900/40">Scan some bricks or tick parts off by hand.</p>
        </div>
      )}

      {/* Found list */}
      <div className="space-y-2">
        {found.map(line => {
          const busy     = ticking === line.lineId
          const complete = line.quantityFound >= line.quantityNeeded
          return (
            <div key={line.lineId}
                 className={`card flex items-center gap-3 py-3 ${complete ? 'border-green-200 bg-green-50' : ''}`}>
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
                <p className={`text-[11px] mt-0.5 font-medium
                               ${complete ? 'text-green-600' : 'text-brand-900/30'}`}>
                  {line.quantityFound}/{line.quantityNeeded} found{complete ? ' ✓' : ''}
                </p>
              </div>

              {busy ? (
                <span className="inline-block w-5 h-5 border-2 border-brand-500
                                 border-t-transparent rounded-full animate-spin flex-shrink-0" />
              ) : (
                <div className="flex items-center gap-2 flex-shrink-0">
                  {line.quantityFound > 1 && (
                    <button
                      onClick={() => removeOne(line)}
                      className="w-9 h-9 rounded-full border-2 border-red-200
                                 flex items-center justify-center
                                 text-red-500 text-lg font-bold leading-none
                                 hover:border-red-400 active:scale-90 transition-all"
                      title="Remove one"
                    >−</button>
                  )}
                  <button
                    onClick={() => clearLine(line)}
                    className="w-9 h-9 rounded-full bg-red-500 flex items-center justify-center
                               text-white text-base font-bold hover:bg-red-600 active:scale-90
                               transition-all shadow-sm"
                    title="Undo — remove from found"
                  >✕</button>
                  {!complete && (
                    <button
                      onClick={() => addOne(line)}
                      className="w-9 h-9 rounded-full border-2 border-gray-200
                                 flex items-center justify-center
                                 text-brand-900/50 text-lg font-bold leading-none
                                 hover:border-brand-500 hover:text-brand-500
                                 active:scale-90 transition-all"
                      title="I found another"
                    >+</button>
                  )}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
