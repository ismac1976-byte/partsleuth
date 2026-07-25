'use client'

import { useEffect, useState } from 'react'
import {
  collection, onSnapshot, query, orderBy,
  doc, deleteDoc, getDocs,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { PSSet } from '@/lib/types'
import Link from 'next/link'

export default function HomePage() {
  const [sets, setSets] = useState<PSSet[]>([])
  const [loading, setLoading] = useState(true)
  // setNum of the card awaiting confirm, or null
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)

  useEffect(() => {
    const q = query(collection(db, 'sets'), orderBy('addedAt', 'desc'))
    const unsub = onSnapshot(q, snap => {
      setSets(snap.docs.map(d => ({ setNum: d.id, ...d.data() } as PSSet)))
      setLoading(false)
    })
    return unsub
  }, [])

  async function handleDelete(setNum: string) {
    setDeleting(setNum)
    try {
      // Delete all checklist subcollection docs first
      const clSnap = await getDocs(collection(db, 'sets', setNum, 'checklist'))
      await Promise.all(clSnap.docs.map(d => deleteDoc(d.ref)))
      // Delete the set doc itself
      await deleteDoc(doc(db, 'sets', setNum))
    } finally {
      setDeleting(null)
      setConfirmDelete(null)
    }
  }

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

      {/* Loading splash */}
      {loading && (
        <div className="rounded-2xl overflow-hidden relative -mx-0"
             style={{ aspectRatio: '4/3', maxHeight: 340 }}>
          <img src="/splash.jpg" alt="PartSleuth"
               className="w-full h-full object-cover" />
          <div className="absolute inset-0 bg-gradient-to-t from-black/60 via-transparent to-transparent" />
          <div className="absolute bottom-0 left-0 right-0 p-5">
            <p className="text-white/60 text-xs font-semibold tracking-widest uppercase mb-1">Loading your sets…</p>
          </div>
        </div>
      )}

      {/* Empty state with hero */}
      {!loading && sets.length === 0 && (
        <div className="space-y-4">
          <div className="rounded-2xl overflow-hidden relative"
               style={{ aspectRatio: '4/3', maxHeight: 300 }}>
            <img src="/splash.jpg" alt="PartSleuth"
                 className="w-full h-full object-cover" />
            <div className="absolute inset-0 bg-gradient-to-t from-black/70 via-black/20 to-transparent" />
            <div className="absolute bottom-0 left-0 right-0 p-5 space-y-1">
              <p className="text-white font-black text-2xl tracking-tight">Start detecting</p>
              <p className="text-white/70 text-sm">Add a set, load its parts, then scan your bricks</p>
            </div>
          </div>
          <Link href="/sets/add" className="btn-primary w-full text-center py-3.5 block text-base">
            + Add your first set
          </Link>
        </div>
      )}

      {/* Active sets */}
      {active.length > 0 && (
        <div className="space-y-3">
          {active.map(set => (
            <SetCard
              key={set.setNum}
              set={set}
              confirming={confirmDelete === set.setNum}
              deleting={deleting === set.setNum}
              onRequestDelete={() => setConfirmDelete(set.setNum)}
              onCancelDelete={() => setConfirmDelete(null)}
              onConfirmDelete={() => handleDelete(set.setNum)}
            />
          ))}
        </div>
      )}

      {/* Completed sets */}
      {complete.length > 0 && (
        <div className="space-y-3">
          <p className="section-label">Complete 🎉</p>
          <div className="space-y-3 opacity-70">
            {complete.map(set => (
              <SetCard
                key={set.setNum}
                set={set}
                confirming={confirmDelete === set.setNum}
                deleting={deleting === set.setNum}
                onRequestDelete={() => setConfirmDelete(set.setNum)}
                onCancelDelete={() => setConfirmDelete(null)}
                onConfirmDelete={() => handleDelete(set.setNum)}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}

interface SetCardProps {
  set: PSSet
  confirming: boolean
  deleting: boolean
  onRequestDelete: () => void
  onCancelDelete: () => void
  onConfirmDelete: () => void
}

function SetCard({
  set, confirming, deleting,
  onRequestDelete, onCancelDelete, onConfirmDelete,
}: SetCardProps) {
  return (
    <div className="relative">
      <Link href={`/sets/${set.setNum}`} className="block">
        <div className={`card flex items-center gap-4 transition-all pr-12
                        hover:shadow-card-hover active:scale-[0.98] active:shadow-none cursor-pointer
                        ${confirming ? 'ring-2 ring-red-300' : ''}`}>

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

      {/* Delete button — absolutely positioned so it doesn't trigger the Link */}
      {!confirming && (
        <button
          onClick={e => { e.preventDefault(); onRequestDelete() }}
          className="absolute right-3 top-1/2 -translate-y-1/2
                     w-8 h-8 rounded-full flex items-center justify-center
                     text-gray-300 hover:text-red-400 hover:bg-red-50
                     transition-colors"
          aria-label="Remove set"
          title="Remove set"
        >
          <svg viewBox="0 0 20 20" fill="currentColor" className="w-4 h-4">
            <path fillRule="evenodd"
              d="M9 2a1 1 0 00-.894.553L7.382 4H4a1 1 0 000 2v10a2 2 0 002 2h8a2 2 0 002-2V6a1 1 0 100-2h-3.382l-.724-1.447A1 1 0 0011 2H9zM7 8a1 1 0 012 0v6a1 1 0 11-2 0V8zm5-1a1 1 0 00-1 1v6a1 1 0 102 0V8a1 1 0 00-1-1z"
              clipRule="evenodd" />
          </svg>
        </button>
      )}

      {/* Inline confirm strip */}
      {confirming && (
        <div className="absolute inset-x-0 bottom-0 flex items-center justify-between
                        bg-red-50 border border-red-200 rounded-b-2xl px-4 py-2">
          <p className="text-xs font-semibold text-red-700">Remove this set and all its data?</p>
          <div className="flex gap-2">
            <button
              onClick={onCancelDelete}
              className="text-xs px-3 py-1 rounded-full border border-gray-300
                         text-gray-600 hover:bg-gray-100 transition-colors"
            >
              Cancel
            </button>
            <button
              onClick={onConfirmDelete}
              disabled={deleting}
              className="text-xs px-3 py-1 rounded-full bg-red-500 text-white
                         hover:bg-red-600 transition-colors disabled:opacity-50"
            >
              {deleting ? 'Removing…' : 'Remove'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
