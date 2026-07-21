'use client'

import { useState, useCallback } from 'react'
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

export default function AddSetPage() {
  const router = useRouter()
  const [query, setQuery]     = useState('')
  const [results, setResults] = useState<SetResult[]>([])
  const [loading, setLoading] = useState(false)
  const [adding, setAdding]   = useState<string | null>(null)
  const [error, setError]     = useState('')
  const [searched, setSearched] = useState(false)

  const search = useCallback(async () => {
    if (!query.trim()) return
    setLoading(true)
    setError('')
    setResults([])
    setSearched(false)
    try {
      const resp = await fetch(`/api/find-set?q=${encodeURIComponent(query.trim())}`)
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
      <div className="flex items-center gap-3">
        <Link href="/" className="text-gray-400 hover:text-gray-600 text-sm">← Back</Link>
        <h1 className="text-2xl font-bold text-brand-900">Find a Set</h1>
      </div>

      {/* Search bar */}
      <div className="flex gap-2">
        <input
          type="text"
          value={query}
          onChange={e => setQuery(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && !loading && search()}
          placeholder="e.g. Hogwarts Castle, Millennium Falcon…"
          className="flex-1 rounded-2xl border border-gray-200 bg-white px-4 py-3 text-base
                     placeholder:text-gray-300 focus:outline-none focus:border-brand-500
                     focus:ring-1 focus:ring-brand-500"
          autoFocus
        />
        <button
          onClick={search}
          disabled={loading || !query.trim()}
          className="btn-primary px-5 text-sm"
        >
          {loading ? '…' : 'Search'}
        </button>
      </div>

      {/* Loading state */}
      {loading && (
        <div className="text-center py-10 text-gray-400">
          <p className="text-4xl mb-2">🔍</p>
          <p>Searching…</p>
        </div>
      )}

      {/* Error */}
      {error && !loading && (
        <p className="text-red-500 text-sm text-center">{error}</p>
      )}

      {/* Results */}
      {!loading && results.length > 0 && (
        <div className="space-y-3">
          <p className="text-xs text-gray-400 uppercase tracking-wide font-semibold">
            {results.length} results — tap one to add it
          </p>
          {results.map(set => (
            <button
              key={set.set_num}
              onClick={() => addSet(set)}
              disabled={!!adding}
              className="card w-full text-left flex gap-4 items-center
                         hover:border-brand-500 hover:shadow-md transition-all
                         active:scale-[0.99] disabled:opacity-60"
            >
              {/* Thumbnail */}
              <div className="w-20 h-20 flex-shrink-0 rounded-xl bg-gray-50 overflow-hidden flex items-center justify-center">
                {set.set_img_url
                  ? <img src={set.set_img_url} alt={set.name} className="w-full h-full object-contain" />
                  : <span className="text-3xl">🧱</span>
                }
              </div>

              {/* Info */}
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-gray-900 leading-snug">{set.name}</p>
                <p className="text-sm text-gray-400 mt-0.5">
                  {set.set_num} · {set.year} · {set.num_parts.toLocaleString()} pieces
                </p>
              </div>

              {/* CTA */}
              <div className="flex-shrink-0 text-brand-500 font-semibold text-sm">
                {adding === set.set_num ? 'Adding…' : 'Add →'}
              </div>
            </button>
          ))}
        </div>
      )}

      {/* Empty state after search */}
      {!loading && searched && results.length === 0 && !error && (
        <div className="card text-center py-10 space-y-2">
          <p className="text-3xl">😕</p>
          <p className="font-semibold">Nothing found for "{query}"</p>
          <p className="text-sm text-gray-400">Try the set number, e.g. "75969"</p>
        </div>
      )}
    </div>
  )
}
