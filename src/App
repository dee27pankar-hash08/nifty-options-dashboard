import { useState, useEffect, useCallback, useRef } from 'react'

// ─── API LAYER ────────────────────────────────────────────────────────────────
const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params }).toString()
  const res = await fetch(`/api/upstox?${qs}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

const today = () => new Date().toISOString().split('T')[0]

// ─── SIGNAL ENGINE (mirrors run.py logic) ────────────────────────────────────
const NTM_BAND = 500
const MIN_QUALITY_DELTA = 0.30
const LOT_SIZE = 65
const BUDGET = 10000
const clip = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
const fmtOI = v => Math.abs(v) >= 1e6 ? `${(v/1e6).toFixed(2)}M` : `${(v/1e3).toFixed(0)}K`

function sigPCR(near) {
  const ce = near.reduce((s,r) => s + r.ce_oi, 0)
  const pe = near.reduce((s,r) => s + r.pe_oi, 0)
  const cep = near.reduce((s,r) => s + r.ce_prev_oi, 0)
  const pep = near.reduce((s,r) => s + r.pe_prev_oi, 0)
  const pcr = ce ? +(pe/ce).toFixed(2) : 0
  const pcrPrev = cep ? +(pep/cep).toFixed(2) : pcr
  let vote = clip(0.6*(pcr-1.0)/0.5 + 0.4*(pcr-pcrPrev)/0.2)
  if (pcr > 1.8 || pcr < 0.45) vote *= 0.5
  const dir = vote > 0.1 ? 'bullish' : vote < -0.1 ? 'bearish' : 'neutral'
  const extreme = pcr > 1.8 || pcr < 0.45
  return {
    vote: clip(vote), pcr, pcrPrev,
    reason: `NTM PCR ${pcr} (${pcr > pcrPrev ? 'rising' : 'falling'} from ${pcrPrev}) — ${dir}${extreme ? ' [extreme: reversal risk]' : ''}`
  }
}

function sigBuildup(spot, changeOiData) {
  if (!changeOiData?.call_put_oi_data_list?.length) return { vote: 0, reason: 'OI change — awaiting data', bull: 0, bear: 0 }
  let bull = 0, bear = 0
  for (const s of changeOiData.call_put_oi_data_list) {
    if (Math.abs(s.strike_price - spot) > NTM_BAND) continue
    const { strike_price: sp, call_change_oi: ce, put_change_oi: pe } = s
    if (sp > spot) {
      if (ce > 0) bear += ce; else bull += Math.abs(ce)
      if (pe > 0) bull += pe * 0.3
    } else {
      if (pe > 0) bull += pe; else bear += Math.abs(pe)
      if (ce > 0) bear += ce * 0.3
    }
  }
  const total = bull + bear
  const vote = total ? clip((bull - bear) / total) : 0
  const dir = vote > 0.1 ? 'bullish' : vote < -0.1 ? 'bearish' : 'balanced'
  const totalCe = changeOiData.total_call_change_oi || 0
  const totalPe = changeOiData.total_put_change_oi || 0
  return { vote, bull, bear, totalCe, totalPe, reason: `OI change ${dir}: put support ${fmtOI(bull)} vs call resistance ${fmtOI(bear)} (CE chg ${fmtOI(totalCe)} / PE chg ${fmtOI(totalPe)})` }
}

function sigMaxPain(rows, spot, dte) {
  const pain = {}
  for (const r of rows) {
    let loss = 0
    for (const o of rows) {
      loss += Math.max(0, r.strike - o.strike) * o.ce_oi
      loss += Math.max(0, o.strike - r.strike) * o.pe_oi
    }
    pain[r.strike] = loss
  }
  const mp = +Object.entries(pain).sort((a,b) => a[1]-b[1])[0][0]
  const gap = mp - spot
  const expW = dte <= 1 ? 1.0 : dte <= 2 ? 0.6 : dte <= 4 ? 0.35 : 0.2
  const vote = clip(gap/spot/0.01) * expW
  return { vote, maxPain: mp, expW, reason: `Max pain ${mp} (${gap > 0 ? '+' : ''}${Math.round(gap)} pts) — pull ${gap > 0 ? 'up' : 'down'}, ${dte}d to expiry (wt ${expW})` }
}

function sigWalls(near, spot) {
  if (!near.length) return { vote: 0, R: spot+500, S: spot-500, reason: 'Walls — no near data' }
  const ceMax = near.reduce((best, r) => r.ce_oi > best.ce_oi ? r : best, near[0])
  const peMax = near.reduce((best, r) => r.pe_oi > best.pe_oi ? r : best, near[0])
  const R = ceMax.strike, S = peMax.strike
  if (R - S < 150) return { vote: 0, R, S, reason: `Walls tight (${S}–${R}) — no clean range` }
  const pos = (spot - S) / (R - S)
  const strength = (peMax.pe_oi - ceMax.ce_oi) / (peMax.pe_oi + ceMax.ce_oi)
  const vote = clip(0.8*(0.5-pos)*2 + 0.2*strength)
  const zone = pos < 0.35 ? 'near support' : pos > 0.65 ? 'near resistance' : 'mid-range'
  return { vote, R, S, ceOI: ceMax.ce_oi, peOI: peMax.pe_oi, zone, pos, reason: `Spot ${zone} of ${S}–${R} band (PE ${fmtOI(peMax.pe_oi)} / CE ${fmtOI(ceMax.ce_oi)})` }
}

function sigSkew(rows, spot) {
  const BASELINE = 2.5
  const putRow = rows.reduce((best, r) => Math.abs(r.strike - (spot - NTM_BAND)) < Math.abs(best.strike - (spot - NTM_BAND)) ? r : best, rows[0])
  const callRow = rows.reduce((best, r) => Math.abs(r.strike - (spot + NTM_BAND)) < Math.abs(best.strike - (spot + NTM_BAND)) ? r : best, rows[0])
  if (!putRow || !callRow) return { vote: 0, reason: 'IV skew — insufficient data' }
  const skew = putRow.pe_iv - callRow.ce_iv
  const vote = clip(-(skew - BASELINE) / 4)
  const tone = skew > BASELINE + 1 ? 'downside fear (bearish)' : skew < BASELINE - 1 ? 'call demand (bullish)' : 'normal skew'
  return { vote, skew, putIV: putRow.pe_iv, callIV: callRow.ce_iv, reason: `IV skew ${skew.toFixed(1)} (put ${Math.round(putRow.pe_iv)} vs call ${Math.round(callRow.ce_iv)}) — ${tone}` }
}

function computeBias(rows, spot, dte, changeOiData) {
  const near = rows.filter(r => Math.abs(r.strike - spot) <= NTM_BAND)
  const W = { pcr: 2.0, bld: 1.5, mp: 1.2, wall: 2.0, skew: 1.5 }
  const pcr  = sigPCR(near)
  const bld  = sigBuildup(spot, changeOiData)
  const mp   = sigMaxPain(rows, spot, dte)
  const wall = sigWalls(near, spot)
  const skew = sigSkew(rows, spot)

  const sigs = [
    { v: pcr.vote,  w: W.pcr,  r: pcr.reason  },
    { v: bld.vote,  w: W.bld,  r: bld.reason  },
    { v: mp.vote,   w: W.mp * mp.expW, r: mp.reason },
    { v: wall.vote, w: W.wall, r: wall.reason  },
    { v: skew.vote, w: W.skew, r: skew.reason  },
  ]

  const wsum = sigs.reduce((s, x) => s + x.w, 0)
  const score = sigs.reduce((s, x) => s + x.v * x.w, 0) / wsum
  const sign = score >= 0 ? 1 : -1
  const activeW = sigs.filter(x => Math.abs(x.v) > 0.05).reduce((s, x) => s + x.w, 0)
  const agreeW  = sigs.filter(x => Math.abs(x.v) > 0.05 && (x.v >= 0) === (sign >= 0)).reduce((s, x) => s + x.w, 0)
  const agreement = activeW ? agreeW / activeW : 0.5
  const conviction = Math.round(Math.abs(score) * agreement * 100)

  let bias = 'NEUTRAL'
  if (Math.abs(score) >= 0.15 && conviction >= 20) {
    if (score >= 0.40) bias = 'BULLISH'
    else if (score >= 0.15) bias = 'CAUTIOUSLY BULLISH'
    else if (score <= -0.40) bias = 'BEARISH'
    else bias = 'CAUTIOUSLY BEARISH'
  }

  const ranked = [...sigs].sort((a, b) => Math.abs(b.v*b.w) - Math.abs(a.v*a.w))

  return { bias, conviction, score, reasons: ranked.map(x => x.r),
    pcr: pcr.pcr, maxPain: mp.maxPain, R: wall.R, S: wall.S,
    wallZone: wall.zone, wallPos: wall.pos, bld }
}

function getRecommendation(rows, spot, bias, conviction) {
  const pickBest = (side) => {
    const col = `${side}_ltp`, dcol = `${side}_delta`
    const affordable = rows.filter(r => r[col] * LOT_SIZE <= BUDGET && r[col] > 0.5)
    if (!affordable.length) return null
    affordable.forEach(r => r._absdelta = Math.abs(r[dcol]))
    affordable.sort((a, b) => b._absdelta - a._absdelta || a[col] - b[col])
    const row = affordable[0]
    const cost = row[col] * LOT_SIZE
    const moneyness = side === 'ce' ? spot - row.strike : row.strike - spot
    return {
      strike: row.strike, ltp: row[col], delta: row[dcol],
      theta: row[`${side}_theta`], iv: row[`${side}_iv`],
      cost, lots: Math.floor(BUDGET / cost),
      moneyness: Math.round(moneyness),
      lowQuality: Math.abs(row[dcol]) < MIN_QUALITY_DELTA
    }
  }

  if (bias === 'NEUTRAL' || conviction < 25) {
    for (const r of rows.sort((a,b) => Math.abs(a.strike-spot) - Math.abs(b.strike-spot)).slice(0, 8)) {
      const cost = (r.ce_ltp + r.pe_ltp) * LOT_SIZE
      if (cost <= BUDGET) return { type: 'Straddle', strike: r.strike, ceLtp: r.ce_ltp, peLtp: r.pe_ltp, cost, lots: Math.floor(BUDGET/cost), logic: 'No directional edge — straddle captures a move either way' }
    }
    return { type: 'No Trade', logic: 'Low conviction — stay out' }
  }
  if (bias.includes('BULLISH')) {
    const d = pickBest('ce')
    return { type: 'CE Buy', ...d, logic: d?.lowQuality ? `Budget only allows far-OTM (Δ${Math.abs(d.delta).toFixed(2)}) — consider staying out` : 'Bullish bias — buy closest-to-ITM call within budget' }
  } else {
    const d = pickBest('pe')
    return { type: 'PE Buy', ...d, logic: d?.lowQuality ? `Budget only allows far-OTM (Δ${Math.abs(d.delta).toFixed(2)}) — consider staying out` : 'Bearish bias — buy closest-to-ITM put within budget' }
  }
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData]         = useState(null)
  const [error, setError]       = useState(null)
  const [loading, setLoading]   = useState(false)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [expiry, setExpiry]     = useState(null)
  const [allExpiries, setAllExpiries] = useState([])
  const [marketOpen, setMarketOpen] = useState(false)
  const timerRef = useRef(null)

  const isMarketOpen = () => {
    const now = new Date()
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
    const h = ist.getHours(), m = ist.getMinutes(), d = ist.getDay()
    if (d === 0 || d === 6) return false
    const mins = h * 60 + m
    return mins >= 9*60+15 && mins <= 15*60+30
  }

  const fetchData = useCallback(async (selectedExpiry) => {
    if (!selectedExpiry) return
    setLoading(true)
    setError(null)
    try {
      const [chainRes, changeOiRes] = await Promise.allSettled([
        api('option-chain', { instrument_key: 'NSE_INDEX|Nifty 50', expiry_date: selectedExpiry }),
        api('change-oi', { instrument_key: 'NSE_INDEX|Nifty 50', expiry: selectedExpiry, date: today(), interval: 1 })
      ])

      if (chainRes.status === 'rejected') throw new Error('Option chain fetch failed')
      const chain = chainRes.value.data
      const spot = chain[0].underlying_spot_price
      const changeOiData = changeOiRes.status === 'fulfilled' ? changeOiRes.value.data : null

      // Build rows
      const rows = chain.map(s => ({
        strike: s.strike_price,
        ce_oi: s.call_options.market_data.oi,
        ce_prev_oi: s.call_options.market_data.prev_oi,
        ce_ltp: s.call_options.market_data.ltp,
        ce_close: s.call_options.market_data.close_price,
        ce_iv: s.call_options.option_greeks.iv,
        ce_delta: s.call_options.option_greeks.delta,
        ce_theta: s.call_options.option_greeks.theta,
        pe_oi: s.put_options.market_data.oi,
        pe_prev_oi: s.put_options.market_data.prev_oi,
        pe_ltp: s.put_options.market_data.ltp,
        pe_close: s.put_options.market_data.close_price,
        pe_iv: s.put_options.option_greeks.iv,
        pe_delta: s.put_options.option_greeks.delta,
        pe_theta: s.put_options.option_greeks.theta,
      }))

      // DTE
      const dte = Math.max(0, Math.round((new Date(selectedExpiry) - new Date(today())) / 86400000))

      // Expected move
      const atm = rows.reduce((best, r) => Math.abs(r.strike - spot) < Math.abs(best.strike - spot) ? r : best, rows[0])
      const em = atm.ce_ltp + atm.pe_ltp

      // Top walls
      const near = rows.filter(r => Math.abs(r.strike - spot) <= NTM_BAND)
      const ceWalls = [...near].sort((a,b) => b.ce_oi - a.ce_oi).slice(0,3)
      const peWalls = [...near].sort((a,b) => b.pe_oi - a.pe_oi).slice(0,3)

      const analysis = computeBias(rows, spot, dte, changeOiData)
      const rec = getRecommendation(rows, spot, analysis.bias, analysis.conviction)

      setData({ spot, rows, dte, em, ceWalls, peWalls, analysis, rec, changeOiData })
      setLastUpdate(new Date())
      setMarketOpen(isMarketOpen())
    } catch (e) {
      setError(e.message)
    } finally {
      setLoading(false)
    }
  }, [])

  // Load expiries on mount
  useEffect(() => {
    api('option-contract', { instrument_key: 'NSE_INDEX|Nifty 50' })
      .then(res => {
        const expiries = [...new Set(res.data.map(i => i.expiry))].sort()
        const todayStr = today()
        const nearest = expiries.find(e => e >= todayStr) || expiries[0]
        setAllExpiries(expiries.slice(0, 6))
        setExpiry(nearest)
      })
      .catch(() => setError('Failed to load expiries'))
  }, [])

  // Fetch when expiry changes
  useEffect(() => {
    if (expiry) fetchData(expiry)
  }, [expiry, fetchData])

  // Auto-refresh every 15 min during market hours
  useEffect(() => {
    timerRef.current = setInterval(() => {
      if (isMarketOpen() && expiry) fetchData(expiry)
    }, 15 * 60 * 1000)
    return () => clearInterval(timerRef.current)
  }, [expiry, fetchData])

  const biasColor = {
    'BULLISH': '#22c55e', 'CAUTIOUSLY BULLISH': '#86efac',
    'CAUTIOUSLY BEARISH': '#fb923c', 'BEARISH': '#ef4444', 'NEUTRAL': '#94a3b8'
  }
  const recColor = { 'CE Buy': '#22c55e', 'PE Buy': '#ef4444', 'Straddle': '#fb923c', 'No Trade': '#64748b' }

  const bias = data?.analysis?.bias || 'NEUTRAL'
  const bColor = biasColor[bias] || '#94a3b8'
  const conviction = data?.analysis?.conviction || 0

  return (
    <div style={{ background: '#070a0f', minHeight: '100vh', color: '#e2e8f0', fontFamily: "'JetBrains Mono', monospace", padding: '0 0 80px' }}>

      {/* Header */}
      <div style={{ background: '#0d1117', borderBottom: '1px solid #1e2a3a', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 18, color: '#f8fafc', letterSpacing: '-0.5px' }}>NIFTY OPTIONS</div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
              {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' })} IST` : 'Loading...'}
              {' · '}
              <span style={{ color: marketOpen ? '#22c55e' : '#ef4444' }}>{marketOpen ? '● LIVE' : '● CLOSED'}</span>
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 22, color: '#f8fafc' }}>
              {data ? `₹${data.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
            </div>
            <button onClick={() => expiry && fetchData(expiry)} disabled={loading}
              style={{ background: loading ? '#1e2a3a' : '#1d4ed8', border: 'none', borderRadius: 4, color: '#fff', fontSize: 10, padding: '3px 10px', cursor: loading ? 'default' : 'pointer', fontFamily: 'inherit', marginTop: 2 }}>
              {loading ? 'REFRESHING...' : '↻ REFRESH'}
            </button>
          </div>
        </div>

        {/* Expiry selector */}
        <div style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2 }}>
          {allExpiries.map(e => (
            <button key={e} onClick={() => setExpiry(e)}
              style={{ background: expiry === e ? '#1d4ed8' : '#1e2a3a', border: 'none', borderRadius: 4, color: expiry === e ? '#fff' : '#94a3b8', fontSize: 10, padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {error && (
        <div style={{ margin: 16, padding: 12, background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 8, color: '#fca5a5', fontSize: 12 }}>
          ⚠ {error}
        </div>
      )}

      {data && (
        <>
          {/* Bias + Conviction */}
          <div style={{ margin: '12px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: `1px solid ${bColor}33` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
              <div>
                <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>MARKET BIAS</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 26, color: bColor, lineHeight: 1 }}>{bias}</div>
                <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                  ±{data.em.toFixed(0)} pts exp. move · PCR {data.analysis.pcr} · MP {data.analysis.maxPain}
                </div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>CONVICTION</div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 36, color: conviction >= 50 ? '#22c55e' : conviction >= 30 ? '#fb923c' : '#64748b', lineHeight: 1 }}>{conviction}%</div>
                <div style={{ width: 80, height: 4, background: '#1e2a3a', borderRadius: 2, marginTop: 6, marginLeft: 'auto' }}>
                  <div style={{ width: `${conviction}%`, height: '100%', background: conviction >= 50 ? '#22c55e' : conviction >= 30 ? '#fb923c' : '#475569', borderRadius: 2, transition: 'width 0.5s ease' }} />
                </div>
              </div>
            </div>

            {/* Signals */}
            <div style={{ marginTop: 12, borderTop: '1px solid #1e2a3a', paddingTop: 10 }}>
              {data.analysis.reasons.slice(0,4).map((r, i) => (
                <div key={i} style={{ fontSize: 11, color: i === 0 ? '#cbd5e1' : '#64748b', padding: '3px 0', lineHeight: 1.4 }}>
                  <span style={{ color: '#334155', marginRight: 6 }}>{i+1}.</span>{r}
                </div>
              ))}
            </div>
          </div>

          {/* Channel Visualizer */}
          <div style={{ margin: '10px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: '1px solid #1e2a3a' }}>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 10 }}>CHANNEL POSITION</div>
            <div style={{ position: 'relative', height: 48 }}>
              {/* Track */}
              <div style={{ position: 'absolute', top: 20, left: 0, right: 0, height: 8, background: '#1e2a3a', borderRadius: 4 }}>
                {/* Support zone */}
                <div style={{ position: 'absolute', left: 0, width: '20%', height: '100%', background: '#22c55e22', borderRadius: '4px 0 0 4px' }} />
                {/* Resistance zone */}
                <div style={{ position: 'absolute', right: 0, width: '20%', height: '100%', background: '#ef444422', borderRadius: '0 4px 4px 0' }} />
                {/* Spot position */}
                <div style={{
                  position: 'absolute',
                  left: `${Math.max(2, Math.min(96, (data.analysis.wallPos || 0.5) * 100))}%`,
                  top: '50%', transform: 'translate(-50%, -50%)',
                  width: 14, height: 14, background: bColor, borderRadius: '50%',
                  boxShadow: `0 0 8px ${bColor}88`, zIndex: 2, transition: 'left 0.5s ease'
                }} />
              </div>
              {/* Labels */}
              <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 36 }}>
                <div style={{ fontSize: 11, color: '#22c55e' }}>⬆ {data.analysis.S} <span style={{ color: '#334155', fontSize: 10 }}>support</span></div>
                <div style={{ fontSize: 11, color: '#64748b' }}>{data.analysis.wallZone || 'mid-range'}</div>
                <div style={{ fontSize: 11, color: '#ef4444' }}>{data.analysis.R} ⬇ <span style={{ color: '#334155', fontSize: 10 }}>resist</span></div>
              </div>
            </div>
          </div>

          {/* OI Walls */}
          <div style={{ margin: '10px 12px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
            {[{ title: 'CE WALLS', color: '#ef4444', walls: data.ceWalls, oiKey: 'ce_oi', ltpKey: 'ce_ltp' },
              { title: 'PE WALLS', color: '#22c55e', walls: data.peWalls, oiKey: 'pe_oi', ltpKey: 'pe_ltp' }].map(({ title, color, walls, oiKey, ltpKey }) => (
              <div key={title} style={{ background: '#0d1117', borderRadius: 12, border: '1px solid #1e2a3a', padding: 12 }}>
                <div style={{ fontSize: 10, color, marginBottom: 8, fontWeight: 700 }}>{title}</div>
                {walls.map((w, i) => (
                  <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < 2 ? '1px solid #0f172a' : 'none' }}>
                    <div style={{ fontSize: 12, color: '#e2e8f0' }}>{w.strike}</div>
                    <div style={{ fontSize: 11, color }}>{fmtOI(w[oiKey])}</div>
                  </div>
                ))}
              </div>
            ))}
          </div>

          {/* Recommendation */}
          <div style={{ margin: '10px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: `1px solid ${recColor[data.rec.type] || '#334155'}44` }}>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 10 }}>RECOMMENDED TRADE · Budget ₹{BUDGET.toLocaleString('en-IN')}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontFamily: "'Syne', sans-serif", fontWeight: 800, fontSize: 20, color: recColor[data.rec.type] || '#64748b' }}>{data.rec.type}</div>
                {data.rec.strike && (
                  <div style={{ fontSize: 22, fontWeight: 700, color: '#f8fafc', marginTop: 2 }}>
                    {data.rec.strike}{data.rec.type === 'CE Buy' ? 'C' : data.rec.type === 'PE Buy' ? 'P' : ''}
                  </div>
                )}
              </div>
              {data.rec.cost && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 14, color: '#94a3b8' }}>₹{data.rec.cost.toLocaleString('en-IN', { maximumFractionDigits: 0 })}<span style={{ fontSize: 10 }}>/lot</span></div>
                  <div style={{ fontSize: 16, color: '#f8fafc', fontWeight: 700 }}>{data.rec.lots} lot{data.rec.lots > 1 ? 's' : ''}</div>
                </div>
              )}
            </div>
            {data.rec.ltp && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>
                LTP ₹{data.rec.ltp} · Δ {Math.abs(data.rec.delta).toFixed(2)} · {Math.abs(data.rec.moneyness)} pts {data.rec.moneyness >= 0 ? 'ITM' : 'OTM'} · θ {data.rec.theta?.toFixed(0)}/day · IV {data.rec.iv?.toFixed(0)}
              </div>
            )}
            {data.rec.ceLtp && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>
                CE ₹{data.rec.ceLtp} + PE ₹{data.rec.peLtp}
              </div>
            )}
            <div style={{ marginTop: 8, fontSize: 11, color: '#334155', fontStyle: 'italic' }}>{data.rec.logic}</div>
            {data.rec.lowQuality && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#fb923c' }}>⚠ Far-OTM — low probability strike</div>
            )}
            {data.dte <= 2 && data.rec.type !== 'No Trade' && (
              <div style={{ marginTop: 6, fontSize: 11, color: '#fb923c' }}>⚠ {data.dte}d to expiry — steep theta decay</div>
            )}
          </div>

          {/* OI Change summary */}
          {data.analysis.bld?.bull > 0 && (
            <div style={{ margin: '10px 12px 0', padding: 14, background: '#0d1117', borderRadius: 12, border: '1px solid #1e2a3a' }}>
              <div style={{ fontSize: 10, color: '#475569', marginBottom: 8 }}>OI CHANGE (TODAY vs YESTERDAY)</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
                <div style={{ background: '#052e16', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#4ade80' }}>PUT SUPPORT</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e', marginTop: 2 }}>{fmtOI(data.analysis.bld.bull)}</div>
                </div>
                <div style={{ background: '#2d0a0a', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                  <div style={{ fontSize: 10, color: '#f87171' }}>CALL RESIST</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: '#ef4444', marginTop: 2 }}>{fmtOI(data.analysis.bld.bear)}</div>
                </div>
              </div>
              <div style={{ marginTop: 8, fontSize: 11, color: '#334155', display: 'flex', justifyContent: 'space-between' }}>
                <span>Total CE chg: {fmtOI(data.analysis.bld.totalCe)}</span>
                <span>Total PE chg: {fmtOI(data.analysis.bld.totalPe)}</span>
              </div>
            </div>
          )}

          {/* Footer */}
          <div style={{ margin: '16px 12px 0', fontSize: 10, color: '#1e2a3a', textAlign: 'center' }}>
            Refreshes every 15 min during market hours · Positioning-based, not financial advice
          </div>
        </>
      )}

      {!data && !error && !loading && (
        <div style={{ textAlign: 'center', marginTop: 80, color: '#334155', fontSize: 14 }}>Loading market data...</div>
      )}
    </div>
  )
}
