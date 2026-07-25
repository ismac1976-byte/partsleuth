'use client'

import { useEffect, useState, useRef, useCallback } from 'react'
import { collection, onSnapshot, doc, updateDoc, increment } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { useParams } from 'next/navigation'
import type { ChecklistLine, ScanResult, Detection, DetectionStatus } from '@/lib/types'
import Link from 'next/link'

type ScanState = 'idle' | 'processing' | 'result' | 'error'
type InputMode = 'camera' | 'photo'

// ── API format helpers ───────────────────────────────────────────────────────

function lineToApiFormat(l: ChecklistLine) {
  return {
    line_id:         l.lineId,
    part_num:        l.partNum,
    bricklink_ids:   l.bricklinkIds,
    color_id:        l.colorId,
    color_name:      l.colorName,
    quantity_needed: l.quantityNeeded,
    quantity_found:  l.quantityFound,
  }
}

function mapDetection(d: Record<string, any>): Detection {
  return {
    partNum:    d.part_num    ) ?? null,
    color:      d.color       ?? null,
    name:       d.name        ?? null,
    confidence: d.confidence  ?? 'none',
    bboxPct:    d.bbox_pct    ?? [0, 0, 1, 1],
    status:     d.status      ?? 'unknown',
    checklistMatches: (d.checklist_matches ?? []).map((m: any) => ({
      lineId:         m.line_id,
      colorName:      m.color_name,
      quantityNeeded: m.quantity_needed,
      quantityFound:  m.quantity_found,
    })),
  }
}

// ── Status config ────────────────────────────────────────────────────────────

const STATUS_CONFIG: Record<DetectionStatus, {
  dot: string; card: string; label: string
}> = {
  needed:      { dot: 'bg-green-500',  card: 'border-green-200 bg-green-50',   label: 'Needed'       },
  have_enough: { dot: 'bg-yellow-400', card: 'border-yellow-200 bg-yellow-50', label: 'Have enough'  },
  wrong_color: { dot: 'bg-orange-400', card: 'border-orange-200 bg-orange-50', label: 'Wrong colour' },
  not_in_set:  { dot: 'bg-gray-300',   card: 'border-gray-200',                label: 'Not in set'   },
  unknown:     { dot: 'bg-red-500',    card: 'border-red-200 bg-red-50',       label: 'Unknown'      },
}

const CONFIDENCE_BADGE: Record<string, string> = {
  high: '', medium: '~', low: '?', none: '??',
}

// ── Main component ───────────────────────────────────────────────────────────

export default function ScanPage() {
  const { setNum } = useParams<{ setNum: string }>()
  const videoRef   = useRef<HTMLVIdeUlElement>(null)
  const canvasRef  = useRef<HTMLCA�GElement>(null)
  const fileRef    = useRef<HTMLInputElement>(null)
  const streamRef  = useRef<MediaStream | null>(null)

  const [checklist,    setChecklist]   = useState<ChecklistLine[]>([])
  const [inputMode,    setInputMode]   = useState<InputMode>('camera')
  const [scanState,    setScanState]   = useState<ScanState>('idle')
  const [result,       setResult]      = useState<ScanResult | null>(null)
  const [errorMsg,     setErrorMsg]    = useState('')
  const [cameraReady,  setCameraReady] = useState(false)
  const [cameraError,  setCameraError] = useState('')
  const [photoPreview, setPhotoPreview] = useState<string | null>(null)   // data-url for photo mode
  const [photoB64,     setPhotoB64]    = useState<string | null>(null)    // raw b64 for API

  // Live checklist subscription
  useEffect(() => {
    return onSnapshot(collection(db, 'sets', setNum, 'checklist'), snap => {
      setChecklist(snap.docs.map(d => d.data() as ChecklistLine))
    })
  }, [setNum])

  // Start camera when in camera mode
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

  // Switch modes: stop camera, clear state
  function switchMode(mode: InputMode) {
    if (mode === inputMode) return
    streamRef.current?.getTracks().forEach(t => t.stop())
    streamRef.current = null
    setCameraReady(false)
    setCameraError('')
    setPhotoPreview(null)
    setPhotoB64(null)
    setResult(null)
    setScanState('idle')
    setErrorMsg('')
    setInputMode(mode)
  }

  // ── Camera capture ──

  function captureFrame(): string {
    const v = videoRef.current!
    const c = canvasRef.current!
    c.width  = v.videoWidth
    c.height = v.videoHeight
    c.getContext('2d')!.drawImage(v, 0, 0)
    return c.toDataURL('image/jpeg', 0.85).split(',')[1]
  }

  const handleCameraScan = useCallback(async () => {
    if (!cameraReady) return
    const b64 = captureFrame()
    await runScan(b64)
  }, [checklist, setNum, cameraReady])

  // ── Photo file pick ──

  function handleFileChange(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = ev => {
      const dataUrl = ev.target?.result as string
      setPhotoPreview(dataUrl)
      setPhotoB64(dataUrl.split(',')[1])
      setResult(null)
      setScanState('idle')
      setErrorMsg('')
    }
    reader.readAsDataURL(file)
  }

  async function handlePhotoScan() {
    if (!photoB64) return
    await runScan(photoB64)
  }

  // ── Shared scan logic ──

  async function runScan(b64: string) {
    setScanState('processing')
    setResult(null)
    setErrorMsg('')

    try {
      const resp = await fetch('/api/scan', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image_b64: b64,
          checklist: checklist.map(lineToApiFormat),
        }),
      })

      if (!resp.ok) {
        const err = await resp.json().catch(() => ({}))
        throw new Error(err.error || `Server error ${resp.status}`)
      }

      const data = await resp.json()
      const scanResult: ScanResult = {
        annotatedImageB64: data.annotated_image_b64,
        detections: (data.detections ?? []).map(mapDetection),
        summary: {
          totalDetected: data.summary.total_detected,
          needed:        data.summary.needed,
          haveEnough:    data.summary.have_enough,
          wrongColor:    data.summary.wrong_color  ?? 0,
          notInSet:      data.summary.not_in_set,
          unknown:       data.summary.unknown      ?? 0,
        },
      }

      setResult(scanResult)
      setScanState('result')
      await persistFinds(setNum, scanResult.detections)

    } catch (e: any) {
      setErrorMsg(e.message ?? 'Scan failed └ please try again')
      setScanState('error')
    }
  }

  function scanAgain() {
    setScanState('idle')
    setResult(null)
    setErrorMsg('')
    if (inputMode === 'photo') {
      setPhotoPreview(null)
      setPhotoB64(null)
      if (fileRef.current) fileRef.current.value = ''
    }
  }

  // ── Render ──

  const isProcessing = scanState === 'processing'

  return (
    <div className="space-y-4">

      {/* Header */}
      <div className="flex items-center gap-3 pt-1">
        <Link href={`/sets/${setNum}`} className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">Scan Bricks</h1>
      </div>

      {/* Mode toggle */}
      <div className="flex rounded-xl overflow-hidden border border-brand-900/10 bg-white">
        {('camera', 'photo'] as InputMode[]).map(mode => (
          <button
            key={mode}
            onClick={() => switchMode(mode)}
            className={`flex-1 py-2.5 text-sm font-semibold transition-colors
              ${inputMode === mode
                ? 'bg-brand-900 text-white'
                : 'text-brand-900/50 hover:text-brand-900'}`}
          >
            {mode === 'camera' ? '📹 Live Camera' : '📷 Take Photo'}
          </button>
        ))}
      </div>

      {/* Hidden canvas for frame capture */}
      <canvas ref={canvasRef} className="hidden" />

      {/* ─────── CAMERA MODE ─────── */}
      {inputMode === 'camera' && (
        <div className="relative rounded-2xl overflow-hidden bg-black"
             style={{ aspectRatio: '4/3' }}>

          {/* Live video */}
          <video
            ref={videoRef}
            autoPlay
            playsInline
            muted
            className={`w-full h-full object-cover transition-opacity duration-200
                        ${scanState === 'result' ? 'opacity-0' : 'opacity-100'}`}
          />

          {/* Annotated result overlay */}
          {scanState === 'result' && result?.annotatedImageB64 && (
            <img
              src={`data:image/jpeg;base64,${result.annotatedImageB64}`}
              alt="Scan result"
              className="absolute inset-0 w-full h-full object-cover"
            />
          )}

          {/* Processing overlay */}
          {isProcessing && (
            <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-3">
              <div className="w-14 h-14 border-4 border-white border-t-transparent
                              rounded-full animate-spin" />
              <p className="text-white font-semibold text-lg">Identifying bricks…</p>
              <p className="text-white/60 text-sm">Usually 15–20 seconds</p>
            </div>
          )}

          {/* Camera error */}
          {cameraError && (
            <div className="absolute inset-0 flex items-center justify-center bg-gray-900 p-6">
              <div className="text-center space-y-3">
                <p className="text-4xl">📷</p>
                <p className="text-white text-sm font-medium">{cameraError}</p>
              </div>
            </div>
          )}

          {/* Shutter button */}
          {scanState === 'idle' && cameraReady && !cameraError && (
            <button
              onClick={handleCameraScan}
              aria-label="Scan"
              className="absolute bottom-5 left-1/2 -translate-x-1/2 active:scale-90 transition-transform"
              style={{ width: 72, height: 72 }}
            >
              <span className="absolute inset-0 rounded-full border-4 border-white opacity-80" />
              <span className="absolute inset-2 rounded-full bg-white" />
            </button>
          )}

          {/* Scan again pill */}
          {scanState === 'result' && (
            <button
              onClick={scanAgain}
              className="absolute bottom-4 left-1/2 -translate-x-1/2
                         px-5 py-2.5 rounded-full bg-white/90 backdrop-blur-sm
                         font-semibold text-brand-900 shadow-lg text-sm
                         active:scale-95 transition-transform whitespace-nowrap"
            >
              📷 Scan Again
            </button>
          )}

          {/* Checklist missing hint */}
          {checklist.length === 0 && scanState === 'idle' && (
            <div className="absolute top-3 left-3 right-3
                            bg-lego-yellow/90 backdrop-blur-sm rounded-xl px-3 py-2">
              <p className="text-xs font-semibold text-brand-900 text-center">
                ⚠️ Load the parts list first —{' '}
                <Link href={`/sets/${setNum}`} className="underline">go back</Link>
              </p>
            </div>
          )}
        </div>
      )}

      {/* ─────── PHOTO MODE ─────── */}
      {inputMode === 'photo' && (
        <div className="space-y-3">
          {/* Hidden file input */}
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            capture="environment"
            onChange={handleFileChange}
            className="hidden"
          />

          {!photoPreview ? (
            /* Photo picker card */
            <button
              onClick={() => fileRef.current?.click()}
              className="w-full rounded-2xl border-2 border-dashed border-brand-900/20
                         bg-white flex flex-col items-center justify-center gap-3 py-16
                         active:bg-brand-900/5 transition-colors"
            >
              <span className="text-5xl">📷</span>
              <div className="text-center">
                <p className="font-semibold text-brand-900">Take or upload a photo</p>
                <p className="text-sm text-brand-900/50 mt-0.5">Spread bricks on a plain surface</p>
              </div>
            </button>
          ) : (
            /* Preview + scan */
            <div className="space-y-3">
              <div className="relative rounded-2xl overflow-hidden bg-black"
                   style={{ aspectRatio: '4/3' }}>
                <img
                  src={scanState === 'result' && result?.annotatedImageB64
                    ? `data:image/jpeg;base64,${result.annotatedImageB64}`
                    : photoPreview}
                  alt="Photo preview"
                  className="w-full h-full object-cover"
                />
                {isProcessing && (
                  <div className="absolute inset-0 bg-black/50 flex flex-col items-center justify-center gap-3">
                    <div className="w-14 h-14 border-4 border-white border-t-transparent
                                    rounded-full animate-spin" />
                    <p className="text-white font-semibold text-lg">Identifying bricks…</p>
                    <p className="text-white/60 text-sm">Usually 15–20 seconds</p>
                  </div>
                )}
              </div>

              {scanState !== 'result' && (
                <div className="flex gap-2">
                  <button
                    onClick={scanAgain}
                    className="btn-ghost flex-1 py-3"
                  >
                    ← Retake
                  </button>
                  <button
                    onClick={handlePhotoScan}
                    disabled={isProcessing}
                    className="btn-primary flex-1 py-3 disabled:opacity-50"
                  >
                    {isProcessing ? 'Scanning…' : '🔍 Scan Photo'}
                  </button>
                </div>
              )}

              {scanState === 'result' && (
                <button onClick={scanAgain} className="btn-primary w-full py-3">
                  📷 Scan Another Photo
                </button>
              )}
            </div>
          )}
        </div>
      )}

      {/* Error message */}
      {scanState === 'error' && errorMsg && (
        <div className="card border-red-200 bg-red-50 text-center py-4 space-y-2">
          <p className="font-semibold text-red-700">{errorMsg}</p>
          <button onClick={scanAgain} className="btn-primary px-8 text-sm">Try Again</button>
        </div>
      )}

      {/* ── Result panel ── */}
      {scanState === 'result' && result && (
        <div className="space-y-4">

          {/* Summary stats */}
          <div className="grid grid-cols-5 gap-2">
            <StatCard count={result.summary.needed}     label="Needed"     dotClass="bg-green-500"  />
            <StatCard count={result.summary.haveEnough} label="Enough"     dotClass="bg-yellow-400" />
            <StatCard count={result.summary.wrongColor} label="Wrong clr"  dotClass="bg-orange-400" />
            <StatCard count={result.summary.notInSet}   label="Not in set" dotClass="bg-gray-300"   />
            <StatCard count={result.summary.unknown}    label="Unknown"    dotClass="bg-red-500"    />
          </div>

          {result.summary.unknown > 0 && (
            <div className="card border-red-200 bg-red-50 py-3 text-center">
              <p className="text-sm font-semibold text-red-700">
                🔴 {result.summary.unknown} piece{result.summary.unknown !== 1 ? 's' : ''} couldn't be identified.
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
                className="btn-primary w-full text-center text-base py-3.5 block">
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
                    <div key={i} className={`card flex items-center gap-3 py-2.5 ${cfg.card}`}>
                      <span className={`w-3 h-3 rounded-full flex-shrink-0 ${cfg.dot}`} />
                      <div className="flex-1 min-w-0">
                        <p className="text-sm font-medium truncate">
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
              <p className="font-semibold text-brand-900/70">No pieces detected</p>
              <p className="text-sm text-brand-900/40">
                Spread bricks further apart on a plain, well-lit surface.
              </p>
            </div>
          )}
        </div>
      )}

      {/* Legend — idle camera state */}
      {inputMode === 'camera' && scanState === 'idle' && (
        <div className="card py-3">
          <p className="text-xs font-semibold text-gray-400 uppercase tracking-widest mb-2 text-center">
            What the colours mean
          </p>
          <div className="flex flex-wrap gap-2 justify-center">
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

function StatCard({
  count, label, dotClass
}: { count: number; label: string; dotClass: string }) {
  return (
    <div className="card text-center py-2.5 px-1">
      <div className="flex items-center justify-center gap-1 mb-0.5">
        <span className={`w-2 h-2 rounded-full ${dotClass}`} />
        <p className="text-2xl font-bold text-brand-900">{count}</p>
      </div>
      <p className="text-[10px] text-gray-400 leading-tight">{label}</p>
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
