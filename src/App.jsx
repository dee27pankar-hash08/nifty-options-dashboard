import { useState, useEffect } from 'react'

const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params, _t: Date.now() }).toString()
  const res = await fetch(`/api/upstox?${qs}`, { cache: 'no-store' })
  const json = await res.json()
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`)
  return json
}

const todayStr = () => new Date().toISOString().split('T')[0]

export default function App() {
  const [spot, setSpot] = useState(null)
  const [time, setTime] = useState(null)
  const [err,  setErr]  = useState(null)
  const [count, setCount] = useState(0)

  useEffect(() => {
    setErr(null)
    api('option-chain', { instrument_key: 'NSE_INDEX|Nifty 50', expiry_date: '2026-06-09' })
      .then(res => {
        setSpot(res.data[0].underlying_spot_price)
        setTime(new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata' }))
      })
      .catch(e => setErr(e.message))
  }, [count])

  return (
    <div style={{ background: '#0d1117', minHeight: '100vh', color: '#fff', fontFamily: 'monospace', padding: 24 }}>
      <h2>Refresh Test</h2>
      <p>Spot: {spot ?? 'loading...'}</p>
      <p>Time: {time ?? '—'}</p>
      <p style={{ color: '#ef4444' }}>{err}</p>
      <p style={{ color: '#64748b' }}>Fetch count: {count}</p>
      <button
        onClick={() => setCount(c => c + 1)}
        style={{ background: '#1d4ed8', border: 'none', color: '#fff', padding: '12px 24px', borderRadius: 6, fontSize: 16, cursor: 'pointer', marginTop: 16 }}>
        REFRESH
      </button>
    </div>
  )
}
