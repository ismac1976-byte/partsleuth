'use client'

/**
 * Scan page — v4
 *
 * Architecture (see api/scan.py header for the full rationale):
 *  - The phone downscales the image to ≤800px BEFORE upload (~80 KB, not MBs)
 *  - /api/scan is a thin Claude proxy returning raw pieces only
 *  - Checklist matching happens here (lib/matching.ts) — no checklist upload
 *  - Bounding boxes are drawn as %-positioned overlays on the exact image
 *    Claude analysed → always aligned, never cropped
 */

import { useEffect, useState, useRef, useCallback } from 'react'
import { collection, onSnapshot, doc, updateDoc, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams, useSearchParams } from 'next/navigation'
import type { ChecklistLine, ScanResult, Detection, DetectionStatus } from '@/lib/types'
import {
  matchDetections, summarize, buildCatalog, matchSingle,
  type RawPiece, type BKCandidate, type SingleResult,
} from '@/lib/matching'
import { segmentBricks, type SegmentResult } from '@/lib/segment'
import { dominantColour, foregroundFraction, frameSignature, signatureDiff } from '@/lib/colour'
import Link from 'next/link'

type ScanState = 'idle' | 'processing' | 'result' | 'error'
type InputMode = 'single' | 'photo'

// ── Status display config ────────────────────────────────────────────────────

const STATUS_CONFIG: Record<DetectionStatus, {
  dot: string; card: string; label: string; box: string
}> = {
  needed:      { dot: 'bg-green-500',  card: 'border-green-200 bg-green-50',   label: 'Needed',       box: '#22c55e' },
  have_enough: { dot: 'bg-yellow-400', card: 'border-yellow-200 bg-yellow-50', label: 'Have enough',  box: '#eab308' },
  wrong_color: { dot: 'bg-orange-400', card: 'border-orange-200 bg-orange-50', label: 'Wrong colour', box: '#fb923c' },
  not_in_set:  { dot: 'bg-gray-300',   card: 'border-gray-200',                label: 'Not in set',   box: '#9ca3af' },
  unknown:     { dot: 'bg-red-500',    card: 'border-red-200 bg-red-50',       label: 'Unknown',      box: '#ef4444' },
}

const CONFIDENCE_BADGE: Record<string, string> = {
  high: '', medium: '~', low: '?', none: '??',
}

// ── Client-side detection + downscaling (lib/segment.ts) ────────────────────

interface Captured { dataUrl: string; b64: string }

function segmentFile(file: File): Promise<SegmentResult> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try { resolve(segmentBricks(img, img.naturalWidth, img.naturalHeight)) }
      catch (e) { reject(e) }
      finally { URL.revokeObjectURL(url) }
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Could not read that photo')) }
    img.src = url
  })
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ScanPage() {
  const { setNum }   = useParams<{ setNum: string }>()
  const searchParams = useSearchParams()
  const modeParam    = searchParams.get('mode')
  const initialMode: InputMode = modeParam === 'photo' ? 'photo' : 'single'
  const [inputMode] = useState<InputMode>(initialMode)

  const fileRef = useRef<HTMLInputElement>(null)

  const [checklist, setChecklist] = useState<ChecklistLine[]>([])
  const [scanState, setScanState] = useState<ScanState>('idle')
  const [captured,  setCaptured]  = useState<Captured | null>(null)
  const [result,    setResult]    = useState<ScanResult | null>(null)
  const [errorMsg,  setErrorMsg]  = useState('')
  const [elapsed,   setElapsed]   = useState(0)

  // Live checklist subscription
  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
    })
  }, [setNum])

  // Elapsed-seconds ticker while scanning
  useEffect(() => {
    if (scanState !== 'processing') { setElapsed(0); return }
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [scanState])

  // ── Scan logic ──

  // FREE pile identification: Brickognize part numbers + pixel colour vs
  // checklist RGB. Zero token cost. Validated 20/20 part & colour on fresh
  // sets before rollout. Quantity-aware across duplicate pieces in one scan.
  function buildFreeDetections(
    seg: SegmentResult,
    candidatesByIndex: Map<number, BKCandidate[]>,
  ): Detection[] {
    const counted = new Map<string, number>()
    return seg.pieces.map((sp, idx) => {
      const cands = candidatesByIndex.get(idx + 1) ?? []
      const res   = matchSingle(cands, sp.rgb, checklist)
      let status  = res.status
      if (status === 'needed' && res.line) {
        const extra = counted.get(res.line.lineId) ?? 0
        if (res.line.quantityFound + extra >= res.line.quantityNeeded) {
          status = 'have_enough'
        } else {
          counted.set(res.line.lineId, extra + 1)
        }
      }
      const confidence =
        res.score >= 0.4 ? 'high' : res.score >= 0.2 ? 'medium'
        : res.partNum ? 'low' : 'none'
      return {
        partNum: res.partNum,
        color:   res.line?.colorName ?? null,
        name:    res.line?.partName ?? null,
        confidence,
        bboxPct: sp.bboxPct,
        status,
        checklistMatches: res.line ? [{
          lineId:         res.line.lineId,
          colorName:      res.line.colorName,
          quantityNeeded: res.line.quantityNeeded,
          quantityFound:  res.line.quantityFound,
        }] : [],
      } as Detection
    })
  }

  const runScan = useCallback(async (seg: SegmentResult) => {
    setCaptured(seg.display)
    setScanState('processing')
    setResult(null)
    setErrorMsg('')

    async function post(body: object) {
      const resp = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify(body),
      })
      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `Server error ${resp.status}`)
      }
      return resp.json()
    }

    try {
      let detections: Detection[]

      if (seg.pieces.length > 0) {
        try {
          // Primary: FREE recogniser for every crop (no tokens, no limit)
          const data = await post({ crops_free: seg.pieces.map(p => p.cropB64) })
          const byIndex = new Map<number, BKCandidate[]>()
          for (const r of (data.results ?? [])) byIndex.set(r.i, r.candidates ?? [])
          const anyHit = Array.from(byIndex.values()).some(c => c.length > 0)
          if (!anyHit) throw new Error('recogniser returned nothing')
          detections = buildFreeDetections(seg, byIndex)
        } catch {
          // Automatic fallback: Claude path (rate-limited, costs ~0.5p)
          const data = await post({
            crops:   seg.pieces.map(p => p.cropB64),
            catalog: buildCatalog(checklist),
          })
          const byIndex = new Map<number, any>()
          for (const p of (data.pieces ?? [])) byIndex.set(p.i, p)
          const pieces: RawPiece[] = seg.pieces.map((sp, idx) => {
            const p = byIndex.get(idx + 1)
            return {
              part_num:   p?.part_num ?? null,
              color:      p?.color ?? null,
              confidence: p?.confidence ?? 'none',
              bbox_pct:   sp.bboxPct,
            }
          })
          detections = matchDetections(pieces, checklist)
        }
      } else {
        // No pieces detected on-device: whole-image Claude fallback
        const data = await post({ image_b64: seg.display.b64 })
        detections = matchDetections((data.pieces ?? []) as RawPiece[], checklist)
      }

      const scanResult: ScanResult = { detections, summary: summarize(detections) }
      setResult(scanResult)
      setScanState('result')
      await persistFinds(setNum, detections)

    } catch (e: any) {
      setErrorMsg(e.message ?? 'Scan failed — please try again')
      setScanState('error')
    }
  }, [checklist, setNum])

  async function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    try {
      const seg = await segmentFile(file)
      runScan(seg)               // auto-scan immediately
    } catch (err: any) {
      setErrorMsg(err.message ?? 'Could not read that photo')
      setScanState('error')
    }
  }

  function scanAgain() {
    setScanState('idle')
    setResult(null)
    setCaptured(null)
    setErrorMsg('')
    if (fileRef.current) fileRef.current.value = ''
  }

  // ── Render ──

  const isProcessing = scanState === 'processing'

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href={`/sets/${setNum}`} className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">
          {inputMode === 'single' ? '🧱 Single Brick' : '📷 Brick Pile'}
        </h1>
      </div>

      {/* Checklist-missing warning */}
      {checklist.length === 0 && (
        <div className="bg-lego-yellow/90 rounded-xl px-4 py-3">
          <p className="text-sm font-semibold text-brand-900 text-center">
            ⚠️ Load the parts list first —{' '}
            <Link href={`/sets/${setNum}`} className="underline">go back</Link>
          </p>
        </div>
      )}

      {/* Hidden file input (photo mode) */}
      <input
        ref={fileRef}
        type="file"
        accept="image/*"
        capture="environment"
        onChange={handleFileChange}
        className="hidden"
      />

      {/* ── SINGLE BRICK live scanner ── */}
      {inputMode === 'single' && (
        <SingleScanner checklist={checklist} setNum={setNum} />
      )}

      {/* ── PHOTO PICKER (photo mode, nothing captured yet) ── */}
      {inputMode === 'photo' && !captured && scanState === 'idle' && (
        <button
          onClick={() => fileRef.current?.click()}
          className="w-full rounded-2xl bg-brand-900 text-white
                     flex flex-col items-center justify-center gap-3 py-10
                     active:scale-[0.98] transition-transform shadow-md"
        >
          <span className="text-5xl">📷</span>
          <div className="text-center">
            <p className="font-black text-lg">Take a Photo</p>
            <p className="text-sm text-white/60 mt-0.5">Spread bricks on a plain surface, then tap</p>
          </div>
        </button>
      )}

      {/* ── CAPTURED IMAGE + OVERLAY (both modes: processing & result) ── */}
      {captured && (scanState === 'processing' || scanState === 'result') && (
        <div className="space-y-3">
          <div className="flex justify-center">
            {/* inline-block wrapper shrink-wraps the image, so the % boxes
                always line up with the picture — nothing is ever cropped */}
            <div className="relative inline-block rounded-2xl overflow-hidden shadow-md">
              <img
                src={captured.dataUrl}
                alt="Your bricks"
                className="block max-w-full"
                style={{ maxHeight: '55vh' }}
              />

              {/* Bounding boxes */}
              {scanState === 'result' && result?.detections.map((d, i) => (
                <BoundingBox key={i} detection={d} index={i} />
              ))}

              {/* Processing scrim */}
              {isProcessing && (
                <div className="absolute inset-0 bg-black/60 flex flex-col items-center justify-center gap-4 px-6">
                  <div className="w-16 h-16 border-4 border-lego-yellow border-t-transparent
                                  rounded-full animate-spin" />
                  <div className="text-center">
                    <p className="text-white font-black text-xl leading-tight">
                      Identifying bricks…
                    </p>
                    <p className="text-white/70 text-base mt-1">
                      {elapsed > 0 ? `${elapsed}s — ` : ''}usually 10–15 seconds
                    </p>
                  </div>
                </div>
              )}
            </div>
          </div>

          {scanState === 'result' && (
            <button onClick={scanAgain} className="btn-primary w-full py-4 text-base">
              📷 Scan Another Photo
            </button>
          )}
        </div>
      )}

      {/* ── Error ── */}
      {scanState === 'error' && errorMsg && (
        <div className="card border-red-200 bg-red-50 text-center py-5 space-y-3">
          <p className="font-semibold text-red-700 text-base">{errorMsg}</p>
          <button onClick={scanAgain} className="btn-primary px-8 py-3 text-base">Try Again</button>
        </div>
      )}

      {/* ── Result summary ── */}
      {scanState === 'result' && result && (
        <div className="space-y-4">

          <div className="grid grid-cols-5 gap-1.5">
            <StatCard count={result.summary.needed}     label="Needed"   dotClass="bg-green-500"  />
            <StatCard count={result.summary.haveEnough} label="Enough"   dotClass="bg-yellow-400" />
            <StatCard count={result.summary.wrongColor} label="Colour"   dotClass="bg-orange-400" />
            <StatCard count={result.summary.notInSet}   label="Not set"  dotClass="bg-gray-300"   />
            <StatCard count={result.summary.unknown}    label="Unknown"  dotClass="bg-red-500"    />
          </div>

          {result.summary.unknown > 0 && (
            <div className="card border-red-200 bg-red-50 py-3 text-center">
              <p className="text-sm font-semibold text-red-700">
                🔴 {result.summary.unknown} piece{result.summary.unknown !== 1 ? 's' : ''} couldn&apos;t be identified.
              </p>
              <p className="text-xs text-red-500 mt-0.5">Try a clearer photo or better lighting.</p>
            </div>
          )}
          {result.summary.wrongColor > 0 && (
            <div className="card border-orange-200 bg-orange-50 py-3 text-center">
              <p className="text-sm font-semibold text-orange-700">
                🟠 {result.summary.wrongColor} piece{result.summary.wrongColor !== 1 ? 's' : ''} — right shape, wrong colour.
              </p>
            </div>
          )}

          <Link href={`/sets/${setNum}/missing`}
                className="btn-primary w-full text-center text-base py-4 block">
            View Missing →
          </Link>

          {result.detections.length > 0 && (
            <div>
              <h2 className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2">
                All detected pieces ({result.detections.length})
              </h2>
              <div className="space-y-2">
                {result.detections.map((d, i) => {
                  const cfg   = STATUS_CONFIG[d.status]
                  const badge = CONFIDENCE_BADGE[d.confidence] ?? '??'
                  const displayName = d.name
                    || (d.status === 'unknown' ? 'Could not identify' : d.partNum || '—')
                  return (
                    <div key={i} className={`card flex items-center gap-3 py-3 ${cfg.card}`}>
                      <span className="w-6 h-6 rounded-md flex-shrink-0 flex items-center justify-center
                                       text-[11px] font-bold text-white"
                            style={{ backgroundColor: cfg.box }}>
                        {i + 1}
                      </span>
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-semibold truncate">
                          {badge && <span className="text-xs font-bold text-gray-400 mr-1">{badge}</span>}
                          {displayName}
                        </p>
                        <p className="text-xs text-gray-400">
                          {d.partNum ? `Part ${d.partNum}` : 'Unknown part'}
                          {d.color ? ` · ${d.color}` : ''}
                          {d.checklistMatches[0]?.colorName &&
                           d.checklistMatches[0].colorName !== d.color
                            ? ` (set needs: ${d.checklistMatches[0].colorName})` : ''}
                        </p>
                      </div>
                      <span className="text-xs font-medium text-gray-400 flex-shrink-0">
                        {cfg.label}
                      </span>
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {result.detections.length === 0 && (
            <div className="card text-center py-8 space-y-2">
              <p className="text-3xl">🔍</p>
              <p className="font-semibold text-brand-900/70 text-base">No pieces detected</p>
              <p className="text-sm text-brand-900/40">
                Spread bricks further apart on a plain, well-lit surface.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Legend — photo mode idle */}
      {inputMode === 'photo' && scanState === 'idle' && (
        <div className="card py-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2 text-center">
            What the colours mean
          </p>
          <div className="flex flex-wrap gap-x-3 gap-y-1.5 justify-center">
            {(Object.entries(STATUS_CONFIG) as [DetectionStatus, typeof STATUS_CONFIG[DetectionStatus]][])
              .map(([status, cfg]) => (
                <span key={status} className="flex items-center gap-1.5 text-xs text-brand-900/60">
                  <span className={`w-3 h-3 rounded-sm ${cfg.dot} flex-shrink-0`} />
                  {cfg.label}
                </span>
              ))}
          </div>
        </div>
      )}
    </div>
  )
}

// ── Single Brick live scanner ────────────────────────────────────────────────
//
// Barcode-gun workflow: hold ONE brick in the reticle → identified in ~1s.
// Brickognize does the part number (no Claude → fast); colour comes from
// the pixels, matched against the checklist's exact RGB values (95% accurate
// in validation). Motion-gated: scans when the scene changes then stabilises.

const SCAN_TICK_MS   = 650
const COOLDOWN_MS    = 2200
const STABLE_DIFF    = 8     // ≤ this vs previous frame = hand is steady
const NEW_SCENE_DIFF = 13    // > this vs last scanned frame = new brick
const MIN_FG         = 0.05  // minimum foreground fraction to bother scanning

interface SingleShown {
  res: SingleResult
  displayName: string
  colourName: string | null
  ticked: boolean
  lineId?: string
}

function SingleScanner({ checklist, setNum }: { checklist: ChecklistLine[]; setNum: string }) {
  const videoRef     = useRef<HTMLVideoElement>(null)
  const streamRef    = useRef<MediaStream | null>(null)
  const busyRef      = useRef(false)
  const prevSigRef   = useRef<Uint8Array | null>(null)
  const lastScanRef  = useRef<Uint8Array | null>(null)
  const cooldownRef  = useRef(0)
  const checklistRef = useRef(checklist)
  checklistRef.current = checklist

  const [cameraError, setCameraError] = useState('')
  const [identifying, setIdentifying] = useState(false)
  const [shown, setShown]             = useState<SingleShown | null>(null)
  const [session, setSession]         = useState({ needed: 0, enough: 0, wrong: 0, other: 0 })
  const forceScanRef = useRef<(() => void) | null>(null)

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
      if (busyRef.current) return
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
        const res = matchSingle(candidates, rgb, checklistRef.current)

        let ticked = false
        if (res.status === 'needed' && res.line) {
          ticked = true
          await updateDoc(doc(db, 'sets', setNum, 'checklist', res.line.lineId), {
            quantityFound: increment(1),
          })
        }

        const displayName = res.line?.partName
          || (res.partNum ? `Part ${res.partNum}` : 'Not recognised')
        setShown({
          res, displayName, ticked,
          colourName: res.line?.colorName ?? null,
          lineId: res.line?.lineId,
        })
        setSession(s => ({
          needed: s.needed + (res.status === 'needed' ? 1 : 0),
          enough: s.enough + (res.status === 'have_enough' ? 1 : 0),
          wrong:  s.wrong  + (res.status === 'wrong_color' ? 1 : 0),
          other:  s.other  + (['not_in_set', 'unknown'].includes(res.status) ? 1 : 0),
        }))
        cooldownRef.current = Date.now() + COOLDOWN_MS
      } catch {
        // transient network issue — just keep watching
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
  }, [setNum])

  async function undoTick() {
    if (!shown?.ticked || !shown.lineId) return
    const line = checklistRef.current.find(l => l.lineId === shown.lineId)
    await updateDoc(doc(db, 'sets', setNum, 'checklist', shown.lineId), {
      quantityFound: Math.max(0, (line?.quantityFound ?? 1) - 1),
    })
    setShown({ ...shown, ticked: false })
    setSession(s => ({ ...s, needed: Math.max(0, s.needed - 1) }))
  }

  const cfg = shown ? STATUS_CONFIG[shown.res.status] : null

  return (
    <div className="space-y-3">
      {/* Camera + reticle */}
      <div className="relative rounded-2xl overflow-hidden bg-black mx-auto flex justify-center">
        <video ref={videoRef} autoPlay playsInline muted
               className="block w-full object-contain" style={{ maxHeight: '48vh' }} />

        {cameraError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900 p-6">
            <div className="text-center space-y-3">
              <p className="text-4xl">📷</p>
              <p className="text-white text-base font-medium">{cameraError}</p>
            </div>
          </div>
        ) : (
          <>
            {/* Reticle — mirrors the exact region that gets scanned.
                Tap = scan right now (manual override of the motion gating). */}
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
                {identifying ? 'Identifying…' : 'Hold one brick in the frame · tap to scan'}
              </span>
            </div>
          </>
        )}
      </div>

      {/* Latest result */}
      {shown && cfg && (
        <div className={`card ${cfg.card} py-4`}>
          <div className="flex items-center gap-3">
            <span className="w-4 h-4 rounded-full flex-shrink-0"
                  style={{ backgroundColor: cfg.box }} />
            <div className="flex-1 min-w-0">
              <p className="font-bold text-base leading-tight">
                {cfg.label}{shown.ticked ? ' — added ✓' : ''}
              </p>
              <p className="text-sm text-brand-900/60 mt-0.5 truncate">
                {shown.displayName}
                {shown.colourName ? ` · ${shown.colourName}` : ''}
                {shown.res.partNum ? ` · ${shown.res.partNum}` : ''}
              </p>
              {shown.res.line && (
                <p className="text-xs text-brand-900/40 mt-0.5">
                  {Math.min(shown.res.line.quantityFound + (shown.ticked ? 1 : 0),
                            shown.res.line.quantityNeeded)}/{shown.res.line.quantityNeeded} found
                </p>
              )}
            </div>
            {shown.ticked && (
              <button onClick={undoTick}
                      className="text-xs font-bold text-red-500 border-2 border-red-200
                                 rounded-full px-3 py-1.5 active:scale-95 transition-transform">
                Undo
              </button>
            )}
          </div>
        </div>
      )}

      {/* Session tally */}
      <div className="grid grid-cols-4 gap-1.5">
        <StatCard count={session.needed} label="Needed"    dotClass="bg-green-500"  />
        <StatCard count={session.enough} label="Enough"    dotClass="bg-yellow-400" />
        <StatCard count={session.wrong}  label="Colour"    dotClass="bg-orange-400" />
        <StatCard count={session.other}  label="Other"     dotClass="bg-gray-300"   />
      </div>

      <p className="text-xs text-brand-900/40 text-center px-4">
        Hold each brick steady inside the frame — it identifies automatically,
        ticks off needed parts, then waits for the next brick.
      </p>
    </div>
  )
}

// ── Sub-components ───────────────────────────────────────────────────────────

/** %-positioned bounding box — aligned with the image by construction. */
function BoundingBox({ detection: d, index }: { detection: Detection; index: number }) {
  const [x1, y1, x2, y2] = d.bboxPct
  const w = x2 - x1, h = y2 - y1
  if (w <= 0 || h <= 0) return null
  const color = STATUS_CONFIG[d.status].box
  return (
    <div
      className="absolute rounded-sm pointer-events-none"
      style={{
        left:   `${x1 * 100}%`,
        top:    `${y1 * 100}%`,
        width:  `${w * 100}%`,
        height: `${h * 100}%`,
        border: `2.5px solid ${color}`,
        boxShadow: '0 0 0 1px rgba(0,0,0,0.25)',
      }}
    >
      <span
        className="absolute -top-0.5 -left-0.5 -translate-y-full text-[11px] font-bold
                   text-white px-1.5 py-0.5 rounded-t-sm leading-tight whitespace-nowrap"
        style={{ backgroundColor: color }}
      >
        {index + 1}{d.partNum ? ` · ${d.partNum}` : ''}
      </span>
    </div>
  )
}

function StatCard({
  count, label, dotClass
}: { count: number; label: string; dotClass: string }) {
  return (
    <div className="card text-center py-2.5 px-1">
      <div className="flex items-center justify-center gap-1 mb-0.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <p className="text-xl font-bold text-brand-900">{count}</p>
      </div>
      <p className="text-xs text-gray-400 leading-tight">{label}</p>
    </div>
  )
}

// ── Firestore persistence ────────────────────────────────────────────────────

async function persistFinds(setNum: string, detections: Detection[]) {
  const counts: Record<string, number> = {}
  for (const det of detections) {
    // Only auto-tick confident identifications — low-confidence guesses
    // stay visible in the results but never corrupt the checklist.
    if (det.confidence === 'low' || det.confidence === 'none') continue
    if (det.status === 'needed' && det.checklistMatches.length > 0) {
      const lineId = det.checklistMatches[0].lineId
      counts[lineId] = (counts[lineId] ?? 0) + 1
    }
  }
  if (!Object.keys(counts).length) return

  await Promise.all(
    Object.entries(counts).map(([lineId, count]) =>
      updateDoc(doc(db, 'sets', setNum, 'checklist', lineId), {
        quantityFound: increment(count),
      })
    )
  )
}
