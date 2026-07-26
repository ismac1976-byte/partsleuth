'use client'

// "Whose Brick Is This?" — scan any brick WITHOUT picking a set first.
// The app checks every set's checklist and shows which ones still need it,
// with one tap to credit the right set. Built for mixed family piles.

import { useEffect, useRef, useState } from 'react'
import { collection, getDocs, doc, updateDoc, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import type { PSSet, ChecklistLine } from '@/lib/types'
import { matchSingle, type BKCandidate, type SingleResult } from '@/lib/matching'
import { dominantColour, foregroundFraction, frameSignature, signatureDiff } from '@/lib/colour'
import Link from 'next/link'
import { useAuth } from '../components/PasscodeGate'

const SCAN_TICK_MS   = 650
const COOLDOWN_MS    = 2200
const STABLE_DIFF    = 8
const NEW_SCENE_DIFF = 13
const MIN_FG         = 0.05

interface SetData { set: PSSet; checklist: ChecklistLine[] }

interface SetHit {
  setNum: string
  setName: string
  imageUrl: string
  res: SingleResult
}

interface ScanOutcome {
  partNum: string | null
  displayName: string
  hits: SetHit[]
  added: string | null
  addedLineId?: string
}

export default function WhoseBrickPage() {
  const session  = useAuth()
  const userId   = session?.userId ?? ''

  const videoRef     = useRef<HTMLVideoElement>(null)
  const streamRef    = useRef<MediaStream | null>(null)
  const busyRef      = useRef(false)
  const prevSigRef   = useRef<Uint8Array | null>(null)
  const lastScanRef  = useRef<Uint8Array | null>(null)
  const cooldownRef  = useRef(0)
  const setsRef      = useRef<SetData[]>([])
  const forceScanRef = useRef<(() => void) | null>(null)

  const [loading, setLoading]         = useState(true)
  const [setCount, setSetCount]       = useState(0)
  const [cameraError, setCameraError] = useState('')
  const [identifying, setIdentifying] = useState(false)
  const [outcome, setOutcome]         = useState<ScanOutcome | null>(null)

  // Load every set + checklist for this user once
  useEffect(() => {
    if (!userId) return
    let cancelled = false
    async function load() {
      const setsSnap = await getDocs(collection(db, 'users', userId, 'sets'))
      const sets = setsSnap.docs.map(d => ({ setNum: d.id, ...d.data() } as PSSet))
      const data: SetData[] = []
      await Promise.all(sets.map(async s => {
        const cl = await getDocs(collection(db, 'users', userId, 'sets', s.setNum, 'checklist'))
        if (cl.size > 0) {
          data.push({ set: s, checklist: cl.docs.map(d => d.data() as ChecklistLine) })
        }
      }))
      if (!cancelled) {
        setsRef.current = data
        setSetCount(data.length)
        setLoading(false)
      }
    }
    load()
    return () => { cancelled = true }
  }, [userId])

  // Camera + scan loop
  useEffect(() => {
    let cancelled = false
    let timer: ReturnType<typeof setInterval> | null = null

    async function start() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) videoRef.current.srcObject = stream
        timer = setInterval(tick, SCAN_TICK_MS)
      } catch {
        if (!cancelled) setCameraError("Can't access camera — please allow camera permission and reload.")
      }
    }

    function centerCrop(): HTMLCanvasElement | null {
      const v = videoRef.current
      if (!v || !v.videoWidth) return null
      const side = 0.6 * Math.min(v.videoWidth, v.videoHeight)
      const sx = (v.videoWidth - side) / 2, sy = (v.videoHeight - side) / 2
      const c = document.createElement('canvas')
      const out = Math.min(320, side)
      c.width = out; c.height = out
      c.getContext('2d')!.drawImage(v, sx, sy, side, side, 0, 0, out, out)
      return c
    }

    async function tick(force = false) {
      if (busyRef.current || !setsRef.current.length) return
      const crop = centerCrop()
      if (!crop) return

      const sig = frameSignature(crop)
      if (!force) {
        const stable = signatureDiff(sig, prevSigRef.current) <= STABLE_DIFF
        prevSigRef.current = sig
        if (!stable) return
        if (Date.now() < cooldownRef.current) return
        if (foregroundFraction(crop) < MIN_FG) return
        if (signatureDiff(sig, lastScanRef.current) <= NEW_SCENE_DIFF) return
      }

      busyRef.current = true
      setIdentifying(true)
      lastScanRef.current = sig

      try {
        const b64  = crop.toDataURL('image/jpeg', 0.85).split(',')[1]
        const resp = await fetch('/api/scan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ crop: b64 }),
        })
        if (!resp.ok) throw new Error(`Server error ${resp.status}`)
        const data = await resp.json()
        const candidates = (data.candidates ?? []) as BKCandidate[]
        const rgb = dominantColour(crop)

        const order: Record<string, number> = { needed: 0, have_enough: 1, wrong_color: 2 }
        const hits: SetHit[] = []
        let partNum: string | null = null
        let displayName = 'Not recognised'

        for (const sd of setsRef.current) {
          const res = matchSingle(candidates, rgb, sd.checklist)
          if (res.partNum && !partNum) partNum = res.partNum
          if (res.line?.partName && displayName === 'Not recognised') {
            displayName = res.line.partName
          }
          if (res.status in order) {
            hits.push({
              setNum: sd.set.setNum, setName: sd.set.name,
              imageUrl: sd.set.imageUrl, res,
            })
          }
        }
        if (displayName === 'Not recognised' && partNum) displayName = `Part ${partNum}`

        hits.sort((a, b) =>
          (order[a.res.status] - order[b.res.status])
          || ((a.res.colourDist < 0 ? 999 : a.res.colourDist)
            - (b.res.colourDist < 0 ? 999 : b.res.colourDist)))

        setOutcome({ partNum, displayName, hits: hits.slice(0, 6), added: null })
        cooldownRef.current = Date.now() + COOLDOWN_MS
      } catch {
        // transient — keep watching
      } finally {
        busyRef.current = false
        setIdentifying(false)
      }
    }

    forceScanRef.current = () => { tick(true) }
    start()
    return () => {
      cancelled = true
      forceScanRef.current = null
      if (timer) clearInterval(timer)
      streamRef.current?.getTracks().forEach(t => t.stop())
    }
  }, [])

  async function addToSet(hit: SetHit) {
    if (!outcome || outcome.added || !hit.res.line || !userId) return
    await updateDoc(doc(db, 'users', userId, 'sets', hit.setNum, 'checklist', hit.res.line.lineId), {
      quantityFound: increment(1),
    })
    const sd = setsRef.current.find(s => s.set.setNum === hit.setNum)
    const line = sd?.checklist.find(l => l.lineId === hit.res.line!.lineId)
    if (line) line.quantityFound += 1
    setOutcome({ ...outcome, added: hit.setNum, addedLineId: hit.res.line.lineId })
  }

  async function undoAdd() {
    if (!outcome?.added || !outcome.addedLineId || !userId) return
    const sd = setsRef.current.find(s => s.set.setNum === outcome.added)
    const line = sd?.checklist.find(l => l.lineId === outcome.addedLineId)
    await updateDoc(doc(db, 'users', userId, 'sets', outcome.added, 'checklist', outcome.addedLineId), {
      quantityFound: Math.max(0, (line?.quantityFound ?? 1) - 1),
    })
    if (line) line.quantityFound = Math.max(0, line.quantityFound - 1)
    setOutcome({ ...outcome, added: null, addedLineId: undefined })
  }

  const statusChip: Record<string, { bg: string; label: string }> = {
    needed:      { bg: 'bg-green-500',  label: 'Needs it' },
    have_enough: { bg: 'bg-yellow-400', label: 'Has enough' },
    wrong_color: { bg: 'bg-orange-400', label: 'Colour differs' },
  }

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href="/" className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">🔍 Whose Brick?</h1>
      </div>

      {loading && (
        <div className="card py-6 text-center text-brand-900/50 text-sm">
          Loading your sets…
        </div>
      )}

      {!loading && setCount === 0 && (
        <div className="card text-center py-10 space-y-3">
          <p className="text-4xl">🧱</p>
          <p className="font-semibold text-brand-900/70">No sets with parts loaded yet</p>
          <p className="text-sm text-brand-900/40">
            Add a set and load its parts list, then come back to scan.
          </p>
          <Link href="/" className="btn-primary inline-block px-8 py-3">Your Sets</Link>
        </div>
      )}

      {/* Camera + reticle */}
      {!loading && setCount > 0 && (
        <>
          <div className="relative rounded-2xl overflow-hidden bg-black mx-auto flex justify-center">
            <video ref={videoRef} autoPlay playsInline muted
                   className="block w-full object-contain" style={{ maxHeight: '44vh' }} />
            {cameraError ? (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900 p-6">
                <div className="text-center space-y-3">
                  <p className="text-4xl">📷</p>
                  <p className="text-white text-base font-medium">{cameraError}</p>
                </div>
              </div>
            ) : (
              <>
                <button
                  onClick={() => forceScanRef.current?.()}
                  aria-label="Scan now"
                  className="absolute inset-0 flex items-center justify-center"
                >
                  <span className={`rounded-2xl border-4 border-dashed transition-colors block
                                    ${identifying ? 'border-lego-yellow' : 'border-white/70'}`}
                        style={{ width: '52%', aspectRatio: '1/1', maxHeight: '80%' }} />
                </button>
                <div className="absolute bottom-3 left-0 right-0 flex justify-center pointer-events-none">
                  <span className="bg-black/60 text-white text-sm font-semibold px-4 py-1.5 rounded-full
                                   flex items-center gap-2">
                    {identifying && (
                      <span className="inline-block w-3.5 h-3.5 border-2 border-lego-yellow
                                       border-t-transparent rounded-full animate-spin" />
                    )}
                    {identifying
                      ? `Checking ${setCount} set${setCount !== 1 ? 's' : ''}…`
                      : 'Hold one brick in the frame · tap to scan'}
                  </span>
                </div>
              </>
            )}
          </div>

          {/* Result */}
          {outcome && (
            <div className="space-y-2">
              <div className="flex items-center justify-between px-1">
                <p className="font-bold text-brand-900 truncate">
                  {outcome.displayName}
                  {outcome.partNum ? <span className="text-brand-900/40 font-medium"> · {outcome.partNum}</span> : null}
                </p>
              </div>

              {outcome.hits.length === 0 && (
                <div className="card py-4 text-center">
                  <p className="font-semibold text-brand-900/70">
                    {outcome.partNum ? 'No set in your collection needs this piece' : 'Could not recognise this piece'}
                  </p>
                  <p className="text-xs text-brand-900/40 mt-1">
                    {outcome.partNum ? 'It may belong to a set you haven\'t added yet.' : 'Try better light, or hold it closer.'}
                  </p>
                </div>
              )}

              {outcome.hits.map(hit => {
                const chip = statusChip[hit.res.status]
                const line = hit.res.line
                const isAdded = outcome.added === hit.setNum
                const canAdd  = hit.res.status === 'needed' && !outcome.added
                return (
                  <div key={hit.setNum}
                       className={`card flex items-center gap-3 py-3
                                   ${hit.res.status === 'needed' ? 'border-green-200 bg-green-50' : ''}`}>
                    <div className="w-12 h-12 flex-shrink-0 rounded-lg bg-gray-50 border border-gray-100
                                    flex items-center justify-center overflow-hidden">
                      {hit.imageUrl
                        ? <img src={hit.imageUrl} alt={hit.setName} className="w-full h-full object-contain" />
                        : <span className="text-xl">🧱</span>}
                    </div>
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-semibold truncate">{hit.setName}</p>
                      <div className="flex items-center gap-1.5 mt-0.5">
                        <span className={`w-2.5 h-2.5 rounded-full ${chip.bg} flex-shrink-0`} />
                        <span className="text-xs text-brand-900/50">
                          {chip.label}
                          {line ? ` · ${line.colorName} · ${Math.min(line.quantityFound, line.quantityNeeded)}/${line.quantityNeeded} found` : ''}
                        </span>
                      </div>
                    </div>
                    {isAdded ? (
                      <button onClick={undoAdd}
                              className="text-xs font-bold text-red-500 border-2 border-red-200
                                         rounded-full px-3 py-1.5 active:scale-95 transition-transform flex-shrink-0">
                        Added ✓ Undo
                      </button>
                    ) : canAdd ? (
                      <button onClick={() => addToSet(hit)}
                              className="text-xs font-bold text-white bg-green-500 hover:bg-green-600
                                         rounded-full px-4 py-2 active:scale-95 transition-transform
                                         shadow-sm flex-shrink-0">
                        + Add here
                      </button>
                    ) : null}
                  </div>
                )
              })}
            </div>
          )}

          <p className="text-xs text-brand-900/40 text-center px-4">
            Scans every brick against all {setCount} of your sets.
            Tap "+ Add here" to credit the right set.
          </p>
        </>
      )}
    </div>
  )
}
