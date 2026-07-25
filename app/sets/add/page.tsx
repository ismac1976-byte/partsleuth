'use client'

import { useState, useCallback, useRef } from 'react'
import { useRouter } from 'next/navigation'
import { doc, setDoc, serverTimestamp } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import Link from 'next/link'

interface SetResult {
  set_num: string
  name: string
  year: number
  num_parts: number
  set_img_url: string | null
}

const SEARCH_TIPS = [
  { icon: '🏰', label: 'Hogwarts Castle' },
  { icon: '🚀', label: 'Millennium Falcon' },
  { icon: '👭', label: 'Friends Café' },
  { icon: '🏙️', label: 'City Police Station' },
  { icon: '⚙️', label: 'Technic Bugatti' },
]

export default function AddSetPage() {
  const router = useRouter()
  const inputRef = useRef<HTMLInputElement>(null)
  const [query, setQuery]       = useState('')
  const [results, setResults]   = useState<SetResult[]>([])
  const [loading, setLoading]   = useState(false)
  const [adding, setAdding]     = useState<string | null>(null)
  const [error, setError]       = useState('')
  const [searched, setSearched] = useState(false)

  const search = useCallback(async (q?: string) => {
    const term = (q ?? query).trim()
    if (!term) return
    if (q) setQuery(q)
    setLoading(true)
    setError('')
    setResults([])
    setSearched(false)
    try {
      const resp = await fetch(`/api/find-set?q=${encodeURIComponent(term)}`)
      const data = await resp.json()
      setResults(data.results ?? [])
      setSearched(true)
      if (!data.results?.length) setError('No sets found — try a different search')
    } catch {
      setError('Search failed — check your connection')
    } finally {
      setLoading(false)
    }
  }, [query])

  const addSet = async (set: SetResult) => {
    setAdding(set.set_num)
    try {
      await setDoc(doc(db, 'sets', set.set_num), {
        name:       set.name,
        year:       set.year,
        totalParts: set.num_parts,
        imageUrl:   set.set_img_url ?? null,
        status:     'active',
        addedAt:    serverTimestamp(),
      })
      router.push(`/sets/${set.set_num}`)
    } catch {
      setError('Failed to add set — please try again')
      setAdding(null)
    }
  }

  return (
    <div className="space-y-6">

      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href="/" className="btn-ghost text-sm px-2 py-1">
          ← Back
        </Link>
        <h1 className="text-2xl font-black text-brand-900">Find a Set</h1>
      </div>

      {/* Search box */}
      <div className="space-y-2">
        <div className="flex gap-2">
          <input
            ref={inputRef}
            type="search"
            inputMode="search"
            value={query}
            onChange={e => setQuery(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && !loading && search()}
            placeholder="Set name or number…"
            className="input-base flex-1"
            autoFocus
            autoComplete="off"
          />
          <button
            onClick={() => search()}
            disabled={loading || !query.trim()}
            className="btn-primary px-6 flex-shrink-0"
          >
            {loading
              ? <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              : 'Search'
            }
          </button>
        </div>
        <p className="text-xs text-brand-900/40 px-1">
          Try a name, theme, or set number (e.g. 75969)
        </p>
      </div>

      {/* Quick-search chips (shown before first search) */}
      {!searched && !loading && (
        <div className="space-y-3">
          <p className="section-label">Try searching for</p>
          <div className="flex flex-wrap gap-2">
            {SEARCH_TIPS.map(tip => (
              <button
                key={tip.label}
                onClick={() => search(tip.label)}
                className="flex items-center gap-1.5 px-3 py-2 bg-white rounded-xl
                           border border-gray-200 text-sm font-medium text-brand-900/70
                           active:scale-95 transition-all shadow-sm"
              >
                <span>{tip.icon}</span>
                <span>{tip.label}</span>
              </button>
            ))}
          </div>
        </div>
      )}

      {/* Loading shimmer */}
      {loading && (
        <div className="space-y-3">
          {[1,2,3,4].map(i => (
            <div key={i} className="card h-24 animate-pulse bg-gray-50" />
          ))}
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <div className="card bg-red-50 border-red-100 py-6 text-center space-y-1">
          <p className="text-2xl">😕</p>
          <p className="font-semibold text-red-700">{error}</p>
          <p className="text-xs text-red-500">Try searching by set number, e.g. "75969"</p>
        </div>
      )}

      {/* Results */}
      {!loading && results.length > 0 && (
        <div className="space-y-3">
          <p className="section-label">
            {results.length} result{results.length !== 1 ? 's' : ''} — tap to add
          </p>
          {results.map(set => (
            <button
              key={set.set_num}
              onClick={() => addSet(set)}
              disabled={!!adding}
              className="card w-full text-left flex gap-4 items-center
                         hover:shadow-card-hover transition-all
                         active:scale-[0.98] disabled:opacity-50"
            >
              {/* Thumbnail */}
              <div className="w-20 h-20 flex-shrink-0 rounded-xl bg-gray-50
                              overflow-hidden flex items-center justify-center border border-gray-100">
                {set.set_img_url
                  ? <img src={set.set_img_url} alt={set.name}
                         className="w-full h-full object-contain" />
                  : <span className="text-3xl">🧱</span>
                }
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="font-bold text-brand-900 leading-snug line-clamp-2">
                  {set.name}
                </p>
                <p className="text-sm text-brand-900/40 mt-0.5">
                  {set.set_num} · {set.year} · {set.num_parts.toLocaleString()} pcs
                </p>
              </div>

              {/* CTA */}
              <div className="flex-shrink-0">
                {adding === set.set_num ? (
                  <span className="inline-block w-5 h-5 border-2 border-brand-500
                                   border-t-transparent rounded-full animate-spin" />
                ) : (
                  <span className="text-brand-500 font-black text-lg">+</span>
                )}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Empty state */}
      {!loading && searched && results.length === 0 && !error && (
        <div className="card text-center py-12 space-y-3">
          <p className="text-5xl">🔍</p>
          <p className="font-bold text-brand-900">Nothing found for "{query}"</p>
          <p className="text-sm text-brand-900/50">
            Try the exact set number, e.g. "75969"
          </p>
        </div>
      )}
    </div>
  )
}
