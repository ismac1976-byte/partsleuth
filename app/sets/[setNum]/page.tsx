'use client'

import { useEffect, useState, useCallback } from 'react'
import { doc, collection, onSnapshot, writeBatch } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import type { PSSet, ChecklistLine } from '@/lib/types'
import Link from 'next/link'

// Map snake_case API response → camelCase ChecklistLine for Firestore
function apiPartToLine(p: Record<string, any>): ChecklistLine {
  return {
    lineId:         p.line_id,
    partNum:        p.part_num,
    partName:       p.part_name ?? '',
    partImgUrl:     p.part_img_url ?? '',
    bricklinkIds:   p.bricklink_ids ?? [],
    colorId:        p.color_id,
    colorName:      p.color_name,
    colorRgb:       p.color_rgb ?? '',
    quantityNeeded: p.quantity_needed,
    quantityFound:  0,
    isSpare:        p.is_spare ?? false,
    elementId:      p.element_id ?? '',
  }
}

export default function SetDetailPage() {
  const { setNum } = useParams<{ setNum: string }>()

  const [set, setSet]             = useState<PSSet | null>(null)
  const [checklist, setChecklist] = useState<ChecklistLine[]>([])
  const [isSetLoading, setSetLoad]   = useState(true)
  const [loadingParts, setLoadingParts] = useState(false)
  const [loadMsg, setLoadMsg]     = useState('')

  // Subscribe to the set document
  useEffect(() => {
    return onSnapshot(doc(db, 'sets', setNum), snap => {
      if (snap.exists()) setSet({ setNum: snap.id, ...snap.data() } as PSSet)
      setSetLoad(false)
    })
  }, [setNum])

  // Subscribe to checklist subcollection
  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
    })
  }, [setNum])

  // Fetch all parts pages from Rebrickable and batch-write to Firestore
  const loadParts = useCallback(async () => {
    setLoadingParts(true)
    try {
      let page = 1
      let loaded = 0
      let total = 0

      while (true) {
        setLoadMsg(`Fetching page ${page}…`)
        const resp = await fetch(
          `/api/rebrickable?action=parts&set_num=${setNum}&page=${page}&page_size=500`
        )
        const data = await resp.json()
        if (!data.results?.length) break
        total = data.count

        const lines: ChecklistLine[] = data.results.map(apiPartToLine)

        // Firestore batch limit is 500 — write in chunks of 400
        for (let i = 0; i < lines.length; i += 400) {
          const chunk = lines.slice(i, i + 400)
          const batch = writeBatch(db)
          for (const line of chunk) {
            batch.set(doc(db, 'sets', setNum, 'checklist', line.lineId), line)
          }
          await batch.commit()
          loaded += chunk.length
          setLoadMsg(`Saved ${loaded} of ${total} parts…`)
        }

        if (!data.next) break
        page++
      }
    } catch (e) {
      console.error('loadParts error:', e)
    } finally {
      setLoadingParts(false)
      setLoadMsg('')
    }
  }, [setNum])

  // Derived stats
  const nonSpares  = checklist.filter(l => !l.isSpare)
  const typesFound = nonSpares.filter(l => l.quantityFound >= l.quantityNeeded).length
  const pct        = nonSpares.length ? Math.round((typesFound / nonSpares.length) * 100) : 0
  const stillNeeded = nonSpares
    .filter(l => l.quantityFound < l.quantityNeeded)
    .sort((a, b) => b.quantityNeeded - a.quantityNeeded)

  if (isSetLoading) {
    return <div className="text-center py-20 text-gray-400">Loading…</div>
  }
  if (!set) {
    return <div className="text-center py-20 text-gray-500">Set not found</div>
  }

  return (
    <div className="space-y-6">
      <Link href="/" className="text-sm text-gray-400 hover:text-gray-600">← Your Sets</Link>

      {/* Set summary card */}
      <div className="card flex gap-4 items-center">
        {set.imageUrl ? (
          <img src={set.imageUrl} alt={set.name}
               className="w-24 h-24 object-contain rounded-xl bg-gray-50 flex-shrink-0" />
        ) : (
          <div className="w-24 h-24 bg-gray-50 rounded-xl flex-shrink-0
                          flex items-center justify-center text-3xl">🧱</div>
        )}
        <div className="flex-1 min-w-0">
          <h1 className="text-lg font-bold text-brand-900 leading-tight">{set.name}</h1>
          <p className="text-sm text-gray-400 mt-0.5">
            {set.setNum} · {set.year} · {set.totalParts.toLocaleString()} pieces
          </p>
          {checklist.length > 0 && (
            <div className="mt-3 space-y-1">
              <div className="flex justify-between text-sm">
                <span className="text-gray-500">{typesFound} / {nonSpares.length} types</span>
                <span className="font-bold text-brand-500">{pct}%</span>
              </div>
              <div className="h-2 bg-gray-100 rounded-full overflow-hidden">
                <div className="h-full bg-status-needed rounded-full transition-all duration-500"
                     style={{ width: `${pct}%` }} />
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Actions */}
      {checklist.length > 0 ? (
        <div className="flex gap-3">
          <Link href={`/sets/${setNum}/scan`}
                className="btn-primary flex-1 text-center text-base py-4">
            📷  Scan Bricks
          </Link>
          <Link href={`/sets/${setNum}/missing`}
                className="btn-secondary px-5 text-sm">
            Missing
          </Link>
        </div>
      ) : (
        <div className="space-y-2">
          <button
            onClick={loadParts}
            disabled={loadingParts}
            className="btn-primary w-full text-base py-4"
          >
            {loadingParts ? (loadMsg || 'Loading parts…') : '📋  Load Parts List'}
          </button>
          <p className="text-xs text-gray-400 text-center">
            Fetches the full inventory from Rebrickable — needed before scanning
          </p>
        </div>
      )}

      {/* Complete */}
      {checklist.length > 0 && stillNeeded.length === 0 && (
        <div className="card text-center py-10 space-y-2">
          <p className="text-5xl">🎉</p>
          <p className="text-xl font-bold">Set Complete!</p>
          <p className="text-sm text-gray-400">All parts accounted for</p>
        </div>
      )}

      {/* Still needed list */}
      {stillNeeded.length > 0 && (
        <div>
          <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-3">
            Still Needed — {stillNeeded.length} part types
          </h2>
          <div className="space-y-2">
            {stillNeeded.slice(0, 15).map(line => (
              <div key={line.lineId} className="card flex items-center gap-3 py-3">
                {line.partImgUrl ? (
                  <img src={line.partImgUrl} alt={line.partNum}
                       className="w-10 h-10 object-contain flex-shrink-0" />
                ) : (
                  <div className="w-10 h-10 bg-gray-100 rounded flex-shrink-0" />
                )}
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium truncate">{line.partName || line.partNum}</p>
                  <p className="text-xs text-gray-400">{line.colorName}</p>
                </div>
                <span className="text-sm font-semibold text-status-needed flex-shrink-0">
                  {line.quantityFound}/{line.quantityNeeded}
                </span>
              </div>
            ))}
            {stillNeeded.length > 15 && (
              <Link href={`/sets/${setNum}/missing`}
                    className="block text-center text-sm text-brand-500 py-2">
                See all {stillNeeded.length} missing parts →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
