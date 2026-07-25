'use client'

import { useEffect, useState } from 'react'

const PASSCODE      = '7169'
const UNLOCK_KEY    = 'ps_unlock'
const UNLOCK_MS     = 60 * 60 * 1000   // 1 hour

export default function PasscodeGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null)
  const [digits, setDigits]     = useState('')
  const [shake, setShake]       = useState(false)
  const [wrong, setWrong]       = useState(false)

  // On mount, check saved unlock timestamp
  useEffect(() => {
    try {
      const raw = localStorage.getItem(UNLOCK_KEY)
      if (raw && Date.now() - parseInt(raw, 10) < UNLOCK_MS) {
        setUnlocked(true)
        return
      }
    } catch {}
    setUnlocked(false)
  }, [])

  function addDigit(d: string) {
    if (shake) return
    const next = digits + d
    if (next.length > 4) return
    setDigits(next)

    if (next.length === 4) {
      if (next === PASSCODE) {
        try { localStorage.setItem(UNLOCK_KEY, Date.now().toString()) } catch {}
        setTimeout(() => setUnlocked(true), 120)
      } else {
        setShake(true)
        setWrong(true)
        setTimeout(() => {
          setDigits('')
          setShake(false)
          setWrong(false)
        }, 650)
      }
    }
  }

  function delDigit() {
    if (shake) return
    setDigits(d => d.slice(0, -1))
  }

  // Still checking
  if (unlocked === null) return null

  // Unlocked — render app
  if (unlocked) return <>{children}</>

  // Passcode screen
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div
      className="fixed inset-0 flex flex-col items-center justify-between overflow-hidden"
      style={{ backgroundColor: '#0a0a0a' }}
    >
      {/* Hero image — top half */}
      <div className="relative w-full flex-1 overflow-hidden" style={{ maxHeight: '52vh' }}>
        <img
          src="/splash.jpg"
          alt="PartSleuth"
          className="w-full h-full object-cover object-top"
          style={{ filter: 'brightness(0.75)' }}
        />
        {/* Gradient overlay at bottom of image */}
        <div
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to bottom, transparent 40%, #0a0a0a 100%)',
          }}
        />
        {/* App name at top */}
        <div className="absolute top-0 left-0 right-0 pt-10 pb-4 px-6 text-center">
          <p
            className="font-black tracking-tight"
            style={{ fontSize: 28, color: '#FFD700', letterSpacing: '-0.5px' }}
          >
            PartSleuth
          </p>
        </div>
      </div>

      {/* PIN entry — bottom half */}
      <div
        className="w-full flex flex-col items-center gap-6 px-8 pt-4 pb-10"
        style={{ maxWidth: 340 }}
      >
        {/* Label */}
        <p
          className="font-semibold tracking-widest uppercase"
          style={{ color: wrong ? '#ef4444' : 'rgba(255,255,255,0.5)', fontSize: 13, letterSpacing: 3 }}
        >
          {wrong ? 'Incorrect' : 'Password?'}
        </p>

        {/* 4 dots */}
        <div
          className={`flex gap-5 ${shake ? 'animate-[wiggle_0.6s_ease-in-out]' : ''}`}
          style={{
            animation: shake ? 'shake 0.6s cubic-bezier(0.36,0.07,0.19,0.97)' : undefined,
          }}
        >
          {[0,1,2,3].map(i => (
            <div
              key={i}
              style={{
                width: 16,
                height: 16,
                borderRadius: '50%',
                backgroundColor: i < digits.length
                  ? (wrong ? '#ef4444' : '#FFD700')
                  : 'rgba(255,255,255,0.2)',
                transition: 'background-color 0.15s',
                boxShadow: i < digits.length && !wrong
                  ? '0 0 8px rgba(255,215,0,0.6)'
                  : undefined,
              }}
            />
          ))}
        </div>

        {/* Numpad */}
        <div className="grid grid-cols-3 gap-3 w-full">
          {keys.map((k, i) => {
            if (k === '') return <div key={i} />
            const isBack = k === '⌫'
            return (
              <button
                key={i}
                onClick={() => isBack ? delDigit() : addDigit(k)}
                style={{
                  height: 64,
                  borderRadius: 16,
                  backgroundColor: isBack ? 'transparent' : 'rgba(255,255,255,0.08)',
                  color: isBack ? 'rgba(255,255,255,0.5)' : 'white',
                  fontSize: isBack ? 22 : 26,
                  fontWeight: 600,
                  border: 'none',
                  cursor: 'pointer',
                  transition: 'background-color 0.1s, transform 0.1s',
                  display: 'flex',
                  alignItems: 'center',
                  justifyContent: 'center',
                }}
                onPointerDown={e => {
                  const el = e.currentTarget
                  el.style.backgroundColor = isBack ? 'rgba(255,255,255,0.05)' : 'rgba(255,255,255,0.18)'
                  el.style.transform = 'scale(0.95)'
                }}
                onPointerUp={e => {
                  const el = e.currentTarget
                  el.style.backgroundColor = isBack ? 'transparent' : 'rgba(255,255,255,0.08)'
                  el.style.transform = 'scale(1)'
                }}
                onPointerLeave={e => {
                  const el = e.currentTarget
                  el.style.backgroundColor = isBack ? 'transparent' : 'rgba(255,255,255,0.08)'
                  el.style.transform = 'scale(1)'
                }}
              >
                {k}
              </button>
            )
          })}
        </div>
      </div>

      {/* Shake keyframe */}
      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0) }
          15%      { transform: translateX(-8px) }
          30%      { transform: translateX(7px) }
          45%      { transform: translateX(-6px) }
          60%      { transform: translateX(5px) }
          75%      { transform: translateX(-3px) }
          90%      { transform: translateX(2px) }
        }
      `}</style>
    </div>
  )
}
