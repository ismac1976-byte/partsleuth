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
import { matchDetections, summarize, type RawPiece } from '@/lib/matching'
import { segmentBricks, type SegmentResult } from '@/lib/segment'
import Link from 'next/link'

type ScanState = 'idle' | 'processing' | 'result' | 'error'
type InputMode = 'camera' | 'photo'

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
  const initialMode: InputMode =
    (searchParams.get('mode') as InputMode) === 'photo' ? 'photo' : 'camera'
  const [inputMode, setInputMode] = useState<InputMode>(initialMode)

  const videoRef  = useRef<HTMLVideoElement>(null)
  const fileRef   = useRef<HTMLInputElement>(null)
  const streamRef = useRef<MediaStream | null>(null)

  const [checklist,   setChecklist]   = useState<ChecklistLine[]>([])
  const [scanState,   setScanState]   = useState<ScanState>('idle')
  const [captured,    setCaptured]    = useState<Captured | null>(null)
  const [result,      setResult]      = useState<ScanResult | null>(null)
  const [errorMsg,    setErrorMsg]    = useState('')
  const [cameraReady, setCameraReady] = useState(false)
  const [cameraError, setCameraError] = useState('')
  const [elapsed,     setElapsed]     = useState(0)

  // Live checklist subscription
  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
    })
  }, [setNum])

  // Camera lifecycle
  useEffect(() => {
    if (inputMode !== 'camera') return
    let cancelled = false

    async function startCamera() {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } },
          audio: false,
        })
        if (cancelled) { stream.getTracks().forEach(t => t.stop()); return }
        streamRef.current = stream
        if (videoRef.current) {
          videoRef.current.srcObject = stream
          setCameraReady(true)
        }
      } catch {
        if (!cancelled) setCameraError("Can't access camera — please allow camera permission and reload.")
      }
    }

    startCamera()
    return () => {
      cancelled = true
      streamRef.current?.getTracks().forEach(t => t.stop())
      setCameraReady(false)
      setCameraError('')
    }
  }, [inputMode])

  // Elapsed-seconds ticker while scanning
  useEffect(() => {
    if (scanState !== 'processing') { setElapsed(0); return }
    const t0 = Date.now()
    const id = setInterval(() => setElapsed(Math.round((Date.now() - t0) / 1000)), 1000)
    return () => clearInterval(id)
  }, [scanState])

  // ── Scan logic ──

  const runScan = useCallback(async (seg: SegmentResult) => {
    setCaptured(seg.display)
    setScanState('processing')
    setResult(null)
    setErrorMsg('')

    try {
      const usingCrops = seg.pieces.length > 0
      const resp = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(usingCrops
          ? { crops: seg.pieces.map(p => p.cropB64) }   // exact boxes stay on-device
          : { image_b64: seg.display.b64 }),             // fallback: whole image
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `Server error ${resp.status}`)
      }

      const data = await resp.json()
      let pieces: RawPiece[]

      if (usingCrops) {
        // Attach our CV boxes to Claude's per-crop identifications.
        // Crops Claude skipped still get a box, shown as unknown.
        const byIndex = new Map<number, any>()
        for (const p of (data.pieces ?? [])) byIndex.set(p.i, p)
        pieces = seg.pieces.map((sp, idx) => {
          const p = byIndex.get(idx + 1)
          return {
            part_num:   p?.part_num ?? null,
            color:      p?.color ?? null,
            confidence: p?.confidence ?? 'none',
            bbox_pct:   sp.bboxPct,
          }
        })
      } else {
        pieces = (data.pieces ?? []) as RawPiece[]
      }

      const detections = matchDetections(pieces, checklist)
      const scanResult: ScanResult = { detections, summary: summarize(detections) }

      setResult(scanResult)
      setScanState('result')
      await persistFinds(setNum, detections)

    } catch (e: any) {
      setErrorMsg(e.message ?? 'Scan failed — please try again')
      setScanState('error')
    }
  }, [checklist, setNum])

  function handleCameraScan() {
    const v = videoRef.current
    if (!v || !cameraReady) return
    runScan(segmentBricks(v, v.videoWidth, v.videoHeight))
  }

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
  const showLiveCamera = inputMode === 'camera' && scanState === 'idle'

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href={`/sets/${setNum}`} className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">
          {inputMode === 'camera' ? '📹 Live Camera' : '📷 Take Photo'}
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

      {/* ── LIVE CAMERA (idle only) ── */}
      {inputMode === 'camera' && (
        <div className={showLiveCamera ? '' : 'hidden'}>
          <div className="relative rounded-2xl overflow-hidden bg-black mx-auto flex justify-center">
            {/* object-contain + no forced aspect: what you see is exactly
                the frame that gets scanned — no surprise cropping */}
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              className="block w-full object-contain"
              style={{ maxHeight: '55vh' }}
            />

            {cameraError && (
              <div className="absolute inset-0 flex items-center justify-center bg-gray-900 p-6">
                <div className="text-center space-y-3">
                  <p className="text-4xl">📷</p>
                  <p className="text-white text-base font-medium">{cameraError}</p>
                </div>
              </div>
            )}

            {/* Shutter */}
            {cameraReady && !cameraError && (
              <button
                onClick={handleCameraScan}
                aria-label="Scan"
                className="absolute bottom-5 left-1/2 -translate-x-1/2 active:scale-90 transition-transform"
                style={{ width: 76, height: 76 }}
              >
                <span className="absolute inset-0 rounded-full border-4 border-white opacity-80" />
                <span className="absolute inset-2 rounded-full bg-white" />
              </button>
            )}
          </div>
        </div>
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
              {inputMode === 'camera' ? '📹 Scan More Bricks' : '📷 Scan Another Photo'}
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

      {/* Legend — idle states */}
      {scanState === 'idle' && (
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
