'use client'

import { useEffect, useState, createContext, useContext } from 'react'
import { doc, getDoc, setDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import Link from 'next/link'

// ── Session helpers ───────────────────────────────────────────────────────────
const SESSION_KEY = 'ps_session'
const SESSION_MS  = 24 * 60 * 60 * 1000   // 24 h

export interface UserSession {
  name:    string
  userId:  string
  isAdmin: boolean
  expiry:  number
}

export function getSession(): UserSession | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY)
    if (!raw) return null
    const s: UserSession = JSON.parse(raw)
    if (Date.now() > s.expiry) { localStorage.removeItem(SESSION_KEY); return null }
    return s
  } catch { return null }
}
function saveSession(s: UserSession) {
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)) } catch {}
}
function clearSession() {
  try { localStorage.removeItem(SESSION_KEY) } catch {}
}

// ── Auth context (readable by any client component) ───────────────────────────
export const AuthContext = createContext<UserSession | null>(null)
export function useAuth() { return useContext(AuthContext) }

// ── Screen type ───────────────────────────────────────────────────────────────
type Screen = 'loading' | 'enter_name' | 'enter_details' | 'enter_pin_login'
            | 'set_pin' | 'confirm_pin' | 'unlocked'


export default function PasscodeGate({ children }: { children: React.ReactNode }) {
  const [screen,   setScreen]   = useState<Screen>('loading')
  const [session,  setSession]  = useState<UserSession | null>(null)

  // name entry
  const [name,      setName]      = useState('')
  const [nameError, setNameError] = useState('')
  const [nameBusy,  setNameBusy]  = useState(false)

  // first-time details (real identity, shown in Admin)
  const [firstName,    setFirstName]    = useState('')
  const [surname,      setSurname]      = useState('')
  const [detailsError, setDetailsError] = useState('')

  // PIN entry
  const [digits,   setDigits]   = useState('')
  const [firstPin, setFirstPin] = useState('')
  const [shake,    setShake]    = useState(false)
  const [wrong,    setWrong]    = useState(false)
  const [pinLabel, setPinLabel] = useState('Enter your PIN')

  useEffect(() => {
    const s = getSession()
    if (s) { setSession(s); setScreen('unlocked') }
    else     setScreen('enter_name')
  }, [])

  // ── Name step ────────────────────────────────────────────────────────────────
  async function handleNameSubmit() {
    const trimmed = name.trim()
    if (!trimmed) { setNameError('Please enter your name'); return }
    setNameBusy(true); setNameError('')
    try {
      const userId  = trimmed.toLowerCase().replace(/\s+/g, '_')
      const userSnap = await getDoc(doc(db, 'users', userId))
      if (userSnap.exists()) {
        setScreen('enter_pin_login')
        setPinLabel(`Welcome back, ${trimmed.split(' ')[0]}!`)
      } else {
        // New user — collect their real name first (shown in Admin)
        setScreen('enter_details')
      }
    } catch {
      setNameError('Connection error — please try again')
    } finally {
      setNameBusy(false)
    }
  }

  // ── Details step (first-time users) ──────────────────────────────────────────
  function handleDetailsSubmit() {
    if (!firstName.trim() || !surname.trim()) {
      setDetailsError('Please fill in both names'); return
    }
    setDetailsError('')
    setScreen('set_pin')
    setPinLabel('Choose a 4-digit PIN')
  }

  // ── PIN step ─────────────────────────────────────────────────────────────────
  function addDigit(d: string) {
    if (shake) return
    const next = digits + d
    if (next.length > 4) return
    setDigits(next)
    if (next.length === 4) handlePinComplete(next)
  }
  function delDigit() { if (!shake) setDigits(d => d.slice(0, -1)) }

  async function handlePinComplete(pin: string) {
    if (screen === 'enter_pin_login') {
      await doLogin(pin)
    } else if (screen === 'set_pin') {
      setFirstPin(pin); setDigits('')
      setScreen('confirm_pin'); setPinLabel('Confirm your PIN')
    } else if (screen === 'confirm_pin') {
      if (pin === firstPin) {
        await doRegister(pin)
      } else {
        triggerShake(); setFirstPin(''); setScreen('set_pin')
        setPinLabel("PINs didn't match — try again")
      }
    }
  }

  async function doLogin(pin: string) {
    const userId = name.trim().toLowerCase().replace(/\s+/g, '_')
    try {
      const snap = await getDoc(doc(db, 'users', userId))
      if (!snap.exists() || snap.data().pin !== pin) {
        triggerShake(); setPinLabel('Incorrect PIN — try again'); return
      }
      const s: UserSession = {
        name:    snap.data().name || name.trim(),
        userId,
        isAdmin: userId === 'iain',
        expiry:  Date.now() + SESSION_MS,
      }
      saveSession(s); setSession(s); setScreen('unlocked')
    } catch { triggerShake(); setPinLabel('Connection error — try again') }
  }

  async function doRegister(pin: string) {
    const trimmed = name.trim()
    const userId  = trimmed.toLowerCase().replace(/\s+/g, '_')
    try {
      await setDoc(doc(db, 'users', userId), {
        name: trimmed,                     // what they're called in the app
        firstName: firstName.trim(),       // real identity — visible in Admin
        surname:   surname.trim(),
        pin, isAdmin: userId === 'iain', createdAt: Date.now(),
      })
      const s: UserSession = {
        name: trimmed, userId, isAdmin: userId === 'iain', expiry: Date.now() + SESSION_MS,
      }
      saveSession(s); setSession(s); setScreen('unlocked')
    } catch { triggerShake(); setPinLabel('Error saving — try again') }
  }

  function triggerShake() {
    setShake(true); setWrong(true)
    setTimeout(() => { setDigits(''); setShake(false); setWrong(false) }, 650)
  }

  function handleSignOut() {
    clearSession(); setSession(null); setName(''); setDigits(''); setFirstPin('')
    setScreen('enter_name')
  }

  // ── Render ────────────────────────────────────────────────────────────────────
  if (screen === 'loading') return null

  if (screen === 'unlocked' && session) {
    return (
      <AuthContext.Provider value={session}>
        {children}
        {/* Persistent bottom bar — sign out + admin link */}
        <div style={{
          position: 'fixed', bottom: 0, left: 0, right: 0,
          display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          padding: '10px 20px',
          background: 'rgba(245,243,238,0.93)', backdropFilter: 'blur(8px)',
          borderTop: '1px solid rgba(0,0,0,0.07)', zIndex: 30,
          fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", sans-serif',
        }}>
          <span style={{ fontSize: 13, color: 'rgba(26,26,46,0.5)', fontWeight: 500 }}>
            👤 {session.name}
          </span>
          <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
            {session.isAdmin && (
              <Link href="/admin" style={{
                fontSize: 13, fontWeight: 700, color: '#1c1c1e',
                background: '#FFD700', padding: '6px 14px', borderRadius: 99,
                textDecoration: 'none', lineHeight: 1,
              }}>⚙️ Admin</Link>
            )}
            <button onClick={handleSignOut} style={{
              fontSize: 13, fontWeight: 600, color: 'rgba(26,26,46,0.5)',
              background: 'transparent', border: 'none', cursor: 'pointer', padding: '6px 2px',
            }}>Sign out</button>
          </div>
        </div>
      </AuthContext.Provider>
    )
  }

  // ── Auth UI shell ─────────────────────────────────────────────────────────────
  const showPin = screen === 'enter_pin_login' || screen === 'set_pin' || screen === 'confirm_pin'
  const keys    = ['1','2','3','4','5','6','7','8','9','','0','⌫']

  return (
    <div style={{
      position: 'fixed', inset: 0, background: '#f2f2f7',
      display: 'flex', flexDirection: 'column', alignItems: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "SF Pro Display", "Helvetica Neue", sans-serif',
      overflowY: 'auto',
    }}>
      <div style={{ flex: 1, minHeight: 48 }} />

      {/* Avatar */}
      <div style={{
        width: 96, height: 96, borderRadius: '50%', overflow: 'hidden',
        marginBottom: 16, boxShadow: '0 2px 16px rgba(0,0,0,0.15)',
      }}>
        <img src="/avatar.png" alt="PartSleuth"
             style={{ width: '100%', height: '100%', objectFit: 'cover' }} />
      </div>

      <p style={{ margin: 0, fontSize: 22, fontWeight: 700, color: '#1c1c1e', letterSpacing: '-0.3px' }}>
        PartSleuth
      </p>

      {/* ── Name entry screen ─────────────────────────────────────────────── */}
      {screen === 'enter_name' && (
        <div style={{ width: '100%', maxWidth: 340, padding: '28px 20px 0' }}>
          <p style={{ margin: '0 0 18px', fontSize: 15, color: '#8e8e93', textAlign: 'center' }}>
            What should we call you?
          </p>
          <input
            type="text"
            placeholder="Your name or nickname"
            value={name}
            onChange={e => { setName(e.target.value); setNameError('') }}
            onKeyDown={e => e.key === 'Enter' && handleNameSubmit()}
            autoFocus
            style={{
              width: '100%', padding: '14px 16px', fontSize: 17, borderRadius: 14,
              border: `1.5px solid ${nameError ? '#ff3b30' : '#c7c7cc'}`,
              background: 'white', outline: 'none', boxSizing: 'border-box',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            }}
          />
          {nameError && (
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#ff3b30' }}>{nameError}</p>
          )}
          <button
            onClick={handleNameSubmit}
            disabled={nameBusy || !name.trim()}
            style={{
              marginTop: 14, width: '100%', padding: 16, fontSize: 17, fontWeight: 700,
              borderRadius: 14, border: 'none', background: '#1c1c1e', color: 'white',
              cursor: nameBusy || !name.trim() ? 'not-allowed' : 'pointer',
              opacity: nameBusy || !name.trim() ? 0.4 : 1, transition: 'opacity 0.2s',
            }}
          >
            {nameBusy ? 'Checking…' : 'Continue →'}
          </button>
        </div>
      )}

      {/* ── First-time details screen ─────────────────────────────────────── */}
      {screen === 'enter_details' && (
        <div style={{ width: '100%', maxWidth: 340, padding: '28px 20px 0' }}>
          <p style={{ margin: '0 0 4px', fontSize: 16, fontWeight: 600, color: '#1c1c1e', textAlign: 'center' }}>
            Nice to meet you, {name.trim()}!
          </p>
          <p style={{ margin: '0 0 18px', fontSize: 14, color: '#8e8e93', textAlign: 'center' }}>
            What&apos;s your full name?
          </p>
          <input
            type="text"
            placeholder="First name"
            value={firstName}
            onChange={e => { setFirstName(e.target.value); setDetailsError('') }}
            autoFocus
            style={{
              width: '100%', padding: '14px 16px', fontSize: 17, borderRadius: 14,
              border: `1.5px solid ${detailsError && !firstName.trim() ? '#ff3b30' : '#c7c7cc'}`,
              background: 'white', outline: 'none', boxSizing: 'border-box',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            }}
          />
          <input
            type="text"
            placeholder="Surname"
            value={surname}
            onChange={e => { setSurname(e.target.value); setDetailsError('') }}
            onKeyDown={e => e.key === 'Enter' && handleDetailsSubmit()}
            style={{
              marginTop: 10,
              width: '100%', padding: '14px 16px', fontSize: 17, borderRadius: 14,
              border: `1.5px solid ${detailsError && !surname.trim() ? '#ff3b30' : '#c7c7cc'}`,
              background: 'white', outline: 'none', boxSizing: 'border-box',
              boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
            }}
          />
          {detailsError && (
            <p style={{ margin: '8px 0 0', fontSize: 13, color: '#ff3b30' }}>{detailsError}</p>
          )}
          <button
            onClick={handleDetailsSubmit}
            disabled={!firstName.trim() || !surname.trim()}
            style={{
              marginTop: 14, width: '100%', padding: 16, fontSize: 17, fontWeight: 700,
              borderRadius: 14, border: 'none', background: '#1c1c1e', color: 'white',
              cursor: !firstName.trim() || !surname.trim() ? 'not-allowed' : 'pointer',
              opacity: !firstName.trim() || !surname.trim() ? 0.4 : 1, transition: 'opacity 0.2s',
            }}
          >
            Continue →
          </button>
          <button
            onClick={() => { setScreen('enter_name'); setDetailsError('') }}
            style={{ marginTop: 16, width: '100%', fontSize: 14, color: '#8e8e93',
                     background: 'transparent', border: 'none', cursor: 'pointer' }}
          >← Back</button>
        </div>
      )}

      {/* ── PIN screens ───────────────────────────────────────────────────── */}
      {showPin && (
        <>
          {name.trim() && (
            <p style={{ margin: '6px 0 0', fontSize: 16, fontWeight: 600, color: '#1c1c1e' }}>
              {name.trim().split(' ')[0]}
            </p>
          )}
          <p style={{
            margin: '4px 0 44px', fontSize: 14,
            color: wrong ? '#ff3b30' : '#8e8e93', transition: 'color 0.2s',
          }}>
            {wrong ? 'Incorrect — try again' : pinLabel}
          </p>

          {/* Dot indicators */}
          <div style={{
            display: 'flex', gap: 22, marginBottom: 52,
            animation: shake ? 'shake 0.6s cubic-bezier(0.36,0.07,0.19,0.97) both' : undefined,
          }}>
            {[0,1,2,3].map(i => (
              <div key={i} style={{
                width: 16, height: 16, borderRadius: '50%',
                border: `1.5px solid ${wrong ? '#ff3b30' : '#c7c7cc'}`,
                background: i < digits.length ? (wrong ? '#ff3b30' : '#1c1c1e') : 'transparent',
                transition: 'background 0.12s, border-color 0.12s',
              }} />
            ))}
          </div>

          {/* Numpad */}
          <div style={{
            display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)',
            gap: 12, width: '100%', maxWidth: 340, padding: '0 20px',
          }}>
            {keys.map((k, i) => {
              if (k === '') return <div key={i} />
              const isBack = k === '⌫'
              return (
                <button key={i}
                  onClick={() => isBack ? delDigit() : addDigit(k)}
                  style={{
                    height: 72, borderRadius: 14,
                    background: isBack ? 'transparent' : 'white', border: 'none',
                    boxShadow: isBack ? 'none' : '0 1px 0 rgba(0,0,0,0.08), 0 1px 4px rgba(0,0,0,0.06)',
                    fontSize: isBack ? 24 : 32, fontWeight: 300, color: '#1c1c1e',
                    cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center',
                    transition: 'background 0.08s, transform 0.08s',
                    WebkitTapHighlightColor: 'transparent', userSelect: 'none',
                  }}
                  onPointerDown={e => { e.currentTarget.style.background = isBack ? 'rgba(0,0,0,0.05)' : '#e5e5ea'; e.currentTarget.style.transform = 'scale(0.95)' }}
                  onPointerUp={e => { e.currentTarget.style.background = isBack ? 'transparent' : 'white'; e.currentTarget.style.transform = 'scale(1)' }}
                  onPointerLeave={e => { e.currentTarget.style.background = isBack ? 'transparent' : 'white'; e.currentTarget.style.transform = 'scale(1)' }}
                >
                  {k}
                </button>
              )
            })}
          </div>

          <button
            onClick={() => { setScreen('enter_name'); setDigits(''); setWrong(false); setShake(false) }}
            style={{ marginTop: 28, fontSize: 14, color: '#8e8e93', background: 'transparent', border: 'none', cursor: 'pointer' }}
          >← Back</button>
        </>
      )}

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
