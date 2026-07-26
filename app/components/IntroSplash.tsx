'use client'

// Full-screen intro video shown once per app session, before the PIN screen.
//
// Browser rules mean sound cannot autoplay without a user gesture, so:
//   - the video starts instantly, muted
//   - one tap anywhere unmutes and restarts it from the top with sound
//   - Skip is always available
// If the phone's ringer is off, unmuted playback stays silent as usual.

import { useEffect, useRef, useState } from 'react'

const SESSION_KEY = 'ps_intro_done'
const MAX_MS      = 15000   // safety: never block the app longer than this

export default function IntroSplash() {
  const videoRef = useRef<HTMLVideoElement>(null)

  const [show, setShow]     = useState<boolean | null>(null)  // null until we check sessionStorage
  const [fading, setFading] = useState(false)
  const [muted, setMuted]   = useState(true)

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_KEY)) { setShow(false); return }
    } catch {}
    setShow(true)
    const t = setTimeout(dismiss, MAX_MS)
    return () => clearTimeout(t)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function dismiss() {
    try { sessionStorage.setItem(SESSION_KEY, '1') } catch {}
    setFading(true)
    setTimeout(() => setShow(false), 350)
  }

  function tapForSound() {
    const v = videoRef.current
    if (!v || !muted) return
    v.muted = false
    v.currentTime = 0
    setMuted(false)
    v.play().catch(() => {})
  }

  if (!show) return null

  return (
    <div
      className={`fixed inset-0 z-[100] bg-black flex items-center justify-center
                  transition-opacity duration-300 ${fading ? 'opacity-0' : 'opacity-100'}`}
      onClick={tapForSound}
    >
      <video
        ref={videoRef}
        src="/intro.mp4"
        autoPlay
        muted
        playsInline
        preload="auto"
        onEnded={dismiss}
        onError={dismiss}
        className="w-full h-full object-contain"
      />

      {/* Skip */}
      <button
        onClick={e => { e.stopPropagation(); dismiss() }}
        className="absolute top-4 right-4 bg-white/15 text-white text-sm font-semibold
                   px-4 py-2 rounded-full backdrop-blur-sm active:scale-95 transition-transform"
        style={{ marginTop: 'env(safe-area-inset-top)' }}
      >
        Skip ›
      </button>

      {/* Sound hint */}
      {muted && (
        <div className="absolute bottom-8 left-0 right-0 flex justify-center pointer-events-none">
          <span className="bg-white/15 text-white text-sm font-semibold px-4 py-2
                           rounded-full backdrop-blur-sm">
            🔊 Tap for sound
          </span>
        </div>
      )}
    </div>
  )
}
