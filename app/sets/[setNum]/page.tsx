'use client'

import { useEffect, useState, useCallback } from 'react'
import { doc, collection, onSnapshot, writeBatch, updateDoc } from 'firebase/firestore'
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
      // Mark the set as having parts loaded (for homepage card)
      await updateDoc(doc(db, 'sets', setNum), { partsLoaded: true })
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
    return (
      <div className="space-y-4 pt-2">
        <div className="card h-32 animate-pulse bg-gray-50" />
        <div className="card h-14 animate-pulse bg-gray-50" />
      </div>
    )
  }
  if (!set) {
    return <div className="card text-center py-16 text-brand-900/50">Set not found</div>
  }

  return (
    <div className="space-y-5">
      <Link href="/" className="btn-ghost text-sm inline-flex items-center gap-1 -ml-2">
        ← Your Sets
      </Link>

      {/* Set summary card */}
      <div className="card space-y-4">
        <div className="flex gap-4 items-start">
          {/* Image */}
          <div className="w-24 h-24 flex-shrink-0 rounded-xl bg-gray-50
                          flex items-center justify-center overflow-hidden border border-gray-100">
            {set.imageUrl
              ? <img src={set.imageUrl} alt={set.name}
                     className="w-full h-full object-contain" />
              : <span className="text-4xl">🧱</span>
            }
          </div>

          {/* Title + meta */}
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-black text-brand-900 leading-tight">{set.name}</h1>
            <p className="text-sm text-brand-900/40 mt-1 font-medium">
              {set.setNum} · {set.year} · {set.totalParts.toLocaleString()} pieces
            </p>
          </div>
        </div>

        {/* Progress (shown once checklist is loaded) */}
        {checklist.length > 0 && (
          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <p className="text-sm text-brand-900/50 font-medium">
                {typesFound} of {nonSpares.length} part types found
              </p>
              <p className="text-2xl font-black text-brand-500">{pct}%</p>
            </div>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${pct}%` }} />
            </div>
          </div>
        )}
      </div>

      {/* Actions */}
      {checklist.length > 0 ? (
        <div className="flex gap-3">
          <Link href={`/sets/${setNum}/scan`}
                className="btn-primary flex-1 text-center text-base py-4">
            📷  Scan Bricks
          </Link>
          <Link href={`/sets/${setNum}/missing`}
                className="btn-secondary px-5">
            📋 Missing
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          <button
            onClick={loadParts}
            disabled={loadingParts}
            className="btn-primary w-full text-base py-4"
          >
            {loadingParts ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent
                                 rounded-full animate-spin" />
                {loadMsg || 'Loading parts…'}
              </span>
            ) : '📋  Load Parts List'}
          </button>
          <div className="card bg-lego-cream border-0 py-4 text-center space-y-1">
            <p className="text-sm font-semibold text-brand-900/60">What does this do?</p>
            <p className="text-xs text-brand-900/40">
              Downloads the full parts inventory from Rebrickable so you can scan and track pieces.
              Only needed once per set.
            </p>
          </div>
        </div>
      )}

      {/* Set complete 🎉 */}
      {checklist.length > 0 && stillNeeded.length === 0 && (
        <div className="card text-center py-12 space-y-3">
          <p className="text-6xl">🎉</p>
          <p className="text-2xl font-black text-brand-900">Set Complete!</p>
          <p className="text-sm text-brand-900/50">Every part is accounted for</p>
        </div>
      )}

      {/* Still needed preview */}
      {stillNeeded.length > 0 && (
        <div className="space-y-3">
          <div className="flex items-center justify-between">
            <p className="section-label">Still needed</p>
            <p className="text-xs font-semibold text-brand-900/40">{stillNeeded.length} types</p>
          </div>
          <div className="space-y-2">
            {stillNeeded.slice(0, 12).map(line => (
              <div key={line.lineId} className="card flex items-center gap-3 py-3">
                <div className="w-12 h-12 flex-shrink-0 rounded-lg bg-gray-50
                                flex items-center justify-center overflow-hidden border border-gray-100">
                  {line.partImgUrl
                    ? <img src={line.partImgUrl} alt={line.partNum}
                           className="w-full h-full object-contain" />
                    : <span className="text-xs text-brand-900/30">{line.partNum}</span>
                  }
                </div>
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-semibold truncate">{line.partName || line.partNum}</p>
                  <div className="flex items-center gap-1.5 mt-0.5">
                    {line.colorRgb && (
                      <span className="w-3 h-3 rounded-sm border border-gray-200 flex-shrink-0"
                            style={{ backgroundColor: `#${line.colorRgb}` }} />
                    )}
                    <span className="text-xs text-brand-900/40">{line.colorName}</span>
                  </div>
                </div>
                <span className="text-sm font-black text-brand-500 flex-shrink-0">
                  ×{line.quantityNeeded - line.quantityFound}
                </span>
              </div>
            ))}
            {stillNeeded.length > 12 && (
              <Link href={`/sets/${setNum}/missing`}
                    className="block card text-center py-4 text-brand-500 font-bold text-sm
                               hover:shadow-card-hover transition-all">
                See all {stillNeeded.length} missing parts →
              </Link>
            )}
          </div>
        </div>
      )}
    </div>
  )
}
