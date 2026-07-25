'use client'

import { useEffect, useState } from 'react'

const PASSCODE   = '7169'
const UNLOCK_KEY = 'ps_unlock'
const UNLOCK_MS  = 60 * 60 * 1000   // 1 hour

export default function PasscodeGate({ children }: { children: React.ReactNode }) {
  const [unlocked, setUnlocked] = useState<boolean | null>(null)
  const [digits,   setDigits]   = useState('')
  const [shake,    setShake]    = useState(false)
  const [wrong,    setWrong]    = useState(false)

  useEffect(() => {
    try {
      const raw = localStorage.getItem(UNLOCK_KEY)
      if (raw && Date.now() - parseInt(raw, 10) < UNLOCK_MS) {
        setUnlocked(true); return
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
        setTimeout(() => setUnlocked(true), 150)
      } else {
        setShake(true); setWrong(true)
        setTimeout(() => { setDigits(''); setShake(false); setWrong(false) }, 650)
      }
    }
  }

  function delDigit() {
    if (shake) return
    setDigits(d => d.slice(0, -1))
  }

  if (unlocked === null) return null
  if (unlocked) return <>{children}</>

  // Bottom row: empty cell, 0, backspace
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div style={{
      position: 'fixed',
      inset: 0,
      background: '#f2f2f7',
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif',
      overflowY: 'auto',
    }}>

      {/* ── Top spacer ── */}
      <div style={{ flex: 1, minHeight: 48 }} />

      {/* ── Sherlock avatar circle ── */}
      <div style={{
        width: 96,
        height: 96,
        borderRadius: '50%',
        overflow: 'hidden',
        marginBottom: 16,
        boxShadow: '0 2px 16px rgba(0,0,0,0.15)',
      }}>
        <img
          src="/icon-192.png?v=2"
          alt="PartSleuth"
          style={{ width: '100%', height: '100%', objectFit: 'cover' }}
        />
      </div>

      {/* ── Title ── */}
      <p style={{
        margin: 0,
        fontSize: 22,
        fontWeight: 700,
        color: '#1c1c1e',
        letterSpacing: '-0.3px',
      }}>
        PartSleuth
      </p>

      {/* ── Subtitle / error ── */}
      <p style={{
        margin: '6px 0 44px',
        fontSize: 15,
        color: wrong ? '#ff3b30' : '#8e8e93',
        transition: 'color 0.2s',
      }}>
        {wrong ? 'Incorrect PIN — try again' : 'Enter your PIN'}
      </p>

      {/* ── PIN dot indicators ── */}
      <div
        style={{
          display: 'flex',
          gap: 22,
          marginBottom: 52,
          animation: shake ? 'shake 0.6s cubic-bezier(0.36,0.07,0.19,0.97) both' : undefined,
        }}
      >
        {[0, 1, 2, 3].map(i => (
          <div
            key={i}
            style={{
              width: 16,
              height: 16,
              borderRadius: '50%',
              border: `1.5px solid ${wrong ? '#ff3b30' : '#c7c7cc'}`,
              background: i < digits.length
                ? (wrong ? '#ff3b30' : '#1c1c1e')
                : 'transparent',
              transition: 'background 0.12s, border-color 0.12s',
            }}
          />
        ))}
      </div>

      {/* ── Numpad ── */}
      <div style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(3, 1fr)',
        gap: 12,
        width: '100%',
        maxWidth: 340,
        padding: '0 20px',
      }}>
        {keys.map((k, i) => {
          if (k === '') return <div key={i} />
          const isBack = k === '⌫'
          return (
            <button
              key={i}
              onClick={() => isBack ? delDigit() : addDigit(k)}
              style={{
                height: 72,
                borderRadius: 14,
                background: isBack ? 'transparent' : 'white',
                border: 'none',
                boxShadow: isBack ? 'none' : '0 1px 0 rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.06)',
                fontSize: isBack ? 24 : 32,
                fontWeight: 300,
                color: '#1c1c1e',
                cursor: 'pointer',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                transition: 'background 0.08s, transform 0.08s',
                WebkitTapHighlightColor: 'transparent',
                userSelect: 'none',
              }}
              onPointerDown={e => {
                const el = e.currentTarget
                el.style.background = isBack ? 'rgba(0,0,0,0.05)' : '#e5e5ea'
                el.style.transform  = 'scale(0.95)'
              }}
              onPointerUp={e => {
                const el = e.currentTarget
                el.style.background = isBack ? 'transparent' : 'white'
                el.style.transform  = 'scale(1)'
              }}
              onPointerLeave={e => {
                const el = e.currentTarget
                el.style.background = isBack ? 'transparent' : 'white'
                el.style.transform  = 'scale(1)'
              }}
            >
              {k}
            </button>
          )
        })}
      </div>

      {/* ── Bottom spacer ── */}
      <div style={{ flex: 1, minHeight: 32 }} />

      <style>{`
        @keyframes shake {
          0%,100% { transform: translateX(0) }
          15%      { transform: translateX(-9px) }
          30%      { transform: translateX(8px) }
          45%      { transform: translateX(-7px) }
          60%      { transform: translateX(5px) }
          75%      { transform: translateX(-3px) }
          90%      { transform: translateX(2px) }
        }
      `}</style>
    </div>
  )
}
