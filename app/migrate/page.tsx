'use client'

/**
 * One-time migration: copies all legacy sets/{setNum} docs to users/emma/sets/{setNum}.
 * Admin-only. Safe to re-run — skips sets that already exist under Emma's account.
 */

import { useState } from 'react'
import {
  collection, getDocs, doc,
  setDoc, writeBatch, getDoc,
} from 'firebase/firestore'
import { db } from '@/lib/firebase'
import Link from 'next/link'
import { getSession } from '../components/PasscodeGate'

export default function MigratePage() {
  const session = typeof window !== 'undefined' ? getSession() : null
  const isAdmin = session?.isAdmin ?? false

  const [running,  setRunning]  = useState(false)
  const [done,     setDone]     = useState(false)
  const [log,      setLog]      = useState<string[]>([])

  function addLog(msg: string) {
    setLog(prev => [...prev, msg])
  }

  async function runMigration() {
    setRunning(true)
    setLog([])
    addLog('Starting migration → users/emma/sets/ …')

    try {
      const setsSnap = await getDocs(collection(db, 'sets'))
      if (setsSnap.empty) {
        addLog('No legacy sets found in sets/ — nothing to migrate.')
        setDone(true)
        return
      }
      addLog(`Found ${setsSnap.size} sets in legacy collection.`)

      for (const setDocSnap of setsSnap.docs) {
        const setNum  = setDocSnap.id
        const setData = setDocSnap.data()

        // Check if already migrated
        const destRef  = doc(db, 'users', 'emma', 'sets', setNum)
        const destSnap = await getDoc(destRef)
        if (destSnap.exists()) {
          addLog(`⏭  ${setNum} (${setData.name}) — already migrated, skipping`)
          continue
        }

        // Write the set document
        await setDoc(destRef, setData)
        addLog(`✓  ${setNum} — ${setData.name}`)

        // Copy checklist subcollection in batches of 400
        const clSnap = await getDocs(collection(db, 'sets', setNum, 'checklist'))
        if (clSnap.size > 0) {
          let written = 0
          const docs = clSnap.docs
          for (let i = 0; i < docs.length; i += 400) {
            const chunk = docs.slice(i, i + 400)
            const batch = writeBatch(db)
            for (const clDoc of chunk) {
              batch.set(
                doc(db, 'users', 'emma', 'sets', setNum, 'checklist', clDoc.id),
                clDoc.data()
              )
            }
            await batch.commit()
            written += chunk.length
          }
          addLog(`   └ ${written} checklist items copied`)
        } else {
          addLog(`   └ no checklist yet`)
        }
      }

      addLog('')
      addLog('✅ Migration complete! Emma\'s sets are ready.')
      addLog('You can now sign in as Emma to verify, then delete this page.')
    } catch (e: any) {
      addLog(`❌ Error: ${e.message}`)
    } finally {
      setRunning(false)
      setDone(true)
    }
  }

  if (!isAdmin) {
    return (
      <div className="card text-center py-16 space-y-3">
        <p className="text-4xl">🔒</p>
        <p className="font-bold text-brand-900">Admin only</p>
        <Link href="/" className="btn-primary inline-block px-8 py-3">← Back</Link>
      </div>
    )
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3 pt-1">
        <Link href="/" className="btn-ghost text-sm -ml-2">← Back</Link>
        <h1 className="text-2xl font-black text-brand-900">Data Migration</h1>
      </div>

      <div className="card space-y-3">
        <p className="font-semibold text-brand-900">What this does</p>
        <p className="text-sm text-brand-900/60">
          Copies all sets from the legacy <code className="bg-gray-100 px-1 rounded">sets/</code> collection
          to <code className="bg-gray-100 px-1 rounded">users/emma/sets/</code>.
          Safe to run multiple times — already-migrated sets are skipped.
          The original data is <strong>not deleted</strong>.
        </p>
        {!done && (
          <button
            onClick={runMigration}
            disabled={running}
            className="btn-primary w-full py-3.5 text-base"
          >
            {running ? (
              <span className="flex items-center justify-center gap-2">
                <span className="inline-block w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
                Migrating…
              </span>
            ) : '🚀 Run Migration'}
          </button>
        )}
      </div>

      {log.length > 0 && (
        <div className="card bg-gray-50 font-mono text-xs leading-relaxed space-y-0.5 max-h-96 overflow-y-auto">
          {log.map((line, i) => (
            <p key={i} className={
              line.startsWith('✅') ? 'text-green-700 font-bold' :
              line.startsWith('❌') ? 'text-red-700 font-bold' :
              line.startsWith('✓') ? 'text-green-600' :
              line.startsWith('⏭') ? 'text-brand-900/40' :
              'text-brand-900/70'
            }>{line || ' '}</p>
          ))}
        </div>
      )}

      {done && (
        <Link href="/" className="btn-primary w-full text-center py-3.5 block text-base">
          ← Go to Your Sets
        </Link>
      )}
    </div>
  )
}
