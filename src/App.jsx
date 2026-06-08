import { useState, useEffect, useCallback, useRef } from 'react'

// ─── API LAYER ────────────────────────────────────────────────────────────────
const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params }).toString()
  const res = await fetch(`/api/upstox?${qs}`)
  if (!res.ok) throw new Error(`API ${res.status}`)
  return res.json()
}

const todayStr = () => new Date().toISOString().split('T')[0]
const prevDayStr = () => {
  const d = new Date(); d.setDate(d.getDate() - 1)
  // skip weekend
  if (d.getDay() === 0) d.setDate(d.getDate() - 2)
  if (d.getDay() === 6) d.setDate(d.getDate() - 1)
  return d.toISOString().split('T')[0]
}

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
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
  const extreme = pcr > 1.8 || pcr < 0.45
  if (extreme) vote *= 0.5
  const dir = vote > 0.1 ? 'bullish' : vote < -0.1 ? 'bearish' : 'neutral'
  return { vote: clip(vote), pcr, pcrPrev, reason: `NTM PCR ${pcr} (${pcr > pcrPrev ? 'rising' : 'falling'} from ${pcrPrev}) — ${dir}${extreme ? ' [extreme: reversal risk]' : ''}` }
}

function sigBuildup(spot, changeOiData) {
  if (!changeOiData?.call_put_oi_data_list?.length) return { vote: 0, reason: 'OI change — awaiting data', bull: 0, bear: 0 }
  let bull = 0, bear = 0
  for (const s of changeOiData.call_put_oi_data_list) {
    if (Math.abs(s.strike_price - spot) > NTM_BAND) continue
    const { strike_price: sp, call_change_oi: ce, put_change_oi: pe } = s
    if (sp > spot) { if (ce > 0) bear += ce; else bull += Math.abs(ce); if (pe > 0) bull += pe * 0.3 }
    else { if (pe > 0) bull += pe; else bear += Math.abs(pe); if (ce > 0) bear += ce * 0.3 }
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
  for (const r of rows) { let loss = 0; for (const o of rows) { loss += Math.max(0, r.strike - o.strike) * o.ce_oi; loss += Math.max(0, o.strike - r.strike) * o.pe_oi }; pain[r.strike] = loss }
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
  const putRow = rows.reduce((best, r) => Math.abs(r.strike-(spot-NTM_BAND)) < Math.abs(best.strike-(spot-NTM_BAND)) ? r : best, rows[0])
  const callRow = rows.reduce((best, r) => Math.abs(r.strike-(spot+NTM_BAND)) < Math.abs(best.strike-(spot+NTM_BAND)) ? r : best, rows[0])
  if (!putRow || !callRow) return { vote: 0, reason: 'IV skew — insufficient data' }
  const skew = putRow.pe_iv - callRow.ce_iv
  const vote = clip(-(skew - BASELINE) / 4)
  const tone = skew > BASELINE+1 ? 'downside fear (bearish)' : skew < BASELINE-1 ? 'call demand (bullish)' : 'normal skew'
  return { vote, skew, reason: `IV skew ${skew.toFixed(1)} (put ${Math.round(putRow.pe_iv)} vs call ${Math.round(callRow.ce_iv)}) — ${tone}` }
}

// ── NEW: VIX signal ──────────────────────────────────────────────────────────
function sigVix(vix) {
  if (!vix) return { vote: 0, vix: null, reason: 'VIX — data unavailable', zone: 'unknown' }
  // VIX < 13 = low fear, options cheap = good to buy
  // VIX 13-16 = normal
  // VIX > 16 = elevated fear, options expensive, reduce size
  // VIX > 20 = extreme, avoid buying options
  let vote = 0, zone = '', note = ''
  if (vix < 13) { vote = 0.3; zone = 'LOW'; note = 'options cheap — good for buying' }
  else if (vix <= 16) { vote = 0.1; zone = 'NORMAL'; note = 'normal premium levels' }
  else if (vix <= 20) { vote = -0.2; zone = 'ELEVATED'; note = 'expensive premiums — size down' }
  else { vote = -0.5; zone = 'HIGH'; note = 'very expensive — avoid buying options' }
  return { vote, vix, zone, note, reason: `India VIX ${vix.toFixed(1)} (${zone}) — ${note}` }
}

// ── NEW: PDH/PDL signal ───────────────────────────────────────────────────────
function sigPDHL(spot, pdh, pdl) {
  if (!pdh || !pdl) return { vote: 0, pdh: null, pdl: null, reason: 'PDH/PDL — data unavailable' }
  const range = pdh - pdl
  const pos = (spot - pdl) / range  // 0 = at PDL, 1 = at PDH
  // Near PDH = resistance (bearish lean), near PDL = support (bullish lean)
  const vote = clip((0.5 - pos) * 2)
  const distPDH = Math.round(pdh - spot)
  const distPDL = Math.round(spot - pdl)
  const zone = pos > 0.8 ? 'near PDH — resistance' : pos < 0.2 ? 'near PDL — support' : 'mid-range'
  return { vote, pdh, pdl, distPDH, distPDL, reason: `PDH ${pdh} (+${distPDH} pts above) / PDL ${pdl} (-${distPDL} pts below) — ${zone}` }
}

// ── NEW: Trend / time filter ──────────────────────────────────────────────────
function getTrendContext(candles, spot) {
  if (!candles || candles.length < 2) return { trend: 'unknown', trendVote: 0, timeWarning: null }
  // Last two 30min candles — is price trending up or down?
  const last = candles[candles.length - 1]   // [ts, o, h, l, c, v, oi]
  const prev = candles[candles.length - 2]
  const lastClose = last[4], prevClose = prev[4]
  const trendVote = lastClose > prevClose ? 0.3 : lastClose < prevClose ? -0.3 : 0
  const trend = lastClose > prevClose ? 'up' : lastClose < prevClose ? 'down' : 'flat'

  // Time filter — IST
  const now = new Date()
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const h = ist.getHours(), m = ist.getMinutes()
  const mins = h * 60 + m
  let timeWarning = null
  if (mins < 9*60+45) timeWarning = 'Opening volatility window (9:15–9:45) — wait for settlement'
  else if (mins > 14*60+45) timeWarning = 'Last 45 mins — theta collapse, avoid buying options'

  return { trend, trendVote, timeWarning, lastClose, prevClose }
}

function computeBias(rows, spot, dte, changeOiData, vix, pdh, pdl, candles) {
  const near = rows.filter(r => Math.abs(r.strike - spot) <= NTM_BAND)
  const pcr  = sigPCR(near)
  const bld  = sigBuildup(spot, changeOiData)
  const mp   = sigMaxPain(rows, spot, dte)
  const wall = sigWalls(near, spot)
  const skew = sigSkew(rows, spot)
  const vixS = sigVix(vix)
  const pdhl = sigPDHL(spot, pdh, pdl)
  const tctx = getTrendContext(candles, spot)

  const W = { pcr: 2.0, bld: 1.5, mp: 1.2, wall: 2.0, skew: 1.5, vix: 1.0, pdhl: 1.5, trend: 0.8 }
  const sigs = [
    { v: pcr.vote,        w: W.pcr,   r: pcr.reason  },
    { v: bld.vote,        w: W.bld,   r: bld.reason  },
    { v: mp.vote,         w: W.mp * mp.expW, r: mp.reason },
    { v: wall.vote,       w: W.wall,  r: wall.reason  },
    { v: skew.vote,       w: W.skew,  r: skew.reason  },
    { v: vixS.vote,       w: W.vix,   r: vixS.reason  },
    { v: pdhl.vote,       w: W.pdhl,  r: pdhl.reason  },
    { v: tctx.trendVote,  w: W.trend, r: `30min trend ${tctx.trend} (${tctx.lastClose?.toFixed(0)} vs ${tctx.prevClose?.toFixed(0)})` },
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
    wallZone: wall.zone, wallPos: wall.pos, bld,
    vixData: vixS, pdhlData: pdhl, trendCtx: tctx }
}

function getRecommendation(rows, spot, bias, conviction, vix, timeWarning) {
  // Hard blocks
  if (timeWarning) return { type: 'Wait', logic: timeWarning }
  if (vix && vix > 20) return { type: 'No Trade', logic: `VIX ${vix.toFixed(1)} too high — option premiums too expensive to buy` }

  const pickBest = (side) => {
    const col = `${side}_ltp`, dcol = `${side}_delta`
    const affordable = rows.filter(r => r[col] * LOT_SIZE <= BUDGET && r[col] > 0.5)
    if (!affordable.length) return null
    affordable.forEach(r => r._absdelta = Math.abs(r[dcol]))
    affordable.sort((a, b) => b._absdelta - a._absdelta || a[col] - b[col])
    const row = affordable[0]
    const cost = row[col] * LOT_SIZE
    const moneyness = side === 'ce' ? spot - row.strike : row.strike - spot
    return { strike: row.strike, ltp: row[col], delta: row[dcol], theta: row[`${side}_theta`], iv: row[`${side}_iv`], cost, lots: Math.floor(BUDGET / cost), moneyness: Math.round(moneyness), lowQuality: Math.abs(row[dcol]) < MIN_QUALITY_DELTA }
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
    return { type: 'CE Buy', ...d, logic: d?.lowQuality ? `Budget allows far-OTM only (Δ${Math.abs(d.delta).toFixed(2)}) — consider skipping` : 'Bullish bias — closest-to-ITM call within budget' }
  } else {
    const d = pickBest('pe')
    return { type: 'PE Buy', ...d, logic: d?.lowQuality ? `Budget allows far-OTM only (Δ${Math.abs(d.delta).toFixed(2)}) — consider skipping` : 'Bearish bias — closest-to-ITM put within budget' }
  }
}

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [data, setData]             = useState(null)
  const [error, setError]           = useState(null)
  const [loading, setLoading]       = useState(false)
  const [lastUpdate, setLastUpdate] = useState(null)
  const [expiry, setExpiry]         = useState(null)
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

    // Safety net — loading never stuck more than 20 seconds
    const safetyTimer = setTimeout(() => setLoading(false), 20000)

    try {
      // For PDH/PDL: get last 5 days of daily candles to handle weekends
      const to = todayStr()
      const from = (() => { const d = new Date(); d.setDate(d.getDate() - 5); return d.toISOString().split('T')[0] })()

      const [chainRes, changeOiRes, historicalRes, intradayRes, vixRes] = await Promise.allSettled([
        api('option-chain', { instrument_key: 'NSE_INDEX|Nifty 50', expiry_date: selectedExpiry }),
        api('change-oi', { instrument_key: 'NSE_INDEX|Nifty 50', expiry: selectedExpiry, date: todayStr(), interval: 1 }),
        api('historical', { to_date: to, from_date: from }),
        api('intraday'),
        api('vix-intraday'),
      ])

      if (chainRes.status === 'rejected') throw new Error('Option chain fetch failed')
      const chain = chainRes.value.data
      const spot = chain[0].underlying_spot_price
      const changeOiData = changeOiRes.status === 'fulfilled' ? changeOiRes.value.data : null

      // PDH/PDL from historical daily — take the most recent completed candle (yesterday)
      let pdh = null, pdl = null
      if (historicalRes.status === 'fulfilled') {
        const candles = historicalRes.value?.data?.candles
        if (candles?.length) {
          // candles sorted newest first — [ts, o, h, l, c, v, oi]
          const prev = candles[0]
          pdh = prev[2]; pdl = prev[3]
        }
      }

      // Intraday 30min candles for trend
      let candles = null
      if (intradayRes.status === 'fulfilled') candles = intradayRes.value?.data?.candles || null

      // VIX from last candle
      let vix = null
      if (vixRes.status === 'fulfilled') {
        const vixCandles = vixRes.value?.data?.candles
        if (vixCandles?.length) vix = vixCandles[vixCandles.length - 1][4] // close
      }

      const rows = chain.map(s => ({
        strike: s.strike_price,
        ce_oi: s.call_options.market_data.oi, ce_prev_oi: s.call_options.market_data.prev_oi,
        ce_ltp: s.call_options.market_data.ltp, ce_close: s.call_options.market_data.close_price,
        ce_iv: s.call_options.option_greeks.iv, ce_delta: s.call_options.option_greeks.delta, ce_theta: s.call_options.option_greeks.theta,
        pe_oi: s.put_options.market_data.oi, pe_prev_oi: s.put_options.market_data.prev_oi,
        pe_ltp: s.put_options.market_data.ltp, pe_close: s.put_options.market_data.close_price,
        pe_iv: s.put_options.option_greeks.iv, pe_delta: s.put_options.option_greeks.delta, pe_theta: s.put_options.option_greeks.theta,
      }))

      const dte = Math.max(0, Math.round((new Date(selectedExpiry) - new Date(todayStr())) / 86400000))
      const atm = rows.reduce((best, r) => Math.abs(r.strike-spot) < Math.abs(best.strike-spot) ? r : best, rows[0])
      const em = atm.ce_ltp + atm.pe_ltp
      const near = rows.filter(r => Math.abs(r.strike-spot) <= NTM_BAND)
      const ceWalls = [...near].sort((a,b) => b.ce_oi - a.ce_oi).slice(0,3)
      const peWalls = [...near].sort((a,b) => b.pe_oi - a.pe_oi).slice(0,3)

      const analysis = computeBias(rows, spot, dte, changeOiData, vix, pdh, pdl, candles)
      const rec = getRecommendation(rows, spot, analysis.bias, analysis.conviction, vix, analysis.trendCtx.timeWarning)

      setData({ spot, rows, dte, em, ceWalls, peWalls, analysis, rec, vix, pdh, pdl, candles })
      setLastUpdate(new Date())
      setMarketOpen(isMarketOpen())
    } catch (e) {
      console.error('fetchData error:', e)
      setError(e.message || 'Unknown error — check console')
    } finally {
      clearTimeout(safetyTimer)
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    api('option-contract', { instrument_key: 'NSE_INDEX|Nifty 50' })
      .then(res => {
        const expiries = [...new Set(res.data.map(i => i.expiry))].sort()
        const nearest = expiries.find(e => e >= todayStr()) || expiries[0]
        setAllExpiries(expiries.slice(0, 6)); setExpiry(nearest)
      }).catch(() => setError('Failed to load expiries'))
  }, [])

  useEffect(() => { if (expiry) fetchData(expiry) }, [expiry, fetchData])

  useEffect(() => {
    timerRef.current = setInterval(() => { if (isMarketOpen() && expiry) fetchData(expiry) }, 15*60*1000)
    return () => clearInterval(timerRef.current)
  }, [expiry, fetchData])

  const biasColor = { 'BULLISH':'#22c55e','CAUTIOUSLY BULLISH':'#86efac','CAUTIOUSLY BEARISH':'#fb923c','BEARISH':'#ef4444','NEUTRAL':'#94a3b8' }
  const recColor  = { 'CE Buy':'#22c55e','PE Buy':'#ef4444','Straddle':'#fb923c','No Trade':'#64748b','Wait':'#f59e0b' }
  const bias = data?.analysis?.bias || 'NEUTRAL'
  const bColor = biasColor[bias] || '#94a3b8'
  const conviction = data?.analysis?.conviction || 0

  return (
    <div style={{ background:'#070a0f', minHeight:'100vh', color:'#e2e8f0', fontFamily:"'JetBrains Mono', monospace", padding:'0 0 80px' }}>

      {/* Header */}
      <div style={{ background:'#0d1117', borderBottom:'1px solid #1e2a3a', padding:'14px 16px', position:'sticky', top:0, zIndex:10 }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
          <div>
            <div style={{ fontFamily:"'Syne', sans-serif", fontWeight:800, fontSize:18, color:'#f8fafc', letterSpacing:'-0.5px' }}>NIFTY OPTIONS</div>
            <div style={{ fontSize:10, color:'#475569', marginTop:1 }}>
              {lastUpdate ? `Updated ${lastUpdate.toLocaleTimeString('en-IN', { hour:'2-digit', minute:'2-digit', timeZone:'Asia/Kolkata' })} IST` : 'Loading...'}
              {' · '}<span style={{ color: marketOpen ? '#22c55e' : '#ef4444' }}>{marketOpen ? '● LIVE' : '● CLOSED'}</span>
              {data?.vix && <span style={{ marginLeft:8, color: data.vix > 16 ? '#fb923c' : '#64748b' }}>VIX {data.vix.toFixed(1)}</span>}
            </div>
          </div>
          <div style={{ textAlign:'right' }}>
            <div style={{ fontFamily:"'Syne', sans-serif", fontWeight:800, fontSize:22, color:'#f8fafc' }}>
              {data ? `₹${data.spot.toLocaleString('en-IN', { minimumFractionDigits:2 })}` : '—'}
            </div>
            <button onClick={() => { setError(null); expiry && fetchData(expiry) }} disabled={loading}
              style={{ background: loading?'#1e2a3a':'#1d4ed8', border:'none', borderRadius:4, color:'#fff', fontSize:10, padding:'3px 10px', cursor: loading?'default':'pointer', fontFamily:'inherit', marginTop:2 }}>
              {loading ? 'LOADING...' : '↻ REFRESH'}
            </button>
          </div>
        </div>
        <div style={{ display:'flex', gap:6, marginTop:10, overflowX:'auto', paddingBottom:2 }}>
          {allExpiries.map(e => (
            <button key={e} onClick={() => setExpiry(e)}
              style={{ background: expiry===e?'#1d4ed8':'#1e2a3a', border:'none', borderRadius:4, color: expiry===e?'#fff':'#94a3b8', fontSize:10, padding:'5px 10px', cursor:'pointer', whiteSpace:'nowrap', fontFamily:'inherit' }}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {error && <div style={{ margin:16, padding:12, background:'#1c0a0a', border:'1px solid #7f1d1d', borderRadius:8, color:'#fca5a5', fontSize:12 }}>⚠ {error}</div>}

      {data && (<>

        {/* Time warning banner */}
        {data.analysis.trendCtx.timeWarning && (
          <div style={{ margin:'12px 12px 0', padding:'10px 14px', background:'#1c1400', border:'1px solid #92400e', borderRadius:8, color:'#fbbf24', fontSize:12 }}>
            ⏰ {data.analysis.trendCtx.timeWarning}
          </div>
        )}

        {/* Bias + Conviction */}
        <div style={{ margin:'12px 12px 0', padding:16, background:'#0d1117', borderRadius:12, border:`1px solid ${bColor}33` }}>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'flex-start' }}>
            <div>
              <div style={{ fontSize:10, color:'#475569', marginBottom:4 }}>MARKET BIAS</div>
              <div style={{ fontFamily:"'Syne', sans-serif", fontWeight:800, fontSize:26, color:bColor, lineHeight:1 }}>{bias}</div>
              <div style={{ fontSize:11, color:'#64748b', marginTop:6 }}>±{data.em.toFixed(0)} pts exp. move · PCR {data.analysis.pcr} · MP {data.analysis.maxPain}</div>
            </div>
            <div style={{ textAlign:'right' }}>
              <div style={{ fontSize:10, color:'#475569', marginBottom:4 }}>CONVICTION</div>
              <div style={{ fontFamily:"'Syne', sans-serif", fontWeight:800, fontSize:36, color: conviction>=50?'#22c55e':conviction>=30?'#fb923c':'#64748b', lineHeight:1 }}>{conviction}%</div>
              <div style={{ width:80, height:4, background:'#1e2a3a', borderRadius:2, marginTop:6, marginLeft:'auto' }}>
                <div style={{ width:`${conviction}%`, height:'100%', background: conviction>=50?'#22c55e':conviction>=30?'#fb923c':'#475569', borderRadius:2, transition:'width 0.5s ease' }} />
              </div>
            </div>
          </div>
          <div style={{ marginTop:12, borderTop:'1px solid #1e2a3a', paddingTop:10 }}>
            {data.analysis.reasons.slice(0,5).map((r, i) => (
              <div key={i} style={{ fontSize:11, color: i===0?'#cbd5e1':'#64748b', padding:'3px 0', lineHeight:1.4 }}>
                <span style={{ color:'#334155', marginRight:6 }}>{i+1}.</span>{r}
              </div>
            ))}
          </div>
        </div>

        {/* VIX + PDH/PDL + Trend row */}
        <div style={{ margin:'10px 12px 0', display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:8 }}>
          {/* VIX */}
          <div style={{ background:'#0d1117', borderRadius:10, border:'1px solid #1e2a3a', padding:'10px 12px' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>INDIA VIX</div>
            <div style={{ fontSize:20, fontWeight:700, color: data.vix > 16 ? '#fb923c' : data.vix < 13 ? '#22c55e' : '#94a3b8' }}>
              {data.vix ? data.vix.toFixed(1) : '—'}
            </div>
            <div style={{ fontSize:9, color:'#475569', marginTop:2 }}>
              {data.analysis.vixData.zone || '—'}
            </div>
          </div>
          {/* PDH/PDL */}
          <div style={{ background:'#0d1117', borderRadius:10, border:'1px solid #1e2a3a', padding:'10px 12px' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>PDH / PDL</div>
            <div style={{ fontSize:12, color:'#ef4444' }}>{data.pdh ? data.pdh.toFixed(0) : '—'}</div>
            <div style={{ fontSize:12, color:'#22c55e' }}>{data.pdl ? data.pdl.toFixed(0) : '—'}</div>
            <div style={{ fontSize:9, color:'#475569', marginTop:2 }}>high / low</div>
          </div>
          {/* Trend */}
          <div style={{ background:'#0d1117', borderRadius:10, border:'1px solid #1e2a3a', padding:'10px 12px' }}>
            <div style={{ fontSize:9, color:'#475569', marginBottom:4 }}>30M TREND</div>
            <div style={{ fontSize:20, fontWeight:700, color: data.analysis.trendCtx.trend==='up'?'#22c55e':data.analysis.trendCtx.trend==='down'?'#ef4444':'#94a3b8' }}>
              {data.analysis.trendCtx.trend==='up' ? '↑' : data.analysis.trendCtx.trend==='down' ? '↓' : '→'}
            </div>
            <div style={{ fontSize:9, color:'#475569', marginTop:2 }}>{data.analysis.trendCtx.trend}</div>
          </div>
        </div>

        {/* Channel Visualizer */}
        <div style={{ margin:'10px 12px 0', padding:16, background:'#0d1117', borderRadius:12, border:'1px solid #1e2a3a' }}>
          <div style={{ fontSize:10, color:'#475569', marginBottom:10 }}>CHANNEL POSITION</div>
          <div style={{ position:'relative', height:48 }}>
            <div style={{ position:'absolute', top:20, left:0, right:0, height:8, background:'#1e2a3a', borderRadius:4 }}>
              <div style={{ position:'absolute', left:0, width:'20%', height:'100%', background:'#22c55e22', borderRadius:'4px 0 0 4px' }} />
              <div style={{ position:'absolute', right:0, width:'20%', height:'100%', background:'#ef444422', borderRadius:'0 4px 4px 0' }} />
              {/* PDH/PDL markers */}
              {data.pdh && data.pdl && data.analysis.S && data.analysis.R && (() => {
                const S = data.analysis.S, R = data.analysis.R
                const pdhPct = Math.max(0, Math.min(100, (data.pdh - S) / (R - S) * 100))
                const pdlPct = Math.max(0, Math.min(100, (data.pdl - S) / (R - S) * 100))
                return (<>
                  <div style={{ position:'absolute', left:`${pdhPct}%`, top:-4, width:2, height:16, background:'#ef444466', borderRadius:1 }} title={`PDH ${data.pdh}`} />
                  <div style={{ position:'absolute', left:`${pdlPct}%`, top:-4, width:2, height:16, background:'#22c55e66', borderRadius:1 }} title={`PDL ${data.pdl}`} />
                </>)
              })()}
              <div style={{ position:'absolute', left:`${Math.max(2, Math.min(96, (data.analysis.wallPos||0.5)*100))}%`, top:'50%', transform:'translate(-50%,-50%)', width:14, height:14, background:bColor, borderRadius:'50%', boxShadow:`0 0 8px ${bColor}88`, zIndex:2, transition:'left 0.5s ease' }} />
            </div>
            <div style={{ display:'flex', justifyContent:'space-between', marginTop:36 }}>
              <div style={{ fontSize:11, color:'#22c55e' }}>⬆ {data.analysis.S} <span style={{ color:'#334155', fontSize:10 }}>support</span></div>
              <div style={{ fontSize:11, color:'#64748b' }}>{data.analysis.wallZone||'mid-range'}</div>
              <div style={{ fontSize:11, color:'#ef4444' }}>{data.analysis.R} ⬇ <span style={{ color:'#334155', fontSize:10 }}>resist</span></div>
            </div>
          </div>
        </div>

        {/* OI Walls */}
        <div style={{ margin:'10px 12px 0', display:'grid', gridTemplateColumns:'1fr 1fr', gap:10 }}>
          {[{ title:'CE WALLS', color:'#ef4444', walls:data.ceWalls, oiKey:'ce_oi', ltpKey:'ce_ltp' },
            { title:'PE WALLS', color:'#22c55e', walls:data.peWalls, oiKey:'pe_oi', ltpKey:'pe_ltp' }].map(({ title, color, walls, oiKey }) => (
            <div key={title} style={{ background:'#0d1117', borderRadius:12, border:'1px solid #1e2a3a', padding:12 }}>
              <div style={{ fontSize:10, color, marginBottom:8, fontWeight:700 }}>{title}</div>
              {walls.map((w, i) => (
                <div key={i} style={{ display:'flex', justifyContent:'space-between', padding:'4px 0', borderBottom: i<2?'1px solid #0f172a':'none' }}>
                  <div style={{ fontSize:12, color:'#e2e8f0' }}>{w.strike}</div>
                  <div style={{ fontSize:11, color }}>{fmtOI(w[oiKey])}</div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Recommendation */}
        <div style={{ margin:'10px 12px 0', padding:16, background:'#0d1117', borderRadius:12, border:`1px solid ${recColor[data.rec.type]||'#334155'}44` }}>
          <div style={{ fontSize:10, color:'#475569', marginBottom:10 }}>RECOMMENDED TRADE · Budget ₹{BUDGET.toLocaleString('en-IN')}</div>
          <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center' }}>
            <div>
              <div style={{ fontFamily:"'Syne', sans-serif", fontWeight:800, fontSize:20, color:recColor[data.rec.type]||'#64748b' }}>{data.rec.type}</div>
              {data.rec.strike && <div style={{ fontSize:22, fontWeight:700, color:'#f8fafc', marginTop:2 }}>{data.rec.strike}{data.rec.type==='CE Buy'?'C':data.rec.type==='PE Buy'?'P':''}</div>}
            </div>
            {data.rec.cost && (
              <div style={{ textAlign:'right' }}>
                <div style={{ fontSize:14, color:'#94a3b8' }}>₹{data.rec.cost.toLocaleString('en-IN', { maximumFractionDigits:0 })}<span style={{ fontSize:10 }}>/lot</span></div>
                <div style={{ fontSize:16, color:'#f8fafc', fontWeight:700 }}>{data.rec.lots} lot{data.rec.lots>1?'s':''}</div>
              </div>
            )}
          </div>
          {data.rec.ltp && <div style={{ marginTop:8, fontSize:11, color:'#475569' }}>LTP ₹{data.rec.ltp} · Δ {Math.abs(data.rec.delta).toFixed(2)} · {Math.abs(data.rec.moneyness)} pts {data.rec.moneyness>=0?'ITM':'OTM'} · θ {data.rec.theta?.toFixed(0)}/day · IV {data.rec.iv?.toFixed(0)}</div>}
          {data.rec.ceLtp && <div style={{ marginTop:8, fontSize:11, color:'#475569' }}>CE ₹{data.rec.ceLtp} + PE ₹{data.rec.peLtp}</div>}
          <div style={{ marginTop:8, fontSize:11, color:'#334155', fontStyle:'italic' }}>{data.rec.logic}</div>
          {data.rec.lowQuality && <div style={{ marginTop:6, fontSize:11, color:'#fb923c' }}>⚠ Far-OTM — low probability strike</div>}
          {data.dte <= 2 && data.rec.type !== 'No Trade' && data.rec.type !== 'Wait' && <div style={{ marginTop:6, fontSize:11, color:'#fb923c' }}>⚠ {data.dte}d to expiry — steep theta decay</div>}
        </div>

        {/* OI Change */}
        {data.analysis.bld?.bull > 0 && (
          <div style={{ margin:'10px 12px 0', padding:14, background:'#0d1117', borderRadius:12, border:'1px solid #1e2a3a' }}>
            <div style={{ fontSize:10, color:'#475569', marginBottom:8 }}>OI CHANGE (TODAY vs YESTERDAY)</div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:8 }}>
              <div style={{ background:'#052e16', borderRadius:8, padding:10, textAlign:'center' }}>
                <div style={{ fontSize:10, color:'#4ade80' }}>PUT SUPPORT</div>
                <div style={{ fontSize:16, fontWeight:700, color:'#22c55e', marginTop:2 }}>{fmtOI(data.analysis.bld.bull)}</div>
              </div>
              <div style={{ background:'#2d0a0a', borderRadius:8, padding:10, textAlign:'center' }}>
                <div style={{ fontSize:10, color:'#f87171' }}>CALL RESIST</div>
                <div style={{ fontSize:16, fontWeight:700, color:'#ef4444', marginTop:2 }}>{fmtOI(data.analysis.bld.bear)}</div>
              </div>
            </div>
            <div style={{ marginTop:8, fontSize:11, color:'#334155', display:'flex', justifyContent:'space-between' }}>
              <span>Total CE chg: {fmtOI(data.analysis.bld.totalCe)}</span>
              <span>Total PE chg: {fmtOI(data.analysis.bld.totalPe)}</span>
            </div>
          </div>
        )}

        <div style={{ margin:'16px 12px 0', fontSize:10, color:'#1e2a3a', textAlign:'center' }}>
          Refreshes every 15 min during market hours · Positioning-based, not financial advice
        </div>
      </>)}
    </div>
  )
}
