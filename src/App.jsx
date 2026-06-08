import { useState, useCallback } from 'react'

const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params }).toString()
  const res = await fetch(`/api/upstox?${qs}`)
  const json = await res.json()
  if (!res.ok) throw new Error(`${endpoint}: ${res.status} — ${JSON.stringify(json)}`)
  return json
}

const todayStr = () => new Date().toISOString().split('T')[0]

export default function App() {
  const [log, setLog] = useState([])
  const [loading, setLoading] = useState(false)

  const addLog = (msg) => setLog(prev => [...prev, `${new Date().toLocaleTimeString()} — ${msg}`])

  const runTest = useCallback(async () => {
    setLoading(true)
    setLog([])
    addLog('Starting...')

    const tests = [
      ['option-contract', { instrument_key: 'NSE_INDEX|Nifty 50' }],
      ['option-chain',    { instrument_key: 'NSE_INDEX|Nifty 50', expiry_date: '2026-06-09' }],
      ['change-oi',       { instrument_key: 'NSE_INDEX|Nifty 50', expiry: '2026-06-09', date: todayStr(), interval: 1 }],
      ['historical',      { to_date: todayStr(), from_date: '2026-06-03' }],
      ['intraday',        {}],
      ['vix-intraday',    {}],
    ]

    for (const [endpoint, params] of tests) {
      try {
        const res = await api(endpoint, params)
        const keys = Object.keys(res?.data || res || {}).slice(0, 3)
        addLog(`✓ ${endpoint} — OK (keys: ${keys.join(', ')})`)
      } catch (e) {
        addLog(`✗ ${endpoint} — ${e.message}`)
      }
    }

    addLog('Done.')
    setLoading(false)
  }, [])

  return (
    <div style={{ background: '#0d1117', minHeight: '100vh', color: '#e2e8f0', fontFamily: 'monospace', padding: 20 }}>
      <h2 style={{ color: '#f8fafc', marginBottom: 16 }}>API Debug</h2>
      <button onClick={runTest} disabled={loading}
        style={{ background: '#1d4ed8', border: 'none', color: '#fff', padding: '10px 24px', borderRadius: 6, fontSize: 14, cursor: 'pointer', marginBottom: 20 }}>
        {loading ? 'Testing...' : 'Run All API Tests'}
      </button>
      <div style={{ fontSize: 13, lineHeight: 2 }}>
        {log.map((l, i) => (
          <div key={i} style={{ color: l.includes('✓') ? '#22c55e' : l.includes('✗') ? '#ef4444' : '#94a3b8' }}>{l}</div>
        ))}
      </div>
    </div>
  )
}
