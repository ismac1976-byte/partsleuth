'use client'

import { useEffect, useState } from 'react'
import { collection, getDocs, doc, getDoc, setDoc, updateDoc, deleteDoc } from 'firebase/firestore'
import { db } from '@/lib/firebase'
import { getSession } from '../components/PasscodeGate'
import Link from 'next/link'

interface Usage { date: string; count: number; limit: number; blocked: boolean }

function todayStr() {
  return new Date().toISOString().slice(0, 10)
}

interface PSUser {
  userId: string; name: string; pin: string; isAdmin: boolean; createdAt: number
  firstName?: string; surname?: string
}

export default function AdminPage() {
  const [authorized, setAuthorized] = useState<boolean | null>(null)
  const [users, setUsers] = useState<PSUser[]>([])
  const [loading, setLoading] = useState(true)
  const [resetState, setResetState] = useState<{ userId: string; pin: string } | null>(null)
  const [confirmDel, setConfirmDel] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Usage / rate limit
  const [usage, setUsage]           = useState<Usage | null>(null)
  const [limitDraft, setLimitDraft] = useState('')
  const [usageBusy, setUsageBusy]   = useState(false)

  useEffect(() => {
    const s = getSession()
    if (!s || !s.isAdmin) { setAuthorized(false); return }
    setAuthorized(true)
    loadUsers()
    loadUsage()
  }, [])

  async function loadUsage() {
    const ref  = doc(db, 'config', 'usage')
    const snap = await getDoc(ref)
    if (!snap.exists()) {
      const fresh: Usage = { date: todayStr(), count: 0, limit: 100, blocked: false }
      await setDoc(ref, fresh)
      setUsage(fresh); setLimitDraft('100')
      return
    }
    const u = snap.data() as Usage
    // display 0 if the stored counter is from a previous day
    const shown = u.date === todayStr() ? u : { ...u, count: 0 }
    setUsage(shown)
    setLimitDraft(String(u.limit ?? 100))
  }

  async function saveLimit() {
    const n = parseInt(limitDraft, 10)
    if (!Number.isFinite(n) || n < 1) return
    setUsageBusy(true)
    await setDoc(doc(db, 'config', 'usage'), { limit: n }, { merge: true })
    await loadUsage(); setUsageBusy(false)
  }

  async function approveResume() {
    setUsageBusy(true)
    await setDoc(doc(db, 'config', 'usage'),
      { date: todayStr(), count: 0, blocked: false }, { merge: true })
    await loadUsage(); setUsageBusy(false)
  }

  async function pauseScanning() {
    setUsageBusy(true)
    await setDoc(doc(db, 'config', 'usage'), { blocked: true }, { merge: true })
    await loadUsage(); setUsageBusy(false)
  }

  async function loadUsers() {
    setLoading(true)
    const snap = await getDocs(collection(db, 'users'))
    setUsers(snap.docs.map(d => ({ userId: d.id, ...d.data() } as PSUser)).sort((a, b) => a.createdAt - b.createdAt))
    setLoading(false)
  }

  async function handleResetPin(userId: string, newPin: string) {
    if (!/^\d{4}$/.test(newPin)) return
    setBusy(true)
    await updateDoc(doc(db, 'users', userId), { pin: newPin })
    setResetState(null); setBusy(false)
    await loadUsers()
  }

  async function handleDelete(userId: string) {
    setBusy(true)
    await deleteDoc(doc(db, 'users', userId))
    setConfirmDel(null); setBusy(false)
    await loadUsers()
  }

  if (authorized === null) return null

  if (authorized === false) {
    return (
      <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', minHeight: '60vh', gap: 16 }}>
        <p style={{ fontSize: 18, fontWeight: 700 }}>Access denied</p>
        <Link href="/" className="btn-primary">Go Home</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 pt-1">
        <Link href="/" className="btn-ghost text-sm -ml-2">Back</Link>
        <h1 className="text-2xl font-black text-brand-900">Admin</h1>
      </div>

      {/* ── Scan usage & daily limit ── */}
      {usage && (
        <div className={`card space-y-3 ${usage.blocked || usage.count >= usage.limit
                          ? 'border-red-200 bg-red-50' : ''}`}>
          <div className="flex items-center justify-between">
            <div>
              <p className="font-bold text-brand-900">Scan usage today</p>
              <p className="text-sm text-brand-900/50 mt-0.5">
                {Math.min(usage.count, usage.limit)} of {usage.limit} pile scans used
              </p>
            </div>
            {usage.blocked || usage.count >= usage.limit ? (
              <span className="text-xs font-bold bg-red-500 text-white px-3 py-1 rounded-full">
                ⛔ Scanning paused
              </span>
            ) : (
              <span className="text-xs font-bold bg-green-100 text-green-700 px-3 py-1 rounded-full">
                ✓ Active
              </span>
            )}
          </div>

          <div className="progress-track">
            <div className="progress-fill"
                 style={{ width: `${Math.min(100, 100 * usage.count / Math.max(1, usage.limit))}%`,
                          background: usage.count >= usage.limit
                            ? '#ef4444'
                            : 'linear-gradient(90deg, #22c55e, #16a34a)' }} />
          </div>

          <div className="flex items-center gap-2 flex-wrap">
            <label className="text-xs font-semibold text-brand-900/60">Daily limit</label>
            <input type="text" inputMode="numeric" value={limitDraft}
                   onChange={e => setLimitDraft(e.target.value.replace(/\D/g, '').slice(0, 5))}
                   className="input-base text-center font-bold"
                   style={{ width: 80, padding: '6px 10px' }} />
            <button onClick={saveLimit}
                    disabled={usageBusy || !limitDraft || String(usage.limit) === limitDraft}
                    className="btn-secondary text-xs py-2 px-4">
              Save limit
            </button>
            {(usage.blocked || usage.count >= usage.limit) ? (
              <button onClick={approveResume} disabled={usageBusy}
                      className="text-xs font-bold text-white bg-green-500 hover:bg-green-600
                                 rounded-full px-4 py-2 transition-colors disabled:opacity-50">
                ✓ Approve &amp; resume
              </button>
            ) : (
              <button onClick={pauseScanning} disabled={usageBusy}
                      className="text-xs font-semibold text-red-500 border border-red-200
                                 rounded-full px-4 py-2 hover:bg-red-50 transition-colors disabled:opacity-50">
                Pause scanning
              </button>
            )}
          </div>
          <p className="text-xs text-brand-900/40">
            Applies to Brick Pile scans (the only ones that cost money).
            Single Brick and Whose Brick are free and never limited.
          </p>
        </div>
      )}

      {loading ? (
        <div className="card py-6 text-center text-brand-900/50 text-sm">Loading users...</div>
      ) : (
        <div className="space-y-3">
          <p className="section-label">{users.length} registered user{users.length !== 1 ? 's' : ''}</p>

          {users.map(user => (
            <div key={user.userId} className="card space-y-3">
              <div className="flex items-center justify-between gap-3">
                <div className="flex-1 min-w-0">
                  <p className="font-bold text-brand-900">
                    {user.name}
                    {user.isAdmin && <span className="ml-2 text-xs font-semibold bg-yellow-100 text-yellow-800 px-2 py-0.5 rounded-full">Admin</span>}
                  </p>
                  {(user.firstName || user.surname) && (
                    <p className="text-sm text-brand-900/60 mt-0.5 font-medium">
                      {[user.firstName, user.surname].filter(Boolean).join(' ')}
                    </p>
                  )}
                  <p className="text-xs text-brand-900/40 mt-0.5">
                    Joined {new Date(user.createdAt).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}
                  </p>
                </div>
                <div className="flex gap-2 flex-shrink-0">
                  <button onClick={() => { setResetState({ userId: user.userId, pin: '' }); setConfirmDel(null) }}
                    className="text-xs px-3 py-1.5 rounded-full border border-gray-200 text-gray-600 hover:bg-gray-50 transition-colors">
                    Reset PIN
                  </button>
                  {!user.isAdmin && (
                    <button onClick={() => { setConfirmDel(user.userId); setResetState(null) }}
                      className="text-xs px-3 py-1.5 rounded-full border border-red-200 text-red-500 hover:bg-red-50 transition-colors">
                      Remove
                    </button>
                  )}
                </div>
              </div>

              {resetState?.userId === user.userId && (
                <div className="bg-gray-50 rounded-xl p-3 space-y-2 border border-gray-100">
                  <p className="text-xs font-semibold text-brand-900/70">New 4-digit PIN for {user.name}</p>
                  <div className="flex gap-2 items-center">
                    <input type="text" inputMode="numeric" maxLength={4} placeholder="0000"
                      value={resetState.pin}
                      onChange={e => setResetState({ ...resetState, pin: e.target.value.replace(/\D/g, '').slice(0, 4) })}
                      className="input-base text-center text-xl tracking-widest font-bold"
                      style={{ width: 90, padding: '8px 12px' }} autoFocus />
                    <button onClick={() => handleResetPin(resetState.userId, resetState.pin)}
                      disabled={resetState.pin.length !== 4 || busy}
                      className="btn-primary text-sm py-2 px-4">{busy ? 'Saving...' : 'Save'}</button>
                    <button onClick={() => setResetState(null)} className="btn-ghost text-sm">Cancel</button>
                  </div>
                </div>
              )}

              {confirmDel === user.userId && (
                <div className="bg-red-50 rounded-xl p-3 space-y-2 border border-red-100">
                  <p className="text-xs font-semibold text-red-700">Remove {user.name}? They will need to re-register.</p>
                  <div className="flex gap-2">
                    <button onClick={() => handleDelete(user.userId)} disabled={busy}
                      className="text-xs px-4 py-1.5 rounded-full bg-red-500 text-white hover:bg-red-600 transition-colors disabled:opacity-50">
                      {busy ? 'Removing...' : 'Remove'}
                    </button>
                    <button onClick={() => setConfirmDel(null)}
                      className="text-xs px-4 py-1.5 rounded-full border border-gray-300 text-gray-600 hover:bg-gray-50 transition-colors">
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
