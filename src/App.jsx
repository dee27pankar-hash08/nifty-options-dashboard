import { useState, useEffect, useRef, useMemo } from 'react'

const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params, _t: Date.now() }).toString()
  const res = await fetch(`/api/upstox?${qs}`, { cache: 'no-store' })
  const json = await res.json()
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`)
  return json
}

const todayStr = () => new Date().toISOString().split('T')[0]
const NTM = 500, LOT = 65
const clip = (x, lo = -1, hi = 1) => Math.max(lo, Math.min(hi, x))
const fmtOI = v => Math.abs(v) >= 1e6 ? `${(v / 1e6).toFixed(2)}M` : `${(v / 1e3).toFixed(0)}K`
const safe = (fn, fallback = null) => { try { return fn() } catch { return fallback } }

// IST time helpers — all time logic uses Asia/Kolkata
const getISTMins = () => {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  return ist.getHours() * 60 + ist.getMinutes()
}
const isOpen = () => {
  const ist = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }))
  const d = ist.getDay(), m = ist.getHours() * 60 + ist.getMinutes()
  return d >= 1 && d <= 5 && m >= 9 * 60 + 15 && m <= 15 * 60 + 30
}

// ── OI STRUCTURE ANALYSIS ─────────────────────────────────────────────────────
// Reads the full OI gradient instead of a single wall.
// Market structure is layered: multiple CE/PE OI levels across strikes.
// Price moves through these layers like a ball through sand.
function analyzeOIStructure(rows, spot, oiData) {
  // Build a clean per-strike OI map within ±400 pts (the actionable zone)
  const ZONE = 400
  const strikes = rows
    .filter(r => Math.abs(r.strike - spot) <= ZONE && (r.ce_oi > 0 || r.pe_oi > 0))
    .map(r => ({ strike: r.strike, ceOI: r.ce_oi, peOI: r.pe_oi }))
    .sort((a, b) => a.strike - b.strike)

  if (strikes.length < 3) {
    return { ok: false, reason: 'Insufficient OI data' }
  }

  // OI change map (today's fresh positioning) — more predictive than total OI
  const chgMap = {}
  if (oiData?.call_put_oi_data_list) {
    for (const s of oiData.call_put_oi_data_list) {
      chgMap[s.strike_price] = { ceChg: s.call_change_oi || 0, peChg: s.put_change_oi || 0 }
    }
  }

  const above = strikes.filter(s => s.strike > spot)
  const below = strikes.filter(s => s.strike < spot)

  // ── 1. DIRECTIONAL PRESSURE (the gradient, not a single wall) ──────────────
  // Above spot: heavy CE OI = sellers capping upside (bearish)
  // Below spot: heavy PE OI = buyers supporting (bullish)
  // Weight each strike by proximity — closer strikes matter more
  const proxWeight = (strike) => {
    const dist = Math.abs(strike - spot)
    return Math.max(0.2, 1 - dist / ZONE)  // 1.0 at spot → 0.2 at edge
  }

  let ceAboveWeighted = 0, peAboveWeighted = 0
  let ceBelowWeighted = 0, peBelowWeighted = 0
  for (const s of above) {
    ceAboveWeighted += s.ceOI * proxWeight(s.strike)
    peAboveWeighted += s.peOI * proxWeight(s.strike)
  }
  for (const s of below) {
    ceBelowWeighted += s.ceOI * proxWeight(s.strike)
    peBelowWeighted += s.peOI * proxWeight(s.strike)
  }

  // Resistance strength = CE OI stacked above (proximity-weighted)
  // Support strength = PE OI stacked below (proximity-weighted)
  const resistanceAbove = ceAboveWeighted
  const supportBelow = peBelowWeighted

  // Net directional pressure from structure:
  // More support below than resistance above = bullish room, vice versa
  const structVote = clip((supportBelow - resistanceAbove) / (supportBelow + resistanceAbove + 1))

  // ── 2. OI CHANGE PRESSURE (fresh positioning today) ────────────────────────
  // Fresh CE writing above = bearish; fresh PE writing below = bullish
  let freshBull = 0, freshBear = 0
  for (const s of strikes) {
    const c = chgMap[s.strike]
    if (!c) continue
    const w = proxWeight(s.strike)
    if (s.strike > spot) {
      if (c.ceChg > 0) freshBear += c.ceChg * w       // writers selling calls above
      if (c.peChg > 0) freshBull += c.peChg * w * 0.5 // some put writing above
    } else {
      if (c.peChg > 0) freshBull += c.peChg * w       // writers selling puts below
      if (c.ceChg > 0) freshBear += c.ceChg * w * 0.5
    }
  }
  const flowVote = (freshBull + freshBear) > 0 ? clip((freshBull - freshBear) / (freshBull + freshBear)) : 0

  // ── 3. FIND OI CLUSTERS (layers, not single walls) ────────────────────────
  // A cluster = strike with significant OI relative to the whole zone
  // Use overall average across ALL strikes (both sides) so heavy walls on one
  // side don't inflate that side's own threshold and disqualify themselves
  const allCE = strikes.map(s => s.ceOI)
  const allPE = strikes.map(s => s.peOI)
  const avgCEall = allCE.reduce((s, v) => s + v, 0) / (allCE.length || 1)
  const avgPEall = allPE.reduce((s, v) => s + v, 0) / (allPE.length || 1)

  // Exclude strikes within NOISE_ZONE of spot — the nearest strike to spot is
  // always the most-traded (ATM/NTM) and naturally has elevated OI regardless
  // of whether it represents a real barrier. Without this, "resistance 29pts
  // away" on a breakout day is just ATM noise, not a meaningful wall.
  const NOISE_ZONE = 40

  // Resistance zones: strikes above with CE OI above overall CE average, beyond noise zone
  const resistanceZones = above
    .filter(s => s.ceOI > avgCEall && (s.strike - spot) > NOISE_ZONE)
    .map(s => ({ strike: s.strike, oi: s.ceOI, dist: s.strike - spot }))
    .sort((a, b) => a.dist - b.dist)

  // Support zones: strikes below with PE OI above overall PE average, beyond noise zone
  const supportZones = below
    .filter(s => s.peOI > avgPEall && (spot - s.strike) > NOISE_ZONE)
    .map(s => ({ strike: s.strike, oi: s.peOI, dist: spot - s.strike }))
    .sort((a, b) => a.dist - b.dist)

  // ── 4. POSITION IN LANDSCAPE ───────────────────────────────────────────────
  // Where is spot relative to the nearest significant barriers on each side?
  const nearestRes = resistanceZones[0] || null
  const nearestSup = supportZones[0] || null

  // How much "headroom" before hitting next resistance/support cluster
  const headroomUp = nearestRes ? nearestRes.dist : ZONE
  const headroomDown = nearestSup ? nearestSup.dist : ZONE

  return {
    ok: true,
    structVote,       // directional pressure from OI gradient
    flowVote,         // directional pressure from today's OI change
    resistanceAbove,  // total weighted CE OI above
    supportBelow,     // total weighted PE OI below
    resistanceZones,  // array of resistance clusters above
    supportZones,     // array of support clusters below
    nearestRes,       // nearest resistance cluster {strike, oi, dist}
    nearestSup,       // nearest support cluster {strike, oi, dist}
    headroomUp,       // pts to nearest resistance
    headroomDown,     // pts to nearest support
  }
}

// ── SIGNALS ───────────────────────────────────────────────────────────────────
function sigPCR(near) {
  const ce = near.reduce((s, r) => s + r.ce_oi, 0) || 1
  const pe = near.reduce((s, r) => s + r.pe_oi, 0)
  const cep = near.reduce((s, r) => s + r.ce_prev_oi, 0) || 1
  const pep = near.reduce((s, r) => s + r.pe_prev_oi, 0)
  const pcr = +(pe / ce).toFixed(2), prev = +(pep / cep).toFixed(2)
  let v = clip(0.6 * (pcr - 1) / 0.5 + 0.4 * (pcr - prev) / 0.2)
  if (pcr > 1.8 || pcr < 0.45) v *= 0.5
  const dir = v > 0.1 ? 'bullish' : v < -0.1 ? 'bearish' : 'neutral'
  return { vote: clip(v), pcr, prev, reason: `NTM PCR ${pcr} (${pcr > prev ? 'rising' : 'falling'} from ${prev}) — ${dir}` }
}

function sigBuildup(spot, oiData) {
  if (!oiData?.call_put_oi_data_list?.length) return { vote: 0, bull: 0, bear: 0, totalCe: 0, totalPe: 0, reason: 'OI change — no data' }
  let bull = 0, bear = 0
  for (const s of oiData.call_put_oi_data_list) {
    if (Math.abs(s.strike_price - spot) > NTM) continue
    const { strike_price: sp, call_change_oi: ce, put_change_oi: pe } = s
    if (sp > spot) { if (ce > 0) bear += ce; else bull += Math.abs(ce); if (pe > 0) bull += pe * 0.3 }
    else { if (pe > 0) bull += pe; else bear += Math.abs(pe); if (ce > 0) bear += ce * 0.3 }
  }
  const tot = bull + bear, v = tot ? clip((bull - bear) / tot) : 0
  const dir = v > 0.1 ? 'bullish' : v < -0.1 ? 'bearish' : 'balanced'
  const tCe = oiData.total_call_change_oi || 0, tPe = oiData.total_put_change_oi || 0
  return { vote: v, bull, bear, totalCe: tCe, totalPe: tPe, reason: `OI change ${dir}: put support ${fmtOI(bull)} vs call resistance ${fmtOI(bear)} (CE ${fmtOI(tCe)} / PE ${fmtOI(tPe)})` }
}

function sigMaxPain(rows, spot, dte) {
  const pain = {}
  for (const r of rows) { let l = 0; for (const o of rows) { l += Math.max(0, r.strike - o.strike) * o.ce_oi; l += Math.max(0, o.strike - r.strike) * o.pe_oi }; pain[r.strike] = l }
  const mp = +Object.entries(pain).sort((a, b) => a[1] - b[1])[0][0]
  const gap = mp - spot, ew = dte <= 1 ? 1 : dte <= 2 ? 0.6 : dte <= 4 ? 0.35 : 0.2
  return { vote: clip(gap / spot / 0.01) * ew, maxPain: mp, expW: ew, reason: `Max pain ${mp} (${gap > 0 ? '+' : ''}${Math.round(gap)} pts) — ${dte}d to expiry` }
}

function sigWalls(near, spot) {
  if (!near.length) return { vote: 0, R: spot + 500, S: spot - 500, zone: 'unknown', pos: 0.5, reason: 'Walls — no data' }

  // Split into above/below spot first
  const aboveSpot = near.filter(r => r.strike > spot)
  const belowSpot = near.filter(r => r.strike < spot)

  // CE wall (resistance): nearest strike above spot with meaningful OI
  // Using nearest (not heaviest) because immediate resistance matters more for entries
  const ceAbove = aboveSpot.length ? [...aboveSpot].sort((a,b) => a.strike - b.strike) : []
  const peBelow = belowSpot.length ? [...belowSpot].sort((a,b) => b.strike - a.strike) : []

  // Filter to top 5 by OI first (ignore tiny/illiquid strikes), then take nearest
  const topCE = [...ceAbove].sort((a,b) => b.ce_oi - a.ce_oi).slice(0, 5)
  const topPE = [...peBelow].sort((a,b) => b.pe_oi - a.pe_oi).slice(0, 5)

  // Nearest significant = lowest strike among top-OI CE above, highest strike among top-OI PE below
  const ceM = topCE.length
    ? topCE.reduce((b, r) => r.strike < b.strike ? r : b, topCE[0])  // nearest above
    : (near.length ? near.reduce((b, r) => r.ce_oi > b.ce_oi ? r : b, near[0]) : null)
  const peM = topPE.length
    ? topPE.reduce((b, r) => r.strike > b.strike ? r : b, topPE[0])  // nearest below
    : (near.length ? near.reduce((b, r) => r.pe_oi > b.pe_oi ? r : b, near[0]) : null)

  if (!ceM || !peM) return { vote: 0, R: spot + 300, S: spot - 300, zone: 'unknown', pos: 0.5, reason: 'Walls — insufficient data' }
  const R = ceM.strike, S = peM.strike
  if (R - S < 50) return { vote: 0, R, S, zone: 'tight', pos: 0.5, reason: `Walls too tight (${S}–${R})` }
  const pos = (spot - S) / (R - S)
  const str = (peM.pe_oi - ceM.ce_oi) / (peM.pe_oi + ceM.ce_oi)
  const v = clip(0.8 * (0.5 - pos) * 2 + 0.2 * str)
  const zone = pos < 0.35 ? 'near support' : pos > 0.65 ? 'near resistance' : 'mid-range'
  return { vote: v, R, S, ceOI: ceM.ce_oi, peOI: peM.pe_oi, zone, pos, reason: `Spot ${zone} of ${S}–${R} (PE ${fmtOI(peM.pe_oi)} / CE ${fmtOI(ceM.ce_oi)})` }
}

function sigSkew(rows, spot) {
  const BASE = 2.5
  const pR = rows.reduce((b, r) => Math.abs(r.strike - (spot - NTM)) < Math.abs(b.strike - (spot - NTM)) ? r : b, rows[0])
  const cR = rows.reduce((b, r) => Math.abs(r.strike - (spot + NTM)) < Math.abs(b.strike - (spot + NTM)) ? r : b, rows[0])
  if (!pR || !cR) return { vote: 0, reason: 'IV skew — no data' }
  const skew = pR.pe_iv - cR.ce_iv, v = clip(-(skew - BASE) / 4)
  const tone = skew > BASE + 1 ? 'downside fear' : skew < BASE - 1 ? 'call demand' : 'normal'
  return { vote: v, skew, reason: `IV skew ${skew.toFixed(1)} (put ${Math.round(pR.pe_iv)} vs call ${Math.round(cR.ce_iv)}) — ${tone}` }
}

function sigVix(vix) {
  if (vix == null) return { vote: 0, zone: 'unknown', reason: 'VIX — unavailable' }
  let v = 0, zone = ''
  if (vix < 13) { v = 0.3; zone = 'LOW' }
  else if (vix <= 16) { v = 0.1; zone = 'NORMAL' }
  else if (vix <= 20) { v = -0.2; zone = 'ELEVATED' }
  else { v = -0.5; zone = 'HIGH' }
  return { vote: v, zone, reason: `India VIX ${vix.toFixed(1)} (${zone}) — ${v > 0 ? 'cheap premiums' : v < 0 ? 'expensive premiums' : 'normal'}` }
}

function sigPDHL(spot, pdh, pdl) {
  if (!pdh || !pdl) return { vote: 0, reason: 'PDH/PDL — unavailable' }
  let v = 0
  if (spot > pdh) v = 0.5          // broke above PDH = bullish breakout
  else if (spot < pdl) v = -0.5    // broke below PDL = bearish breakdown
  else { const pos = (spot - pdl) / (pdh - pdl); v = clip((0.5 - pos) * 2) }
  const zone = spot > pdh ? 'above PDH (breakout)' : spot < pdl ? 'below PDL (breakdown)' : v > 0.2 ? 'near PDL support' : v < -0.2 ? 'near PDH resistance' : 'mid-range'
  return { vote: v, reason: `PDH ${pdh ? pdh.toFixed(0) : '—'} / PDL ${pdl ? pdl.toFixed(0) : '—'} — ${zone}` }
}

function getTrend(candles, spot) {
  if (!candles || candles.length < 2) return { trend: 'unknown', trendVote: 0, timeWarning: null }
  const lc = safe(() => candles[candles.length - 1][4], spot)
  const pc = safe(() => candles[candles.length - 2][4], spot)
  const p2c = candles.length >= 3 ? safe(() => candles[candles.length - 3][4], pc) : pc

  // Net move over last 3 candles (from open of 3rd-to-last to close of last)
  const idx3 = candles.length - 4
  const c3 = idx3 >= 0 ? safe(() => candles[idx3][4], lc) : pc
  const net3 = lc - c3
  // Recent 2-candle net (more responsive to V-shaped bounces)
  const net2 = lc - p2c
  const minMove = spot * 0.001  // ~0.1% threshold

  let trend, trendVote

  // If last 2 candles are both moving strongly in the SAME direction,
  // that recent momentum overrides the net-3 (catches V-shaped bounces)
  const bothUp = lc > pc && pc > p2c && net2 > minMove
  const bothDown = lc < pc && pc < p2c && net2 < -minMove

  // Single strong candle override: >0.15% move on the last candle alone
  // Catches sharp single-candle recoveries where previous candle was flat/bottom
  const strongThresh = spot * 0.0015  // ~35pts at 23900
  const strongUp = (lc - pc) > strongThresh
  const strongDown = (pc - lc) > strongThresh

  if (bothUp || strongUp) {
    trend = 'up'
    trendVote = bothUp ? 0.4 : 0.25
  } else if (bothDown || strongDown) {
    trend = 'down'
    trendVote = -(bothDown ? 0.4 : 0.25)
  } else if (Math.abs(net3) > minMove) {
    // No clear recent signal — fall back to net-3 direction
    trend = net3 > 0 ? 'up' : 'down'
    trendVote = net3 > 0 ? 0.2 : -0.2
  } else {
    // Everything flat — use last single candle as weak signal
    trend = lc > pc ? 'up' : lc < pc ? 'down' : 'flat'
    trendVote = lc > pc ? 0.1 : lc < pc ? -0.1 : 0
  }

  const mins = getISTMins()
  let timeWarning = null
  if (mins < 9 * 60 + 45) timeWarning = 'Opening volatility (9:15–9:45 IST) — wait for settlement'
  else if (mins > 14 * 60 + 45) timeWarning = 'Last 45 mins — theta collapse, avoid buying options'
  return { trend, trendVote, timeWarning, lc, pc, c3, net3, net2 }
}

// ── ANALYSIS ──────────────────────────────────────────────────────────────────
function analyse(rows, spot, dte, oiData, vix, pdh, pdl, candles, prevClose, prev2Close, candles5) {
  const near = rows.filter(r => Math.abs(r.strike - spot) <= NTM)
  if (!near.length) return null

  const pcr = sigPCR(near)
  const bld = sigBuildup(spot, oiData)
  const mp = safe(() => sigMaxPain(rows, spot, dte), { vote: 0, maxPain: spot, expW: 0.2, reason: 'Max pain — calc error' })
  const wall = sigWalls(near, spot)
  const skew = sigSkew(rows, spot)
  const vixS = sigVix(vix)
  const pdhl = sigPDHL(spot, pdh, pdl)
  const tctx = getTrend(candles, spot)

  // Prior-day context signal
  // Captures multi-day trend the intraday signals miss
  // Gap down from prev close = bearish, gap up = bullish
  // Yesterday itself down vs day before = additional bearish weight
  let priorV = 0, priorReason = 'Prior day context — no data'
  if (prevClose && prevClose > 0) {
    const gapPct = (spot - prevClose) / prevClose          // today's open vs yesterday close
    const prevDayChg = prev2Close ? (prevClose - prev2Close) / prev2Close : 0  // yesterday vs day before

    // 2-day trend is the PRIMARY signal — captures sustained momentum the algo misses
    // Today's gap is SECONDARY — often flat/noisy at open
    const prevDayVote = clip(prevDayChg / 0.003)   // full vote at 0.3% move
    const gapVote = clip(gapPct / 0.003)
    priorV = clip(prevDayVote * 0.6 + gapVote * 0.4)

    const gapDir = gapPct < -0.002 ? `gap down ${(gapPct * 100).toFixed(2)}%` : gapPct > 0.002 ? `gap up +${(gapPct * 100).toFixed(2)}%` : `flat open (${(gapPct * 100).toFixed(2)}%)`
    const prevDir = prevDayChg < -0.002 ? `yesterday fell ${(prevDayChg * 100).toFixed(2)}%` : prevDayChg > 0.002 ? `yesterday rose +${(prevDayChg * 100).toFixed(2)}%` : 'yesterday flat'
    priorReason = `Prior context: ${prevDir} · ${gapDir}`
  }

  const sigs = [
    { v: pcr.vote, w: 2.0, r: pcr.reason },
    { v: bld.vote, w: 1.5, r: bld.reason },
    { v: mp.vote, w: 1.2 * mp.expW, r: mp.reason },
    { v: wall.vote, w: 2.0, r: wall.reason },
    { v: skew.vote, w: 1.5, r: skew.reason },
    { v: vixS.vote, w: 1.0, r: vixS.reason },
    { v: pdhl.vote, w: 1.5, r: pdhl.reason },
    { v: tctx.trendVote, w: 0.8, r: `30min trend ${tctx.trend} (net 3-candle ${tctx.net3 != null ? (tctx.net3 >= 0 ? '+' : '') + tctx.net3.toFixed(0) : '—'}pts, last ${tctx.lc ? tctx.lc.toFixed(0) : '—'})` },
    { v: priorV, w: 2.0, r: priorReason },   // prior-day context — high weight, captures what intraday misses
  ]

  const wsum = sigs.reduce((s, x) => s + x.w, 0)
  const score = sigs.reduce((s, x) => s + x.v * x.w, 0) / wsum
  const sign = score >= 0 ? 1 : -1
  const aw = sigs.filter(x => Math.abs(x.v) > 0.05).reduce((s, x) => s + x.w, 0)
  const ag = sigs.filter(x => Math.abs(x.v) > 0.05 && (x.v >= 0) === (sign >= 0)).reduce((s, x) => s + x.w, 0)
  const conv = Math.round(Math.abs(score) * (aw ? ag / aw : 0.5) * 100)

  let bias = 'NEUTRAL'
  if (Math.abs(score) >= 0.15 && conv >= 20) {
    if (score >= 0.40) bias = 'BULLISH'
    else if (score >= 0.15) bias = 'CAUTIOUSLY BULLISH'
    else if (score <= -0.40) bias = 'BEARISH'
    else bias = 'CAUTIOUSLY BEARISH'
  }

  const ranked = [...sigs].sort((a, b) => Math.abs(b.v * b.w) - Math.abs(a.v * a.w))

  // ATM expected move
  const atm = rows.reduce((b, r) => Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b, rows[0])
  const em = atm.ce_ltp + atm.pe_ltp

  // ── REGIME DETECTION ──────────────────────────────────────────────────────
  // Core fix: spot crossing PDH/PDL is NOT enough for TRENDING UP/DOWN
  // A single spike above PDH that immediately reverses = false breakout (channel)
  // Requires: 2+ consecutive 5-min candles closing above PDH (or below PDL)
  // This prevents a post-crash bounce from being misread as TRENDING UP

  const insidePDHL = pdh && pdl ? (spot < pdh && spot > pdl) : true
  let todayHigh = spot, todayLow = spot
  if (candles && candles.length) {
    todayHigh = Math.max(...candles.map(c => c[2] || spot))
    todayLow = Math.min(...candles.map(c => c[3] || spot))
  }
  const dayRange = todayHigh - todayLow

  // Sustained trend: 3 consecutive 30-min candles each moving >0.1% in same direction
  let sustained = false
  if (candles && candles.length >= 3) {
    const c3 = candles.slice(-3).map(c => safe(() => c[4], spot))
    const minMove = spot * 0.001
    const allUp = c3[0] < c3[1] && c3[1] < c3[2] && (c3[1]-c3[0]) > minMove && (c3[2]-c3[1]) > minMove
    const allDown = c3[0] > c3[1] && c3[1] > c3[2] && (c3[0]-c3[1]) > minMove && (c3[1]-c3[2]) > minMove
    sustained = allUp || allDown
  }

  // Breakout confirmation via 5-min candles
  // TRENDING UP only if last 2 consecutive 5-min candles BOTH closed above PDH
  // TRENDING DOWN only if last 2 consecutive 5-min candles BOTH closed below PDL
  let confirmedBreakoutUp = false, confirmedBreakoutDown = false
  if (candles5 && candles5.length >= 2 && pdh && pdl) {
    const last2 = candles5.slice(-2)
    confirmedBreakoutUp = last2.every(c => c[4] > pdh)    // both close above PDH
    confirmedBreakoutDown = last2.every(c => c[4] < pdl)  // both close below PDL
  } else if (!candles5 && !insidePDHL) {
    // No 5-min data available — fall back to single-bar PDH/PDL check
    confirmedBreakoutUp = spot > pdh
    confirmedBreakoutDown = spot < pdl
  }

  const tightRange = dayRange < em * 0.65
  const isChannel = !confirmedBreakoutUp && !confirmedBreakoutDown && tightRange && !sustained
  const isTrend = confirmedBreakoutUp || confirmedBreakoutDown || sustained || dayRange > em * 0.9
  const nearSup = isChannel && wall.pos < 0.25
  const nearRes = isChannel && wall.pos > 0.75

  // ── CONSOLIDATION CHECK (within an established trend) ──────────────────────
  // After a confirmed breakout, price can settle into its OWN tight range —
  // regime stays "TRENDING UP" forever (still above yesterday's PDH), but for
  // trading purposes it's now range-bound. Detect this from the last ~30min
  // (6 x 5-min candles) of TODAY's own price action, independent of PDH/PDL.
  let recentHigh = null, recentLow = null, isConsolidating = false
  if (candles5 && candles5.length >= 6) {
    const recent = candles5.slice(-6)
    recentHigh = Math.max(...recent.map(c => c[2]))
    recentLow = Math.min(...recent.map(c => c[3]))
    const recentRange = recentHigh - recentLow
    // Tight relative to EM, and not currently making a fresh extreme
    const atFreshHigh = spot >= todayHigh - 5
    const atFreshLow = spot <= todayLow + 5
    isConsolidating = (isTrend && !sustained) && recentRange < em * 0.35 && !atFreshHigh && !atFreshLow
  }

  let regime = 'RANGING'
  if (isConsolidating) regime = confirmedBreakoutUp ? 'CONSOLIDATING (UP)' : confirmedBreakoutDown ? 'CONSOLIDATING (DOWN)' : 'CONSOLIDATING'
  else if (confirmedBreakoutUp) regime = 'TRENDING UP'
  else if (confirmedBreakoutDown) regime = 'TRENDING DOWN'
  else if (isTrend) regime = 'TRENDING'
  else if (isChannel) regime = 'CHANNELING'

  // Time of day score (IST) — affects trend entry quality
  const mins = getISTMins()
  let timeScore = 0.7
  if (mins >= 9 * 60 + 45 && mins <= 11 * 60) timeScore = 1.0
  else if (mins > 14 * 60) timeScore = 0

  return {
    bias, conv, score, reasons: ranked.map(x => x.r),
    pcr: pcr.pcr, maxPain: mp.maxPain,
    R: wall.R, S: wall.S, wallPos: wall.pos, wallZone: wall.zone,
    nearSup, nearRes, isChannel, isTrend, regime, isConsolidating, recentHigh, recentLow,
    bld, vixZone: vixS.zone,
    timeWarning: tctx.timeWarning, trend: tctx.trend, tLc: tctx.lc, tPc: tctx.pc, tNet3: tctx.net3,
    em, emRound: Math.round(em),
    insidePDHL, tightRange, sustained,
    dayRange: Math.round(dayRange), timeScore, priorV, oiData
  }
}

// ── LEVELS (entry / SL / target) ──────────────────────────────────────────────
function calcLevels(side, ltp, delta, spot, a, candles, rows, isChannel) {
  if (!ltp || !delta || !spot) return null
  const absDelta = Math.abs(delta)
  if (absDelta < 0.05) return null

  let niftySL, niftyTGT

  // Get OI structure for cluster-based targets in trend mode
  const oi = !isChannel ? safe(() => analyzeOIStructure(rows, spot, a.oiData), { ok: false }) : { ok: false }

  if (side === 'ce') {
    if (isChannel) {
      niftySL = Math.round(a.S - 30)
      niftyTGT = Math.round(a.R)
    } else {
      const cLow = safe(() => Math.min(...(candles || []).slice(-2).map(c => c[3])), spot - 50)
      niftySL = Math.round(Math.min(cLow - 20, spot - 30))
      // Target = next resistance CLUSTER above (from OI gradient), capped at 2× EM
      const maxTgt = a.emRound * 2
      if (oi.ok && oi.resistanceZones.length) {
        // First meaningful cluster at least 40pts away; if spot is between clusters, aim for next one up
        const tgt = oi.resistanceZones.find(z => z.dist >= 40 && z.dist <= maxTgt)
        niftyTGT = tgt ? tgt.strike : Math.round(Math.min(spot + a.emRound, spot + maxTgt))
      } else {
        niftyTGT = Math.round(spot + Math.max(50, a.emRound))
      }
    }
  } else {
    if (isChannel) {
      niftySL = Math.round(a.R + 30)
      const peTarget = safe(() => {
        const bl = rows.filter(r => r.strike < spot - 30)
        if (!bl.length) return a.S
        const top5 = [...bl].sort((a,b) => b.pe_oi - a.pe_oi).slice(0,5)
        return top5.reduce((b,r) => r.strike > b.strike ? r : b, top5[0]).strike
      }, a.S)
      niftyTGT = Math.round(peTarget)
    } else {
      const cHigh = safe(() => Math.max(...(candles || []).slice(-2).map(c => c[2])), spot + 50)
      niftySL = Math.round(Math.max(cHigh + 20, spot + 30))
      // Target = next support CLUSTER below (from OI gradient), capped at 2× EM
      const maxTgt = a.emRound * 2
      if (oi.ok && oi.supportZones.length) {
        const tgt = oi.supportZones.find(z => z.dist >= 40 && z.dist <= maxTgt)
        niftyTGT = tgt ? tgt.strike : Math.round(Math.max(spot - a.emRound, spot - maxTgt))
      } else {
        niftyTGT = Math.round(spot - Math.max(50, a.emRound))
      }
    }
  }

  const slDist = side === 'ce' ? Math.max(30, spot - niftySL) : Math.max(30, niftySL - spot)
  // Cap SL distance on expiry/near-expiry day to prevent absurd SLs from wide candle ranges
  const maxSlDist = a.emRound > 0
    ? Math.min(slDist, Math.max(40, a.emRound * 0.35))  // max 35% of expected move
    : slDist
  const tgtDist = side === 'ce' ? Math.max(0, niftyTGT - spot) : Math.max(0, spot - niftyTGT)
  const optionEntry = +ltp.toFixed(1)
  // SL: tighter of calculated OR 35% max loss from entry (never wipe the premium)
  const calcSL = +(ltp - maxSlDist * absDelta).toFixed(1)
  const premiumFloor = +(ltp * 0.65).toFixed(1)   // SL at most 35% below entry
  const optionSL = Math.max(premiumFloor, Math.max(0.5, calcSL))
  const optionTGT = +(ltp + tgtDist * absDelta).toFixed(1)
  const rr = (ltp - optionSL) > 0 ? +((optionTGT - ltp) / (ltp - optionSL)).toFixed(1) : 0

  return { optionEntry, optionSL, optionTGT, rr }
}

// ── BOUNCE / REJECTION DETECTION (5-min candles) ─────────────────────────────
// Checks for confirmed reversal at a key OI wall
// Works on ALL regimes — pullbacks happen even in strong trends
function detectReversal(spot, oiData, candles5, rows) {
  if (!candles5 || candles5.length < 2) return null

  const last  = candles5[candles5.length - 1]  // [ts, o, h, l, c, v, oi]
  const prev  = candles5[candles5.length - 2]
  const lOpen = last[1], lHigh = last[2], lLow = last[3], lClose = last[4]
  const pLow  = prev[3], pHigh = prev[2]

  // Find strongest PE wall (support) and CE wall (resistance) near spot
  const nearRows = rows.filter(r => Math.abs(r.strike - spot) <= 600)
  if (!nearRows.length) return null

  const peWallRow = nearRows.reduce((b, r) => r.pe_oi > b.pe_oi ? r : b, nearRows[0])
  const ceWallRow = nearRows.reduce((b, r) => r.ce_oi > b.ce_oi ? r : b, nearRows[0])
  const peWall = peWallRow.strike
  const ceWall = ceWallRow.strike

  // Get OI change at wall from change-oi data
  const getWallOIChg = (strike, side) => {
    if (!oiData?.call_put_oi_data_list) return 0
    const entry = oiData.call_put_oi_data_list.find(s => s.strike_price === strike)
    return entry ? (side === 'pe' ? entry.put_change_oi : entry.call_change_oi) : 0
  }

  // ── BOUNCE at PE wall (CE Buy opportunity) ───────────────────────────────
  // Conditions: touched wall, closed above it, higher low, PE writers defending
  const touchedPEWall = Math.abs(lLow - peWall) <= 50 || lLow <= peWall + 30
  const closedAbovePEWall = lClose > peWall
  const higherLow = lLow >= pLow - 10          // low held or improved (small buffer)
  const peWritersDefending = getWallOIChg(peWall, 'pe') > 0

  if (touchedPEWall && closedAbovePEWall && higherLow) {
    const strength = peWritersDefending ? 'strong' : 'moderate'
    return {
      type: 'BOUNCE',
      side: 'ce',
      wall: peWall,
      strength,
      reason: `5-min bounce off PE wall ${peWall} — closed above (${lClose.toFixed(0)}), higher low held${peWritersDefending ? ', PE writers defending' : ''}`,
    }
  }

  // ── REJECTION at CE wall (PE Buy opportunity) ────────────────────────────
  // Conditions: touched wall, closed below it, lower high, CE writers defending
  const touchedCEWall = Math.abs(lHigh - ceWall) <= 50 || lHigh >= ceWall - 30
  const closedBelowCEWall = lClose < ceWall
  const lowerHigh = lHigh <= pHigh + 10        // high failed to extend (small buffer)
  const ceWritersDefending = getWallOIChg(ceWall, 'ce') > 0

  if (touchedCEWall && closedBelowCEWall && lowerHigh) {
    const strength = ceWritersDefending ? 'strong' : 'moderate'
    return {
      type: 'REJECTION',
      side: 'pe',
      wall: ceWall,
      strength,
      reason: `5-min rejection at CE wall ${ceWall} — closed below (${lClose.toFixed(0)}), lower high confirmed${ceWritersDefending ? ', CE writers defending' : ''}`,
    }
  }

  return null
}

// ── ATM PRICE CROSSOVER ───────────────────────────────────────────────────────
// Generates a Buy Call signal when ATM Call price crosses above ATM Put price,
// and a Buy Put signal when ATM Put price crosses above ATM Call price.
// This is independent of OI-based signals.
function detectATMCrossover(prevCeLtp, prevPeLtp, currCeLtp, currPeLtp) {
  if (prevCeLtp == null || prevPeLtp == null) return null
  if (!currCeLtp || !currPeLtp) return null
  if (prevCeLtp <= prevPeLtp && currCeLtp > currPeLtp)
    return { type: 'CE Buy', reason: `ATM Call ₹${currCeLtp.toFixed(2)} crossed above ATM Put ₹${currPeLtp.toFixed(2)}` }
  if (prevPeLtp <= prevCeLtp && currPeLtp > currCeLtp)
    return { type: 'PE Buy', reason: `ATM Put ₹${currPeLtp.toFixed(2)} crossed above ATM Call ₹${currCeLtp.toFixed(2)}` }
  return null
}

// ── RECOMMENDATION ────────────────────────────────────────────────────────────
function getRec(rows, spot, a, vix, candles5, belowPDLStreak) {
  if (!a) return { type: 'No Trade', logic: 'Analysis unavailable' }
  const { bias, conv, timeWarning, nearSup, nearRes, isChannel, isTrend, regime, timeScore } = a
  if (timeWarning) return { type: 'Wait', logic: timeWarning }
  if (vix != null && vix > 20) return { type: 'No Trade', logic: `VIX ${vix.toFixed(1)} too high — premiums too expensive` }

  const streak = belowPDLStreak || 0
  const timeNote = timeScore < 1.0 ? ' Post 11 AM — consider smaller size.' : ''

  const pick = (side, overrides = {}) => safe(() => {
    const lt = `${side}_ltp`, dl = `${side}_delta`
    const bk = `${side}_bid`, ak = `${side}_ask`
    const aff = rows
      .filter(r => r[lt] > 0.5)
      .map(r => ({ ...r, _ad: Math.abs(r[dl]), _sp: (r[ak] || 0) - (r[bk] || 0) }))
    if (!aff.length) return null
    const liquid = aff.filter(r => r._sp <= 15)
    const cand = liquid.length ? liquid : aff
    cand.sort((x, y) => {
      const dd = y._ad - x._ad
      if (Math.abs(dd) > 0.05) return dd
      return x._sp - y._sp
    })
    const row = cand[0]
    const spread = +row._sp.toFixed(1)
    const useChannel = overrides.isChannel ?? isChannel
    const aForLevels = overrides.a || a
    const levels = calcLevels(side, row[lt], row[dl], spot, aForLevels, candles5 || [], rows, useChannel)
    return {
      strike: row.strike, ltp: row[lt], delta: row[dl],
      theta: row[`${side}_theta`], iv: row[`${side}_iv`],
      moneyness: Math.round(side === 'ce' ? spot - row.strike : row.strike - spot),
      spread, spreadWide: spread > 8, levels
    }
  })

  // ── REVERSAL CHECK (runs first — works on ALL regimes) ────────────────────
  // 5-min bounce/rejection at OI walls takes priority over broader regime signal
  // This catches pullbacks on trend days AND channel reversals
  if (vix == null || vix <= 18) {
    const reversal = safe(() => detectReversal(spot, a.oiData, candles5, rows))
    if (reversal) {
      const d = pick(reversal.side)
      const isStrong = reversal.strength === 'strong'
      return {
        type: reversal.side === 'ce' ? 'CE Buy' : 'PE Buy',
        ...d,
        confirmed: isStrong,
        isReversal: true,
        reversalType: reversal.type,
        logic: `REVERSAL (${reversal.strength.toUpperCase()}): ${reversal.reason}`,
      }
    }
  }

  // ── CONSOLIDATING (within a trend) ────────────────────────────────────────
  // Price established a trend (still above/below yesterday's PDH/PDL) but has
  // settled into its OWN tight range over the last ~30min. Trade this range
  // using TODAY's recent high/low as support/resistance — same bounce/rejection
  // logic as CHANNELING, just with different boundaries.
  if (a.isConsolidating && a.recentHigh && a.recentLow) {
    const rH = a.recentHigh, rL = a.recentLow
    const rangeSize = rH - rL
    const buffer = Math.max(10, rangeSize * 0.2)
    const aMod = { ...a, S: Math.round(rL), R: Math.round(rH) }

    if (spot <= rL + buffer) {
      const d = pick('ce', { isChannel: true, a: aMod })
      return { type: 'CE Buy', ...d, logic: `${regime}: Price consolidating ${Math.round(rL)}–${Math.round(rH)} (last 30min). Near range low (${Math.round(rL)}) — bounce setup.${vix > 16 ? ' VIX elevated, size small.' : ''}` }
    }
    if (spot >= rH - buffer) {
      const d = pick('pe', { isChannel: true, a: aMod })
      return { type: 'PE Buy', ...d, logic: `${regime}: Price consolidating ${Math.round(rL)}–${Math.round(rH)} (last 30min). Near range high (${Math.round(rH)}) — rejection setup.${vix > 16 ? ' VIX elevated, size small.' : ''}` }
    }
    return { type: 'No Trade', logic: `${regime}: Price consolidating ${Math.round(rL)}–${Math.round(rH)} (last 30min). Spot mid-range — wait for edge.` }
  }

  if (isChannel) {
    if (nearSup) { const d = pick('ce'); return { type: 'CE Buy', ...d, logic: `CHANNEL: Near support (${a.S}) — bounce setup.${vix > 16 ? ' VIX elevated, size small.' : ''}` } }
    if (nearRes) { const d = pick('pe'); return { type: 'PE Buy', ...d, logic: `CHANNEL: Near resistance (${a.R}) — rejection setup.${vix > 16 ? ' VIX elevated, size small.' : ''}` } }
    return { type: 'No Trade', logic: `CHANNEL: Spot mid-range (${a.S}–${a.R}). Wait for spot to approach a wall.` }
  }

  if (isTrend) {
    if (timeScore === 0) return { type: 'No Trade', logic: 'TREND MODE: After 2 PM IST — no new trend entries. Theta risk too high.' }

    // ── 5-min momentum alignment ─────────────────────────────────────────────
    // Single-candle check isn't enough: a big breakdown candle followed by a
    // tiny green tick would still pass "last candle bullish" while the real
    // move is down. Check NET direction over the last 2 candles too — if the
    // net 2-candle move opposes the trade direction by a meaningful amount,
    // block regardless of what the very last candle looks like.
    let momentumBearish = null, momentumBullish = null, momentumNote = ''
    if (candles5 && candles5.length >= 2) {
      const lc5 = candles5[candles5.length - 1]
      const pc5 = candles5[candles5.length - 2]
      const lOpen = lc5[1], lClose = lc5[4], pClose = pc5[4]
      const minMove = spot * 0.0005  // ~0.05% — small but meaningful net move

      const lastBearish = lClose < lOpen || lClose < pClose
      const lastBullish = lClose > lOpen || lClose > pClose

      // Net move across the last 2 candles (from open of pc5 to close of lc5)
      const net2 = lClose - pc5[1]
      const net2Bearish = net2 < -minMove
      const net2Bullish = net2 > minMove

      // Bearish momentum confirmed if last candle bearish OR net-2 trending down
      momentumBearish = lastBearish || net2Bearish
      // But block bearish if net-2 strongly bullish despite a small red tick
      if (net2Bullish && !lastBearish) momentumBearish = false

      momentumBullish = lastBullish || net2Bullish
      if (net2Bearish && !lastBullish) momentumBullish = false
      // A strongly bearish net-2 always overrides a small bullish last candle
      if (net2Bearish) momentumBullish = false
      if (net2Bullish) momentumBearish = false

      const candleDir = lClose < lOpen ? '🔴' : lClose > lOpen ? '🟢' : '⬜'
      const netDir = net2Bearish ? 'net 2-candle ↓' : net2Bullish ? 'net 2-candle ↑' : 'net 2-candle flat'
      momentumNote = ` 5-min candle ${candleDir} (${lClose.toFixed(0)}), ${netDir} (${net2 >= 0 ? '+' : ''}${net2.toFixed(0)}pts).`
    }

    // ── OI STRUCTURE (the gradient) ──────────────────────────────────────────
    const oi = safe(() => analyzeOIStructure(rows, spot, a.oiData), { ok: false })

    // Move exhaustion check applies to all trend trades
    const moveExhausted = a.dayRange > a.emRound * 0.85
    if (moveExhausted) {
      return { type: 'No Trade', logic: `TREND (${regime}): Day range ${a.dayRange}pts is ${Math.round(a.dayRange/a.emRound*100)}% of expected move (±${a.emRound}pts) — move likely exhausted, don't chase.` }
    }

    // Determine intended direction from regime + prior-day context
    let dir = null  // 'bear' or 'bull'
    if (regime === 'TRENDING DOWN' || (regime === 'TRENDING' && bias.includes('BEAR'))) dir = 'bear'
    else if (regime === 'TRENDING UP' || (regime === 'TRENDING' && bias.includes('BULL'))) dir = 'bull'
    else if (regime === 'TRENDING' && a.priorV <= -0.3) dir = 'bear'
    else if (regime === 'TRENDING' && a.priorV >= 0.3) dir = 'bull'

    if (!dir) return { type: 'No Trade', logic: `TREND MODE (${regime}): Direction unclear. Wait for confirmation.` }

    // ── BEARISH TREND → PE Buy ───────────────────────────────────────────────
    if (dir === 'bear') {
      // Momentum gate: don't enter into an upward retracement
      if (momentumBearish === false) {
        return { type: 'Wait', logic: `TREND (${regime}): Bearish but${momentumNote} Retracement up — wait for bearish 5-min candle before PE entry.` }
      }
      // OI structure gate: is there room to fall? (headroom down to next support cluster)
      let confirmed = false
      if (oi.ok) {
        const structAgrees = oi.structVote < -0.1 || oi.flowVote < -0.15
        const hasRoom = oi.headroomDown >= 40
        confirmed = structAgrees && hasRoom && momentumBearish !== false
        if (!hasRoom) {
          return { type: 'No Trade', logic: `TREND (${regime}): Bearish but spot sitting on support cluster ${oi.nearestSup?.strike} (${Math.round(oi.headroomDown)}pts) — no room to fall, wait for breakdown.` }
        }
      }
      const supTxt = oi.ok && oi.nearestSup ? `support cluster ${oi.nearestSup.strike} (${Math.round(oi.headroomDown)}pts away, ${fmtOI(oi.nearestSup.oi)})` : 'no nearby support'
      const gradientNote = oi.ok ? (oi.structVote < -0.1 ? 'gradient bearish' : oi.flowVote < -0.15 ? 'fresh CE writing above' : 'gradient neutral') : 'no OI data'

      if (!confirmed) {
        return { type: 'Wait', logic: `TREND (${regime}): Bearish but unconfirmed — OI ${gradientNote}, next ${supTxt}. No edge for entry, wait for OI to align or price to react at ${oi.nearestSup?.strike || 'next level'}.${momentumNote}${timeNote}` }
      }
      const d = pick('pe')
      return { type: 'PE Buy', ...d, confirmed,
        logic: `TREND (${regime}): Bearish. ✓ OI ${gradientNote}, next ${supTxt}.${momentumNote}${timeNote}` }
    }

    // ── BULLISH TREND → CE Buy ───────────────────────────────────────────────
    if (dir === 'bull') {
      if (momentumBullish === false) {
        return { type: 'Wait', logic: `TREND (${regime}): Bullish but${momentumNote} Retracement down — wait for bullish 5-min candle before CE entry.` }
      }
      let confirmed = false
      if (oi.ok) {
        const structAgrees = oi.structVote > 0.1 || oi.flowVote > 0.15
        const hasRoom = oi.headroomUp >= 40
        confirmed = structAgrees && hasRoom && momentumBullish !== false
        if (!hasRoom) {
          return { type: 'No Trade', logic: `TREND (${regime}): Bullish but spot sitting under resistance cluster ${oi.nearestRes?.strike} (${Math.round(oi.headroomUp)}pts) — no room to rise, wait for breakout.` }
        }
      }
      const resTxt = oi.ok && oi.nearestRes ? `resistance cluster ${oi.nearestRes.strike} (${Math.round(oi.headroomUp)}pts away, ${fmtOI(oi.nearestRes.oi)})` : 'no nearby resistance'
      const gradientNote = oi.ok ? (oi.structVote > 0.1 ? 'gradient bullish' : oi.flowVote > 0.15 ? 'fresh PE writing below' : 'gradient neutral') : 'no OI data'

      if (!confirmed) {
        return { type: 'Wait', logic: `TREND (${regime}): Bullish but unconfirmed — OI ${gradientNote}, next ${resTxt}. No edge for entry, wait for OI to align or price to react at ${oi.nearestRes?.strike || 'next level'}.${momentumNote}${timeNote}` }
      }
      const d = pick('ce')
      return { type: 'CE Buy', ...d, confirmed,
        logic: `TREND (${regime}): Bullish. ✓ OI ${gradientNote}, next ${resTxt}.${momentumNote}${timeNote}` }
    }

    return { type: 'No Trade', logic: `TREND MODE (${regime}): Direction unclear. Wait for confirmation.` }
  }

  if (bias === 'NEUTRAL' || conv < 25) {
    // Don't suggest straddle if prior-day context is strongly directional
    // — in a trending market a straddle always has one leg bleeding
    if (a.priorV <= -0.3) {
      const d = pick('pe')
      return { type: 'PE Buy', ...d, logic: `Prior day strongly bearish — directional PE preferred over straddle.${timeNote}` }
    }
    if (a.priorV >= 0.3) {
      const d = pick('ce')
      return { type: 'CE Buy', ...d, logic: `Prior day strongly bullish — directional CE preferred over straddle.${timeNote}` }
    }
    const sorted = [...rows].sort((x, y) => Math.abs(x.strike - spot) - Math.abs(y.strike - spot))
    const sr = sorted.find(r => r.ce_ltp > 0.5 && r.pe_ltp > 0.5)
    if (sr) return { type: 'Straddle', strike: sr.strike, ceLtp: sr.ce_ltp, peLtp: sr.pe_ltp, logic: 'No directional edge, no prior day bias — straddle captures move either way' }
    return { type: 'No Trade', logic: 'Low conviction — stay out' }
  }
  if (bias.includes('BULLISH')) { const d = pick('ce'); return { type: 'CE Buy', ...d, logic: `${bias} bias.` } }
  const d = pick('pe'); return { type: 'PE Buy', ...d, logic: `${bias} bias.` }
}

// ── COMBINED SIGNAL (OI + ATM Price Crossover) ────────────────────────────────
// Blends the OI-based weighted score with the ATM premium differential to
// produce a higher-conviction directional signal. A recent ATM crossover that
// agrees with the direction earns a confidence boost.
function getCombinedSignal(a, atmCeLtp, atmPeLtp, recentCrossoverType) {
  if (!a || atmCeLtp == null || atmPeLtp == null) return null

  // ATM premium differential: CE > PE = call-heavy = bullish, PE > CE = bearish
  const total = atmCeLtp + atmPeLtp
  const atmRaw = total > 0 ? (atmCeLtp - atmPeLtp) / total : 0
  // Amplify — CE/PE typically differ by 5-20%, scale to -1..+1
  const atmVote = clip(atmRaw * 8)

  // OI analysis composite score (9 sub-signals already blended), -1..+1
  const oiVote = a.score

  // Both signals must point the same direction to be "aligned"
  const aligned = (oiVote > 0.05 && atmVote > 0) || (oiVote < -0.05 && atmVote < 0)

  // Weighted blend: OI carries richer multi-signal info, ATM is fast-moving price signal
  const combined = oiVote * 0.55 + atmVote * 0.45

  // Crossover bonus: if a fresh ATM crossover agrees with the blended direction
  const crossoverAgrees = recentCrossoverType === 'CE Buy' ? combined > 0
    : recentCrossoverType === 'PE Buy' ? combined < 0
    : false
  const boost = crossoverAgrees ? (combined >= 0 ? 0.12 : -0.12) : 0
  const finalScore = clip(combined + boost)

  const abs = Math.abs(finalScore)
  const type = finalScore > 0 ? 'CE Buy' : 'PE Buy'

  if (!aligned) {
    return { type: 'Conflicting', aligned: false, oiVote, atmVote, finalScore, crossoverAgrees }
  }
  if (abs < 0.08) {
    return { type: 'No Signal', aligned, oiVote, atmVote, finalScore, crossoverAgrees }
  }

  const strength = abs >= 0.42 ? 'STRONG' : abs >= 0.22 ? 'MODERATE' : 'WEAK'
  const conv = Math.round(abs * 100)
  return { type, strength, conv, finalScore, oiVote, atmVote, aligned, crossoverAgrees }
}

// ── DAILY BACKTEST (from logged trades) ──────────────────────────────────────
// Trade log entries carry date as 'D/M/YYYY' (en-IN locale) — parse for sort order.
// Tolerant of both D/M/YYYY and M/D/YYYY (imported data may use either).
const parseINDate = s => {
  if (!s) return null
  const m = String(s).trim().match(/^(\d{1,2})[\/\-](\d{1,2})[\/\-](\d{2,4})/)
  if (!m) return null
  let [, a, b, y] = m.map(Number)
  if (y < 100) y += 2000
  const day = a > 12 ? a : b > 12 ? b : a          // ambiguous → assume D/M
  const month = a > 12 ? b : b > 12 ? a : b
  if (day < 1 || day > 31 || month < 1 || month > 12) return null
  return new Date(y, month - 1, day)
}
// Canonical grouping key — dates from different sources ('2/7/2026' vs '02/07/2026')
// must land in the same day-bucket even though their raw strings differ.
const dateKey = s => { const d = parseINDate(s); return d ? `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}` : 'Unknown' }
const fmtDateKey = (key, fallback) => {
  if (key === 'Unknown') return fallback || 'Unknown date'
  const [y, m, d] = key.split('-').map(Number)
  return `${d}/${m + 1}/${y}`
}

function computeDailyStats(tradeLog) {
  const closed = tradeLog.filter(t => t.pnl != null)
  const openCount = tradeLog.length - closed.length
  if (!closed.length) return { days: [], summary: null, openCount }

  const byDate = {}
  for (const t of closed) {
    const key = dateKey(t.date)
    if (!byDate[key]) byDate[key] = { key, date: fmtDateKey(key, t.date), trades: 0, wins: 0, losses: 0, pnl: 0 }
    byDate[key].trades += 1
    byDate[key].pnl += t.pnl
    if (t.pnl > 0) byDate[key].wins += 1; else byDate[key].losses += 1
  }
  const days = Object.values(byDate)
    .map(d => ({ ...d, winRate: Math.round((d.wins / d.trades) * 100) }))
    .sort((a, b) => (parseINDate(b.date) ?? 0) - (parseINDate(a.date) ?? 0))

  const totalPnl = closed.reduce((s, t) => s + t.pnl, 0)
  const wins = closed.filter(t => t.pnl > 0).length
  const losses = closed.length - wins
  const winRate = Math.round((wins / closed.length) * 100)
  const avgPnl = Math.round(totalPnl / closed.length)
  const byPnl = [...days].sort((a, b) => b.pnl - a.pnl)
  const bestDay = byPnl[0], worstDay = byPnl[byPnl.length - 1]

  return { days, openCount, summary: { totalPnl, totalTrades: closed.length, wins, losses, winRate, avgPnl, bestDay, worstDay } }
}

// ── IMPORT TRADES (paste/upload CSV, e.g. from a spreadsheet trade log) ──────
// Tolerant CSV/TSV parser + flexible header mapping so real-world exports
// (mixed date formats, ₹-prefixed pnl, stray non-data rows) import cleanly.
function parseDelimited(text) {
  const delim = text.slice(0, text.indexOf('\n') > -1 ? text.indexOf('\n') : text.length).includes('\t') ? '\t' : ','
  const rows = []
  let row = [], field = '', inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const c = text[i]
    if (inQuotes) {
      if (c === '"') { if (text[i + 1] === '"') { field += '"'; i++ } else inQuotes = false }
      else field += c
    } else if (c === '"') inQuotes = true
    else if (c === delim) { row.push(field); field = '' }
    else if (c === '\n' || c === '\r') {
      if (c === '\r' && text[i + 1] === '\n') i++
      row.push(field); field = ''
      if (row.some(f => f.trim() !== '')) rows.push(row)
      row = []
    } else field += c
  }
  if (field !== '' || row.length) { row.push(field); if (row.some(f => f.trim() !== '')) rows.push(row) }
  return rows
}

const IMPORT_ALIASES = {
  date: ['date'], time: ['time'], regime: ['regime'], signal: ['signal'],
  strike: ['strike'], entry: ['entryltp', 'entry'], exit: ['exitprice', 'exit'],
  pnl: ['pnl'], sl: ['algosl', 'sl'], target: ['algotgt', 'target', 'tgt'],
  rr: ['algorr', 'rr'], confirmed: ['confirmed'], spread: ['spread'],
  spot: ['niftyspot', 'spot'], notes: ['notes'],
}
const normHeader = h => (h || '').toLowerCase().replace(/[^a-z]/g, '')

function mapImportColumns(headerRow) {
  const norm = headerRow.map(normHeader)
  const map = {}
  const used = new Set()
  for (const [field, aliases] of Object.entries(IMPORT_ALIASES)) {
    for (const alias of aliases) {
      const idx = norm.findIndex((h, i) => !used.has(i) && h.includes(alias))
      if (idx >= 0) { map[field] = idx; used.add(idx); break }
    }
  }
  return map
}

const parseImportMoney = raw => {
  if (raw == null) return null
  const cleaned = String(raw).replace(/[₹,\s]/g, '')
  if (cleaned === '' || cleaned === '-') return null
  const n = parseFloat(cleaned)
  return Number.isFinite(n) ? n : null
}
const normalizeImportSignal = raw => {
  const t = (raw || '').trim()
  const low = t.toLowerCase()
  if (low === 'ce buy' || low === 'ce') return 'CE Buy'
  if (low === 'pe buy' || low === 'pe') return 'PE Buy'
  if (low === 'straddle') return 'Straddle'
  return t
}
const parseImportConfirmed = raw => {
  const low = (raw || '').trim().toLowerCase()
  if (low === 'true' || low === 'yes') return true
  if (low === 'false' || low === 'no') return false
  return undefined
}
const hashStr = s => { let h = 0; for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0; return Math.abs(h) }

function parseImportedTrades(text) {
  const rows = parseDelimited(text.trim())
  if (!rows.length) return { trades: [], skipped: 0, total: 0 }

  const looksLikeHeader = rows[0].some(c => normHeader(c).includes('date')) &&
    rows[0].some(c => normHeader(c).includes('signal') || normHeader(c).includes('pnl'))
  const map = looksLikeHeader ? mapImportColumns(rows[0]) : mapImportColumns(
    ['date', 'time', 'regime', 'signal', 'strike', 'entry', 'exit', 'pnl', 'sl', 'target', 'rr', 'rrachieved', 'confirmed', 'spread', 'spot', 'notes']
  )
  const dataRows = looksLikeHeader ? rows.slice(1) : rows
  const get = (r, field) => map[field] != null ? (r[map[field]] ?? '').trim() : ''

  const trades = []
  let skipped = 0
  for (const r of dataRows) {
    const strike = parseImportMoney(get(r, 'strike'))
    const entryLTP = parseImportMoney(get(r, 'entry'))
    const exitPrice = parseImportMoney(get(r, 'exit'))
    let pnl = parseImportMoney(get(r, 'pnl'))
    if (pnl == null && entryLTP != null && exitPrice != null) pnl = Math.round((exitPrice - entryLTP) * LOT)

    // Sanity filter: a real trade needs a plausible Nifty strike, or (failing that) a
    // recognized signal plus a pnl. Numeric-looking junk alone (e.g. a misaligned row
    // or a pasted JSON fragment) isn't enough — this is what keeps those out.
    const strikePlausible = strike != null && strike >= 5000 && strike <= 100000
    const signal = normalizeImportSignal(get(r, 'signal'))
    const hasRecognizedSignal = ['CE Buy', 'PE Buy', 'Straddle'].includes(signal)
    if (!strikePlausible && !(hasRecognizedSignal && pnl != null)) { skipped++; continue }

    const date = parseImportDateStr(get(r, 'date'))
    trades.push({
      date, time: get(r, 'time'), regime: get(r, 'regime') || '—',
      signal, strike: strike ?? null, entryLTP, exitPrice, pnl,
      sl: parseImportMoney(get(r, 'sl')), target: parseImportMoney(get(r, 'target')),
      rr: parseImportMoney(get(r, 'rr')), confirmed: parseImportConfirmed(get(r, 'confirmed')),
      spread: parseImportMoney(get(r, 'spread')), spot: parseImportMoney(get(r, 'spot')),
    })
  }
  return { trades, skipped, total: dataRows.length }
}

function parseImportDateStr(raw) {
  const d = parseINDate(raw)
  return d ? `${d.getDate()}/${d.getMonth() + 1}/${d.getFullYear()}` : ''
}
const tradeSignature = t => `${t.date}|${t.time}|${t.strike}|${t.entryLTP}|${t.exitPrice}|${t.pnl}`

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const BC = { BULLISH: '#22c55e', 'CAUTIOUSLY BULLISH': '#86efac', 'CAUTIOUSLY BEARISH': '#fb923c', BEARISH: '#ef4444', NEUTRAL: '#94a3b8' }
const RC = { 'CE Buy': '#22c55e', 'PE Buy': '#ef4444', Straddle: '#fb923c', 'No Trade': '#64748b', Wait: '#f59e0b' }
const REVERSAL_COL = { BOUNCE: '#22c55e', REJECTION: '#ef4444' }

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tick, setTick] = useState(0)
  const [data, setData] = useState(null)
  const [err, setErr] = useState(null)
  const [loading, setLoading] = useState(false)
  const [updated, setUpdated] = useState(null)
  const [expiry, setExpiry] = useState(null)
  const [expiries, setExpiries] = useState([])
  const [showLog, setShowLog] = useState(false)
  const [showPerf, setShowPerf] = useState(true)
  const [exitingId, setExitingId] = useState(null)
  const [exitInput, setExitInput] = useState('')
  const [showImport, setShowImport] = useState(false)
  const [importText, setImportText] = useState('')
  const [importMsg, setImportMsg] = useState('')
  const belowPDLRef = useRef(0)
  const prevATMRef = useRef({ ceLtp: null, peLtp: null })
  const [atmSignals, setAtmSignals] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nifty_atm_signals') || '[]') } catch { return [] }
  })
  const [showAtmLog, setShowAtmLog] = useState(true)
  const [tradeLog, setTradeLog] = useState(() => {
    try { return JSON.parse(localStorage.getItem('nifty_tradelog') || '[]') } catch { return [] }
  })

  // Load expiries once
  useEffect(() => {
    api('option-contract', { instrument_key: 'NSE_INDEX|Nifty 50' })
      .then(res => {
        const list = [...new Set(res.data.map(i => i.expiry))].sort()
        const nearest = list.find(e => e >= todayStr()) || list[0]
        setExpiries(list.slice(0, 6))
        setExpiry(nearest)
      }).catch(e => setErr('Expiry load failed: ' + e.message))
  }, [])

  // Fetch when expiry or tick changes
  useEffect(() => {
    if (!expiry) return
    setLoading(true)
    setErr(null)
    const to = todayStr()
    const from = (() => { const d = new Date(); d.setDate(d.getDate() - 5); return d.toISOString().split('T')[0] })()
    Promise.allSettled([
      api('option-chain', { instrument_key: 'NSE_INDEX|Nifty 50', expiry_date: expiry }),
      api('change-oi', { instrument_key: 'NSE_INDEX|Nifty 50', expiry, date: to, interval: 1 }),
      api('historical', { to_date: to, from_date: from }),
      api('intraday'),
      api('vix-intraday'),
      api('intraday-5min'),
    ]).then(([r1, r2, r3, r4, r5, r6]) => {
      if (r1.status === 'rejected') throw new Error('Chain failed')
      const chain = r1.value.data
      const spot = safe(() => chain[0].underlying_spot_price, 0)
      const oiData = r2.status === 'fulfilled' ? safe(() => r2.value.data) : null
      const hc = r3.status === 'fulfilled' ? safe(() => r3.value.data?.candles || [], []) : []
      const pdh = hc.length ? safe(() => hc[0][2]) : null
      const pdl = hc.length ? safe(() => hc[0][3]) : null
      // Prior day context: yesterday close + day before close for multi-day trend
      const prevClose = hc.length ? safe(() => hc[0][4]) : null
      const prev2Close = hc.length >= 2 ? safe(() => hc[1][4]) : null
      const ic = r4.status === 'fulfilled' ? safe(() => r4.value.data?.candles || null) : null
      const vc = r5.status === 'fulfilled' ? safe(() => r5.value.data?.candles || [], []) : []
      const vix = vc.length ? safe(() => vc[vc.length - 1][4]) : null
      const ic5 = r6.status === 'fulfilled' ? safe(() => r6.value.data?.candles || null) : null

      const rows = safe(() => chain.map(s => ({
        strike: s.strike_price,
        ce_oi: s.call_options.market_data.oi || 0,
        ce_prev_oi: s.call_options.market_data.prev_oi || 0,
        ce_ltp: s.call_options.market_data.ltp || 0,
        ce_bid: s.call_options.market_data.bid_price || 0,
        ce_ask: s.call_options.market_data.ask_price || 0,
        ce_iv: s.call_options.option_greeks.iv || 0,
        ce_delta: s.call_options.option_greeks.delta || 0,
        ce_theta: s.call_options.option_greeks.theta || 0,
        pe_oi: s.put_options.market_data.oi || 0,
        pe_prev_oi: s.put_options.market_data.prev_oi || 0,
        pe_ltp: s.put_options.market_data.ltp || 0,
        pe_bid: s.put_options.market_data.bid_price || 0,
        pe_ask: s.put_options.market_data.ask_price || 0,
        pe_iv: s.put_options.option_greeks.iv || 0,
        pe_delta: s.put_options.option_greeks.delta || 0,
        pe_theta: s.put_options.option_greeks.theta || 0,
      })), [])

      const dte = Math.max(0, Math.round((new Date(expiry) - new Date(to)) / 86400000))
      const near = rows.filter(r => Math.abs(r.strike - spot) <= NTM)
      const ceW = [...near].sort((a, b) => b.ce_oi - a.ce_oi).slice(0, 3)
      const peW = [...near].sort((a, b) => b.pe_oi - a.pe_oi).slice(0, 3)

      // Update false breakdown streak
      if (pdl && spot < pdl) belowPDLRef.current = belowPDLRef.current + 1
      else belowPDLRef.current = 0

      const a = safe(() => analyse(rows, spot, dte, oiData, vix, pdh, pdl, ic, prevClose, prev2Close, ic5))
      const rec = safe(() => getRec(rows, spot, a, vix, ic5, belowPDLRef.current), { type: 'No Trade', logic: 'Analysis error' })

      // ATM crossover detection
      const atmRow = rows.length ? rows.reduce((b, r) => Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b, rows[0]) : null
      const atmCeLtp = atmRow?.ce_ltp ?? null
      const atmPeLtp = atmRow?.pe_ltp ?? null
      const { ceLtp: prevCe, peLtp: prevPe } = prevATMRef.current
      const crossover = detectATMCrossover(prevCe, prevPe, atmCeLtp, atmPeLtp)
      if (crossover) {
        const sig = {
          id: Date.now(),
          date: new Date().toLocaleDateString('en-IN'),
          time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
          type: crossover.type,
          reason: crossover.reason,
          strike: atmRow.strike,
          ceLtp: atmCeLtp,
          peLtp: atmPeLtp,
          spot,
        }
        setAtmSignals(prev => {
          const next = [sig, ...prev].slice(0, 20)
          try { localStorage.setItem('nifty_atm_signals', JSON.stringify(next)) } catch {}
          return next
        })
      }
      prevATMRef.current = { ceLtp: atmCeLtp, peLtp: atmPeLtp }

      // Combined OI + ATM signal — crossover bonus applies only if one fired this cycle
      const combinedSignal = safe(() => getCombinedSignal(a, atmCeLtp, atmPeLtp, crossover?.type ?? null))

      setData({ spot, rows, dte, ceW, peW, a, rec, vix, pdh, pdl, prevClose, prev2Close, atmCeLtp, atmPeLtp, atmStrike: atmRow?.strike, combinedSignal })
      setUpdated(new Date())
    }).catch(e => setErr(String(e?.message || e)))
      .finally(() => setLoading(false))
  }, [expiry, tick])

  // Auto-refresh every 15 min during market hours
  useEffect(() => {
    const t = setInterval(() => { if (isOpen()) setTick(c => c + 1) }, 15 * 60 * 1000)
    return () => clearInterval(t)
  }, [])

  // Trade log functions
  const logEntry = () => {
    if (!data?.rec || !['CE Buy', 'PE Buy'].includes(data.rec.type)) return
    const rec = data.rec
    const entry = {
      id: Date.now(),
      date: new Date().toLocaleDateString('en-IN'),
      time: new Date().toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }),
      regime: data.a?.regime || '—',
      signal: rec.type,
      strike: rec.strike,
      entryLTP: rec.ltp,
      sl: rec.levels?.optionSL,
      target: rec.levels?.optionTGT,
      rr: rec.levels?.rr,
      spread: rec.spread,
      confirmed: rec.confirmed,
      spot: data.spot,
      exitPrice: null,
      pnl: null,
    }
    const newLog = [entry, ...tradeLog].slice(0, 500)
    setTradeLog(newLog)
    try { localStorage.setItem('nifty_tradelog', JSON.stringify(newLog)) } catch {}
  }

  const saveExit = (id) => {
    const price = parseFloat(exitInput)
    if (isNaN(price) || price <= 0) return
    const newLog = tradeLog.map(t => {
      if (t.id !== id) return t
      const pnl = Math.round((price - t.entryLTP) * LOT)  // always long: exit - entry × lots
      return { ...t, exitPrice: price, pnl }
    })
    setTradeLog(newLog)
    try { localStorage.setItem('nifty_tradelog', JSON.stringify(newLog)) } catch {}
    setExitingId(null)
    setExitInput('')
  }

  const importTrades = (text) => {
    if (!text || !text.trim()) return
    const { trades, skipped } = parseImportedTrades(text)
    const existingSigs = new Set(tradeLog.map(tradeSignature))
    let dupes = 0
    const fresh = []
    for (const t of trades) {
      const sig = tradeSignature(t)
      if (existingSigs.has(sig)) { dupes++; continue }
      existingSigs.add(sig)
      fresh.push({ id: 900000000000 + hashStr(sig), exitPrice: t.exitPrice ?? null, ...t })
    }
    const newLog = [...fresh, ...tradeLog].slice(0, 500)
    setTradeLog(newLog)
    try { localStorage.setItem('nifty_tradelog', JSON.stringify(newLog)) } catch {}
    setImportMsg(`Imported ${fresh.length} trade${fresh.length === 1 ? '' : 's'}` +
      (dupes ? ` · ${dupes} duplicate${dupes === 1 ? '' : 's'} skipped` : '') +
      (skipped ? ` · ${skipped} row${skipped === 1 ? '' : 's'} unrecognized` : ''))
    setImportText('')
  }

  const handleImportFile = (e) => {
    const file = e.target.files?.[0]
    if (!file) return
    const reader = new FileReader()
    reader.onload = () => importTrades(String(reader.result || ''))
    reader.readAsText(file)
    e.target.value = ''
  }

  const perf = useMemo(() => computeDailyStats(tradeLog), [tradeLog])

  const a = data?.a
  const bias = a?.bias || 'NEUTRAL'
  const bc = BC[bias] || '#94a3b8'
  const conv = a?.conv || 0

  return (
    <div style={{ background: '#070a0f', minHeight: '100vh', color: '#e2e8f0', fontFamily: "'JetBrains Mono',monospace", padding: '0 0 80px' }}>

      {/* Header */}
      <div style={{ background: '#0d1117', borderBottom: '1px solid #1e2a3a', padding: '14px 16px', position: 'sticky', top: 0, zIndex: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
          <div>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 18, color: '#f8fafc' }}>NIFTY OPTIONS</div>
            <div style={{ fontSize: 10, color: '#475569', marginTop: 1 }}>
              {updated ? updated.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', timeZone: 'Asia/Kolkata' }) + ' IST' : 'Loading...'}
              {' · '}<span style={{ color: isOpen() ? '#22c55e' : '#ef4444' }}>{isOpen() ? '● LIVE' : '● CLOSED'}</span>
              {data?.vix != null && <span style={{ marginLeft: 8, color: data.vix > 16 ? '#fb923c' : '#64748b' }}>VIX {data.vix.toFixed(1)}</span>}
            </div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 22, color: '#f8fafc' }}>
              {data ? `₹${data.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 })}` : '—'}
            </div>
            <button onClick={() => setTick(c => c + 1)} disabled={loading}
              style={{ background: loading ? '#1e2a3a' : '#1d4ed8', border: 'none', borderRadius: 4, color: '#fff', fontSize: 10, padding: '3px 10px', cursor: loading ? 'default' : 'pointer', fontFamily: 'inherit', marginTop: 2 }}>
              {loading ? 'LOADING...' : '↻ REFRESH'}
            </button>
          </div>
        </div>
        <div style={{ display: 'flex', gap: 6, marginTop: 10, overflowX: 'auto', paddingBottom: 2 }}>
          {expiries.map(e => (
            <button key={e} onClick={() => setExpiry(e)}
              style={{ background: expiry === e ? '#1d4ed8' : '#1e2a3a', border: 'none', borderRadius: 4, color: expiry === e ? '#fff' : '#94a3b8', fontSize: 10, padding: '5px 10px', cursor: 'pointer', whiteSpace: 'nowrap', fontFamily: 'inherit' }}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {err && <div style={{ margin: 16, padding: 12, background: '#1c0a0a', border: '1px solid #7f1d1d', borderRadius: 8, color: '#fca5a5', fontSize: 12 }}>⚠ {err}</div>}

      {data && a && (<>
        {a.timeWarning && <div style={{ margin: '12px 12px 0', padding: '10px 14px', background: '#1c1400', border: '1px solid #92400e', borderRadius: 8, color: '#fbbf24', fontSize: 12 }}>⏰ {a.timeWarning}</div>}

        {/* Bias */}
        <div style={{ margin: '12px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: `1px solid ${bc}33` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
            <div>
              <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>MARKET BIAS</div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 26, color: bc, lineHeight: 1 }}>{bias}</div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>±{a.emRound} pts · PCR {a.pcr} · MP {a.maxPain}</div>
            </div>
            <div style={{ textAlign: 'right' }}>
              <div style={{ fontSize: 10, color: '#475569', marginBottom: 4 }}>CONVICTION</div>
              <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 36, color: conv >= 50 ? '#22c55e' : conv >= 30 ? '#fb923c' : '#64748b', lineHeight: 1 }}>{conv}%</div>
              <div style={{ width: 80, height: 4, background: '#1e2a3a', borderRadius: 2, marginTop: 6, marginLeft: 'auto' }}>
                <div style={{ width: `${Math.min(conv, 100)}%`, height: '100%', background: conv >= 50 ? '#22c55e' : conv >= 30 ? '#fb923c' : '#475569', borderRadius: 2 }} />
              </div>
            </div>
          </div>
          <div style={{ marginTop: 12, borderTop: '1px solid #1e2a3a', paddingTop: 10 }}>
            {a.reasons.slice(0, 5).map((r, i) => (
              <div key={i} style={{ fontSize: 11, color: i === 0 ? '#cbd5e1' : '#64748b', padding: '3px 0', lineHeight: 1.4 }}>
                <span style={{ color: '#334155', marginRight: 6 }}>{i + 1}.</span>{r}
              </div>
            ))}
          </div>
        </div>

        {/* VIX / PDH PDL / Trend */}
        <div style={{ margin: '10px 12px 0', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
          {[
            { label: 'INDIA VIX', val: data.vix != null ? data.vix.toFixed(1) : '—', sub: a.vixZone, color: data.vix > 16 ? '#fb923c' : data.vix < 13 ? '#22c55e' : '#94a3b8' },
            { label: 'PDH / PDL', val: data.pdh ? data.pdh.toFixed(0) : '—', val2: data.pdl ? data.pdl.toFixed(0) : '—', sub: 'high / low' },
            { label: '30M TREND', val: a.trend === 'up' ? '↑' : a.trend === 'down' ? '↓' : '→', sub: a.tNet3 != null ? `${a.trend} (net3 ${a.tNet3 >= 0 ? '+' : ''}${a.tNet3.toFixed(0)}pts)` : a.trend, color: a.trend === 'up' ? '#22c55e' : a.trend === 'down' ? '#ef4444' : '#94a3b8' },
          ].map(({ label, val, val2, sub, color }) => (
            <div key={label} style={{ background: '#0d1117', borderRadius: 10, border: '1px solid #1e2a3a', padding: '10px 12px' }}>
              <div style={{ fontSize: 9, color: '#475569', marginBottom: 4 }}>{label}</div>
              <div style={{ fontSize: val2 ? 12 : 20, fontWeight: 700, color: color || '#f8fafc' }}>{val}</div>
              {val2 && <div style={{ fontSize: 12, fontWeight: 700, color: '#22c55e' }}>{val2}</div>}
              <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Channel */}
        <div style={{ margin: '10px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: `1px solid ${a.nearSup ? '#22c55e33' : a.nearRes ? '#ef444433' : '#1e2a3a'}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
            <div style={{ fontSize: 10, color: '#475569' }}>
              CHANNEL POSITION
              {a.nearSup && <span style={{ color: '#22c55e', marginLeft: 8, fontWeight: 700 }}>● NEAR SUPPORT</span>}
              {a.nearRes && <span style={{ color: '#ef4444', marginLeft: 8, fontWeight: 700 }}>● NEAR RESISTANCE</span>}
            </div>
            <div style={{
              fontSize: 10, fontWeight: 700, padding: '3px 8px', borderRadius: 4,
              background: a.regime === 'CHANNELING' ? '#14532d' : a.regime.includes('UP') ? '#1e3a5f' : a.regime.includes('DOWN') ? '#3b0000' : '#1c1917',
              color: a.regime === 'CHANNELING' ? '#4ade80' : a.regime.includes('UP') ? '#60a5fa' : a.regime.includes('DOWN') ? '#f87171' : '#d6d3d1'
            }}>{a.regime}</div>
          </div>
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 4, marginBottom: 10 }}>
            {[
              [a.insidePDHL, 'Inside PDH/PDL'],
              [a.tightRange, `Tight (${a.dayRange} vs ±${a.emRound})`],
              [!a.sustained, 'No sustained trend'],
            ].map(([ok, label]) => (
              <div key={label} style={{ fontSize: 10, color: ok ? '#4ade80' : '#f87171', textAlign: 'center' }}>{ok ? '✓' : '✗'} {label}</div>
            ))}
          </div>
          <div style={{ position: 'relative', height: 40 }}>
            <div style={{ position: 'absolute', top: 16, left: 0, right: 0, height: 8, background: '#1e2a3a', borderRadius: 4 }}>
              <div style={{ position: 'absolute', left: 0, width: '25%', height: '100%', background: '#22c55e22', borderRadius: '4px 0 0 4px' }} />
              <div style={{ position: 'absolute', right: 0, width: '25%', height: '100%', background: '#ef444422', borderRadius: '0 4px 4px 0' }} />
              <div style={{ position: 'absolute', left: `${Math.max(2, Math.min(96, (a.wallPos || 0.5) * 100))}%`, top: '50%', transform: 'translate(-50%,-50%)', width: 14, height: 14, background: bc, borderRadius: '50%', boxShadow: `0 0 8px ${bc}88`, zIndex: 2 }} />
            </div>
            <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 30 }}>
              <div style={{ fontSize: 11, color: '#22c55e' }}>⬆ {a.S}</div>
              <div style={{ fontSize: 11, color: '#64748b' }}>{a.wallZone}</div>
              <div style={{ fontSize: 11, color: '#ef4444' }}>{a.R} ⬇</div>
            </div>
          </div>
        </div>

        {/* Walls */}
        <div style={{ margin: '10px 12px 0', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
          {[{ title: 'CE WALLS', color: '#ef4444', walls: data.ceW, ok: 'ce_oi' }, { title: 'PE WALLS', color: '#22c55e', walls: data.peW, ok: 'pe_oi' }].map(({ title, color, walls, ok }) => (
            <div key={title} style={{ background: '#0d1117', borderRadius: 12, border: '1px solid #1e2a3a', padding: 12 }}>
              <div style={{ fontSize: 10, color, marginBottom: 8, fontWeight: 700 }}>{title}</div>
              {walls.map((w, i) => (
                <div key={i} style={{ display: 'flex', justifyContent: 'space-between', padding: '4px 0', borderBottom: i < 2 ? '1px solid #0f172a' : 'none' }}>
                  <div style={{ fontSize: 12 }}>{w.strike}</div>
                  <div style={{ fontSize: 11, color }}>{fmtOI(w[ok])}</div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Open Position Tracker — shows status of any trade with no exit logged yet */}
        {(() => {
          const openPos = tradeLog.find(t => t.pnl === null && t.exitPrice === null)
          if (!openPos || !data?.rows) return null

          const side = openPos.signal === 'CE Buy' ? 'ce' : 'pe'
          const row = data.rows.find(r => r.strike === openPos.strike)
          const liveLTP = row ? row[`${side}_ltp`] : null
          const livePnl = liveLTP != null ? Math.round((liveLTP - openPos.entryLTP) * LOT) : null

          const distToSL = liveLTP != null && openPos.sl != null ? +(liveLTP - openPos.sl).toFixed(1) : null
          const distToTGT = liveLTP != null && openPos.target != null ? +(openPos.target - liveLTP).toFixed(1) : null
          const nearSL = distToSL != null && distToSL <= (openPos.entryLTP - openPos.sl) * 0.25
          const nearTGT = distToTGT != null && distToTGT <= (openPos.target - openPos.entryLTP) * 0.25

          // Thesis check: has the regime changed since entry, or flipped direction?
          const currentRegime = data.a?.regime || '—'
          const regimeChanged = openPos.regime && currentRegime !== '—' && openPos.regime !== currentRegime
          const oppositeSignalNow = data.rec && (
            (openPos.signal === 'CE Buy' && data.rec.type === 'PE Buy') ||
            (openPos.signal === 'PE Buy' && data.rec.type === 'CE Buy')
          )

          return (
            <div style={{ margin: '10px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: `2px solid ${livePnl >= 0 ? '#22c55e' : '#ef4444'}88` }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 8 }}>
                <div style={{ fontSize: 10, color: '#475569', fontWeight: 700 }}>YOUR OPEN POSITION</div>
                <div style={{ fontSize: 10, color: '#334155' }}>{openPos.time} · entered {openPos.regime}</div>
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
                <div>
                  <span style={{ fontSize: 16, fontWeight: 800, color: openPos.signal === 'CE Buy' ? '#22c55e' : '#ef4444' }}>{openPos.signal}</span>
                  <span style={{ fontSize: 14, color: '#e2e8f0', marginLeft: 8 }}>{openPos.strike}{openPos.signal === 'CE Buy' ? 'C' : 'P'}</span>
                </div>
                {livePnl != null && (
                  <div style={{ fontSize: 18, fontWeight: 800, color: livePnl >= 0 ? '#22c55e' : '#ef4444' }}>
                    {livePnl >= 0 ? '+' : ''}₹{livePnl.toLocaleString('en-IN')}
                  </div>
                )}
              </div>
              <div style={{ fontSize: 11, color: '#64748b', marginTop: 6 }}>
                Entry ₹{openPos.entryLTP} → LTP {liveLTP != null ? `₹${liveLTP}` : '—'}
                {openPos.sl != null && <span> · SL ₹{openPos.sl}</span>}
                {openPos.target != null && <span> · TGT ₹{openPos.target}</span>}
              </div>
              {nearSL && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#ef4444', fontWeight: 600 }}>⚠ Close to SL ({distToSL} pts away) — watch closely</div>
              )}
              {nearTGT && !nearSL && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#22c55e', fontWeight: 600 }}>✓ Approaching target ({distToTGT} pts away) — consider booking</div>
              )}
              {regimeChanged && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#fb923c' }}>⚠ Thesis check: regime was {openPos.regime} at entry, now {currentRegime} — re-evaluate</div>
              )}
              {oppositeSignalNow && (
                <div style={{ marginTop: 8, fontSize: 11, color: '#fb923c', fontWeight: 600 }}>⚠ Fresh scan below is now showing the OPPOSITE side — market may be reversing</div>
              )}
            </div>
          )
        })()}

        {/* Combined Signal — OI + ATM crossover */}
        {data.combinedSignal && (() => {
          const cs = data.combinedSignal
          const isActionable = cs.aligned && cs.type !== 'No Signal'
          const sigColor = cs.type === 'CE Buy' ? '#22c55e' : cs.type === 'PE Buy' ? '#ef4444' : '#475569'
          const strengthBg = cs.strength === 'STRONG' ? '#14532d' : cs.strength === 'MODERATE' ? '#1c2a1c' : '#1c1917'
          const strengthCol = cs.strength === 'STRONG' ? '#4ade80' : cs.strength === 'MODERATE' ? '#86efac' : '#a8a29e'
          return (
            <div style={{
              margin: '10px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12,
              border: `2px solid ${isActionable ? sigColor + '55' : '#1e2a3a'}`,
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 12 }}>
                <div>
                  <div style={{ fontSize: 9, color: '#60a5fa', marginBottom: 4, fontWeight: 700, letterSpacing: 1 }}>
                    COMBINED SIGNAL · OI + ATM PRICE
                  </div>
                  {isActionable ? (
                    <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 22, color: sigColor, lineHeight: 1 }}>
                      {cs.type === 'CE Buy' ? '▲ BUY CALL' : '▼ BUY PUT'}
                    </div>
                  ) : (
                    <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 16, color: '#475569', lineHeight: 1 }}>
                      {cs.type === 'No Signal' ? 'NO SIGNAL' : 'SIGNALS CONFLICTING'}
                    </div>
                  )}
                </div>
                {isActionable && (
                  <div style={{ textAlign: 'right' }}>
                    <div style={{ fontSize: 11, fontWeight: 700, padding: '4px 10px', borderRadius: 6, background: strengthBg, color: strengthCol }}>
                      {cs.strength}
                    </div>
                    <div style={{ fontSize: 10, color: '#475569', marginTop: 4 }}>{cs.conv}% conviction</div>
                  </div>
                )}
              </div>

              {/* Three-column score breakdown */}
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 14px 1fr 14px 1fr', gap: 4, alignItems: 'center' }}>
                {[
                  { label: 'OI ANALYSIS', vote: cs.oiVote, sub: cs.oiVote > 0.05 ? 'bullish' : cs.oiVote < -0.05 ? 'bearish' : 'neutral' },
                  null,
                  { label: 'ATM PREMIUM', vote: cs.atmVote, sub: cs.atmVote > 0 ? 'CE dominant' : cs.atmVote < 0 ? 'PE dominant' : 'neutral' },
                  null,
                  { label: 'COMBINED', vote: cs.finalScore, sub: isActionable ? cs.strength : cs.type === 'Conflicting' ? 'split' : '—', highlight: true },
                ].map((col, i) => col === null ? (
                  <div key={i} style={{ textAlign: 'center', fontSize: 12, color: '#334155', fontWeight: 700 }}>+</div>
                ) : (
                  <div key={i} style={{
                    background: col.highlight && isActionable ? (cs.type === 'CE Buy' ? '#052e16' : '#2d0a0a') : '#0a0f1a',
                    borderRadius: 8, padding: '8px 4px', textAlign: 'center',
                    border: col.highlight && isActionable ? `1px solid ${sigColor}33` : '1px solid #1e2a3a',
                  }}>
                    <div style={{ fontSize: 9, color: '#475569', marginBottom: 3 }}>{col.label}</div>
                    <div style={{ fontSize: 15, fontWeight: 800, color: col.vote > 0.05 ? '#22c55e' : col.vote < -0.05 ? '#ef4444' : '#94a3b8' }}>
                      {col.vote >= 0 ? '+' : ''}{(col.vote * 100).toFixed(0)}%
                    </div>
                    <div style={{ fontSize: 9, color: '#334155', marginTop: 2 }}>{col.sub}</div>
                  </div>
                ))}
              </div>

              {/* Status line */}
              <div style={{ marginTop: 10, fontSize: 11 }}>
                {cs.crossoverAgrees && (
                  <div style={{ color: '#22c55e', fontWeight: 600 }}>✓ ATM price crossover just fired in the same direction — high conviction</div>
                )}
                {cs.aligned && !cs.crossoverAgrees && (
                  <div style={{ color: '#64748b' }}>OI and ATM premium both point {cs.type === 'CE Buy' ? 'bullish' : 'bearish'} — no fresh crossover this cycle</div>
                )}
                {!cs.aligned && (
                  <div style={{ color: '#fb923c' }}>⚠ OI and ATM premium are pointing in opposite directions — wait for alignment before trading</div>
                )}
              </div>
            </div>
          )
        })()}

        {/* Trade */}
        {data.rec && (
          <div style={{ margin: '10px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: `1px solid ${RC[data.rec.type] || '#334155'}55` }}>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 10 }}>{tradeLog.some(t => t.pnl === null && t.exitPrice === null) ? 'FRESH SIGNAL (current scan)' : 'RECOMMENDED TRADE'}</div>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontFamily: "'Syne',sans-serif", fontWeight: 800, fontSize: 20, color: RC[data.rec.type] || '#64748b' }}>{data.rec.type}</div>

                {data.rec.isReversal && (
                  <div style={{ fontSize: 10, fontWeight: 700, marginTop: 3, color: REVERSAL_COL[data.rec.reversalType] || '#94a3b8' }}>
                    ↩ {data.rec.reversalType} · 5-min confirmed
                  </div>
                )}
                {data.rec.strike && <div style={{ fontSize: 22, fontWeight: 700, color: '#f8fafc', marginTop: 2 }}>{data.rec.strike}{data.rec.type === 'CE Buy' ? 'C' : data.rec.type === 'PE Buy' ? 'P' : ''}</div>}
              </div>
            </div>
            {data.rec.ltp && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>
                LTP ₹{data.rec.ltp} · Δ {Math.abs(data.rec.delta || 0).toFixed(2)} · {Math.abs(data.rec.moneyness || 0)} pts {(data.rec.moneyness || 0) >= 0 ? 'ITM' : 'OTM'} · θ {(data.rec.theta || 0).toFixed(0)}/day · IV {(data.rec.iv || 0).toFixed(0)}
                {data.rec.spread != null && <span style={{ marginLeft: 8, color: data.rec.spreadWide ? '#fb923c' : '#64748b' }}>· Spread ₹{data.rec.spread}{data.rec.spreadWide ? ' ⚠' : ''}</span>}
              </div>
            )}
            {data.rec.ceLtp && <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>CE ₹{data.rec.ceLtp} + PE ₹{data.rec.peLtp}</div>}
            <div style={{ marginTop: 8, fontSize: 11, color: '#475569', fontStyle: 'italic' }}>{data.rec.logic}</div>
            {data.rec.confirmed === false && (
              <div style={{ marginTop: 4, fontSize: 11, color: '#fb923c' }}>
                ⚠ Unconfirmed {data.rec.type === 'PE Buy' ? 'breakdown' : data.rec.type === 'CE Buy' ? 'breakout' : 'signal'} — OI structure doesn't fully support direction, size down or wait
              </div>
            )}


            {/* Levels */}
            {data.rec.levels && (() => {
              const lv = data.rec.levels
              const rrCol = lv.rr >= 2 ? '#22c55e' : lv.rr >= 1.5 ? '#86efac' : '#fb923c'
              return (
                <div style={{ marginTop: 12, padding: 12, background: '#0a0f1a', borderRadius: 8, border: '1px solid #1e2a3a' }}>
                  <div style={{ fontSize: 10, color: '#475569', marginBottom: 10, fontWeight: 700 }}>TRADE LEVELS</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 8 }}>
                    {[
                      { label: 'ENTRY', val: lv.optionEntry, col: '#f8fafc', bg: '#111827', diff: null },
                      { label: 'STOP LOSS', val: lv.optionSL, col: '#ef4444', bg: '#1c0a0a', diff: `-₹${(lv.optionEntry - lv.optionSL).toFixed(1)}` },
                      { label: 'TARGET', val: lv.optionTGT, col: '#22c55e', bg: '#052e16', diff: `+₹${(lv.optionTGT - lv.optionEntry).toFixed(1)}` },
                    ].map(({ label, val, col, bg, diff }) => (
                      <div key={label} style={{ textAlign: 'center', background: bg, borderRadius: 6, padding: '10px 6px' }}>
                        <div style={{ fontSize: 9, color: col === '#f8fafc' ? '#475569' : col, marginBottom: 4 }}>{label}</div>
                        <div style={{ fontSize: 18, fontWeight: 700, color: col }}>₹{val}</div>
                        {diff && <div style={{ fontSize: 9, color: '#475569', marginTop: 2 }}>{diff}</div>}
                      </div>
                    ))}
                  </div>
                  {lv.rr > 0 && <div style={{ marginTop: 8, textAlign: 'center', fontSize: 12, fontWeight: 700, color: rrCol }}>R:R {lv.rr}:1</div>}
                </div>
              )
            })()}

            {['CE Buy', 'PE Buy'].includes(data.rec.type) && (
              <button onClick={logEntry}
                style={{ marginTop: 12, width: '100%', padding: 10, background: '#1e3a5f', border: '1px solid #3b82f6', borderRadius: 6, color: '#60a5fa', fontSize: 12, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                📝 Log Entry at ₹{data.rec.ltp}
              </button>
            )}
          </div>
        )}

        {/* OI Change */}
        {(a.bld.bull > 0 || a.bld.bear > 0) && (
          <div style={{ margin: '10px 12px 0', padding: 14, background: '#0d1117', borderRadius: 12, border: '1px solid #1e2a3a' }}>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 8 }}>OI CHANGE (TODAY vs YESTERDAY)</div>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8 }}>
              <div style={{ background: '#052e16', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#4ade80' }}>PUT SUPPORT</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#22c55e', marginTop: 2 }}>{fmtOI(a.bld.bull)}</div>
              </div>
              <div style={{ background: '#2d0a0a', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                <div style={{ fontSize: 10, color: '#f87171' }}>CALL RESIST</div>
                <div style={{ fontSize: 16, fontWeight: 700, color: '#ef4444', marginTop: 2 }}>{fmtOI(a.bld.bear)}</div>
              </div>
            </div>
            <div style={{ marginTop: 8, fontSize: 11, color: '#334155', display: 'flex', justifyContent: 'space-between' }}>
              <span>Total CE: {fmtOI(a.bld.totalCe)}</span>
              <span>Total PE: {fmtOI(a.bld.totalPe)}</span>
            </div>
          </div>
        )}

        {/* ATM Price Crossover Signals */}
        <div style={{ margin: '10px 12px 0', background: '#0d1117', borderRadius: 12, border: '1px solid #1e3a5f', overflow: 'hidden' }}>
          <div onClick={() => setShowAtmLog(s => !s)}
            style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#60a5fa' }}>ATM PRICE CROSSOVER</div>
              <div style={{ fontSize: 9, color: '#334155', marginTop: 2 }}>Independent of OI signals · Crossover at ATM strike</div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {atmSignals.length > 0 && (
                <div style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                  background: atmSignals[0].type === 'CE Buy' ? '#052e16' : '#2d0a0a',
                  color: atmSignals[0].type === 'CE Buy' ? '#4ade80' : '#f87171',
                }}>
                  Latest: {atmSignals[0].type}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#334155' }}>{showAtmLog ? '▲' : '▼'}</div>
            </div>
          </div>

          {showAtmLog && (
            <div style={{ borderTop: '1px solid #1e2a3a' }}>
              {/* Live ATM price comparison */}
              {data.atmCeLtp != null && data.atmPeLtp != null && (
                <div style={{ padding: '12px 16px', borderBottom: '1px solid #0f172a' }}>
                  <div style={{ fontSize: 9, color: '#475569', marginBottom: 8 }}>ATM STRIKE {data.atmStrike} — LIVE PRICES</div>
                  <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 6, alignItems: 'center' }}>
                    <div style={{
                      textAlign: 'center', padding: '10px 8px', borderRadius: 8,
                      background: data.atmCeLtp > data.atmPeLtp ? '#052e16' : '#0d1117',
                      border: `1px solid ${data.atmCeLtp > data.atmPeLtp ? '#22c55e55' : '#1e2a3a'}`,
                    }}>
                      <div style={{ fontSize: 9, color: '#4ade80', marginBottom: 4 }}>ATM CALL</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#22c55e' }}>₹{data.atmCeLtp.toFixed(2)}</div>
                    </div>
                    <div style={{ textAlign: 'center', fontSize: 14, color: '#475569' }}>
                      {data.atmCeLtp > data.atmPeLtp ? '>' : data.atmCeLtp < data.atmPeLtp ? '<' : '='}
                    </div>
                    <div style={{
                      textAlign: 'center', padding: '10px 8px', borderRadius: 8,
                      background: data.atmPeLtp > data.atmCeLtp ? '#2d0a0a' : '#0d1117',
                      border: `1px solid ${data.atmPeLtp > data.atmCeLtp ? '#ef444455' : '#1e2a3a'}`,
                    }}>
                      <div style={{ fontSize: 9, color: '#f87171', marginBottom: 4 }}>ATM PUT</div>
                      <div style={{ fontSize: 20, fontWeight: 800, color: '#ef4444' }}>₹{data.atmPeLtp.toFixed(2)}</div>
                    </div>
                  </div>
                  <div style={{ marginTop: 8, fontSize: 10, textAlign: 'center', color: '#475569' }}>
                    {data.atmCeLtp > data.atmPeLtp
                      ? <span style={{ color: '#22c55e' }}>Call premium dominant — bullish sentiment</span>
                      : data.atmPeLtp > data.atmCeLtp
                        ? <span style={{ color: '#ef4444' }}>Put premium dominant — bearish sentiment</span>
                        : <span style={{ color: '#94a3b8' }}>Call = Put — neutral</span>}
                  </div>
                </div>
              )}

              {/* Signal history */}
              <div style={{ padding: '8px 12px' }}>
                {atmSignals.length === 0 && (
                  <div style={{ fontSize: 11, color: '#334155', padding: '8px 0' }}>
                    No crossover signals yet this session. Signals fire when ATM Call and Put prices cross.
                  </div>
                )}
                {atmSignals.map((s, i) => (
                  <div key={s.id} style={{ padding: '10px 0', borderBottom: i < atmSignals.length - 1 ? '1px solid #0f172a' : 'none' }}>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                      <div>
                        <span style={{
                          fontSize: 12, fontWeight: 800,
                          color: s.type === 'CE Buy' ? '#22c55e' : '#ef4444',
                        }}>
                          {s.type === 'CE Buy' ? '▲ BUY CALL' : '▼ BUY PUT'}
                        </span>
                        <span style={{ fontSize: 11, color: '#64748b', marginLeft: 8 }}>{s.strike}{s.type === 'CE Buy' ? 'C' : 'P'}</span>
                      </div>
                      <div style={{ textAlign: 'right', fontSize: 10, color: '#475569' }}>
                        <div>{s.time}</div>
                        <div style={{ color: '#334155' }}>{s.date}</div>
                      </div>
                    </div>
                    <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>{s.reason}</div>
                    <div style={{ fontSize: 10, color: '#334155', marginTop: 2 }}>
                      Nifty ₹{s.spot?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
                      {' · '}CE ₹{s.ceLtp?.toFixed(2)} · PE ₹{s.peLtp?.toFixed(2)}
                    </div>
                  </div>
                ))}
                {atmSignals.length > 0 && (
                  <button onClick={e => { e.stopPropagation(); setAtmSignals([]); try { localStorage.removeItem('nifty_atm_signals') } catch {} }}
                    style={{ marginTop: 8, background: 'transparent', border: '1px solid #1e2a3a', borderRadius: 4, color: '#334155', padding: '4px 10px', fontSize: 10, cursor: 'pointer', fontFamily: 'inherit' }}>
                    Clear signals
                  </button>
                )}
              </div>
            </div>
          )}
        </div>

        {/* Performance / Daily Backtest */}
        <div style={{ margin: '10px 12px 0', background: '#0d1117', borderRadius: 12, border: '1px solid #1e2a3a', overflow: 'hidden' }}>
          <div onClick={() => setShowPerf(s => !s)}
            style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>PERFORMANCE · DAILY BACKTEST</div>
              <div style={{ fontSize: 9, color: '#334155', marginTop: 2 }}>Profitability of your logged trades, day by day</div>
            </div>
            <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
              {perf.summary && (
                <div style={{
                  fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                  background: perf.summary.totalPnl >= 0 ? '#052e16' : '#2d0a0a',
                  color: perf.summary.totalPnl >= 0 ? '#4ade80' : '#f87171',
                }}>
                  {perf.summary.totalPnl >= 0 ? '+' : ''}₹{perf.summary.totalPnl.toLocaleString('en-IN')}
                </div>
              )}
              <div style={{ fontSize: 11, color: '#334155' }}>{showPerf ? '▲' : '▼'}</div>
            </div>
          </div>

          {showPerf && (
            <div style={{ borderTop: '1px solid #1e2a3a', padding: '14px 16px' }}>
              {/* Import trades from a spreadsheet / CSV export */}
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: showImport ? 10 : 14 }}>
                <div style={{ fontSize: 10, color: '#334155' }}>Have a trade log spreadsheet? Bring it in to include it here.</div>
                <button onClick={() => { setShowImport(s => !s); setImportMsg('') }}
                  style={{ background: 'transparent', border: '1px solid #1e3a5f', borderRadius: 4, color: '#60a5fa', padding: '4px 10px', fontSize: 10, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit', whiteSpace: 'nowrap' }}>
                  {showImport ? '✕ Close' : '⇪ Import trades'}
                </button>
              </div>
              {showImport && (
                <div style={{ marginBottom: 14, padding: 12, background: '#0a0f1a', borderRadius: 8, border: '1px solid #1e2a3a' }}>
                  <div style={{ fontSize: 10, color: '#64748b', marginBottom: 8, lineHeight: 1.5 }}>
                    Paste rows copied from your sheet (or upload a .csv export). Expected columns: date, time, regime,
                    signal, strike, entry, exit, pnl, sl, target, rr, confirmed, spread, spot — header order doesn't
                    matter and missing columns are fine. Duplicate trades are skipped automatically.
                  </div>
                  <textarea value={importText} onChange={e => setImportText(e.target.value)}
                    placeholder={'date,time,regime,signal,strike,entry,exit,pnl,...\n15/6/2026,10:45 AM,TRENDING UP,CE Buy,23900,132.6,162,1911,...'}
                    rows={5}
                    style={{ width: '100%', boxSizing: 'border-box', background: '#0d1117', border: '1px solid #1e2a3a', borderRadius: 6, color: '#cbd5e1', padding: 8, fontSize: 11, fontFamily: 'inherit', resize: 'vertical' }} />
                  <div style={{ display: 'flex', gap: 8, marginTop: 8, alignItems: 'center' }}>
                    <button onClick={() => importTrades(importText)} disabled={!importText.trim()}
                      style={{ background: importText.trim() ? '#1e3a5f' : '#1e2a3a', border: '1px solid #3b82f6', borderRadius: 6, color: importText.trim() ? '#60a5fa' : '#334155', padding: '8px 14px', fontSize: 11, fontWeight: 700, cursor: importText.trim() ? 'pointer' : 'default', fontFamily: 'inherit' }}>
                      Import pasted rows
                    </button>
                    <label style={{ background: '#1e2a3a', border: '1px solid #334155', borderRadius: 6, color: '#94a3b8', padding: '8px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer', fontFamily: 'inherit' }}>
                      Upload .csv
                      <input type="file" accept=".csv,.tsv,text/csv,text/plain" onChange={handleImportFile} style={{ display: 'none' }} />
                    </label>
                  </div>
                  {importMsg && <div style={{ marginTop: 8, fontSize: 11, color: '#4ade80' }}>{importMsg}</div>}
                </div>
              )}

              {!perf.summary ? (
                <div style={{ fontSize: 11, color: '#334155', padding: '8px 0' }}>
                  No closed trades yet. Use “Log Entry” on a recommended trade, then “Log Exit” once you close it —
                  or import a trade log above — and daily profitability will build up here automatically.
                </div>
              ) : (<>
                {/* Summary tiles */}
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 8, marginBottom: 14 }}>
                  <div style={{ background: perf.summary.totalPnl >= 0 ? '#052e16' : '#2d0a0a', borderRadius: 8, padding: 10, textAlign: 'center' }}>
                    <div style={{ fontSize: 9, color: '#475569', marginBottom: 4 }}>TOTAL P&amp;L</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: perf.summary.totalPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                      {perf.summary.totalPnl >= 0 ? '+' : ''}₹{perf.summary.totalPnl.toLocaleString('en-IN')}
                    </div>
                  </div>
                  <div style={{ background: '#0a0f1a', borderRadius: 8, padding: 10, textAlign: 'center', border: '1px solid #1e2a3a' }}>
                    <div style={{ fontSize: 9, color: '#475569', marginBottom: 4 }}>WIN RATE</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: perf.summary.winRate >= 50 ? '#22c55e' : '#fb923c' }}>{perf.summary.winRate}%</div>
                  </div>
                  <div style={{ background: '#0a0f1a', borderRadius: 8, padding: 10, textAlign: 'center', border: '1px solid #1e2a3a' }}>
                    <div style={{ fontSize: 9, color: '#475569', marginBottom: 4 }}>CLOSED TRADES</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: '#f8fafc' }}>{perf.summary.totalTrades}</div>
                    <div style={{ fontSize: 9, color: '#334155', marginTop: 2 }}>{perf.summary.wins}W / {perf.summary.losses}L</div>
                  </div>
                  <div style={{ background: '#0a0f1a', borderRadius: 8, padding: 10, textAlign: 'center', border: '1px solid #1e2a3a' }}>
                    <div style={{ fontSize: 9, color: '#475569', marginBottom: 4 }}>AVG P&amp;L / TRADE</div>
                    <div style={{ fontSize: 18, fontWeight: 800, color: perf.summary.avgPnl >= 0 ? '#22c55e' : '#ef4444' }}>
                      {perf.summary.avgPnl >= 0 ? '+' : ''}₹{perf.summary.avgPnl.toLocaleString('en-IN')}
                    </div>
                  </div>
                </div>

                {perf.days.length > 1 && perf.summary.bestDay && perf.summary.worstDay && (
                  <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#334155', marginBottom: 14, flexWrap: 'wrap', gap: 6 }}>
                    <span>Best day: <span style={{ color: '#22c55e' }}>{perf.summary.bestDay.date} ({perf.summary.bestDay.pnl >= 0 ? '+' : ''}₹{perf.summary.bestDay.pnl.toLocaleString('en-IN')})</span></span>
                    <span>Worst day: <span style={{ color: '#ef4444' }}>{perf.summary.worstDay.date} ({perf.summary.worstDay.pnl >= 0 ? '+' : ''}₹{perf.summary.worstDay.pnl.toLocaleString('en-IN')})</span></span>
                  </div>
                )}

                {/* Day-by-day P&L — diverging bars centered on zero */}
                <div style={{ fontSize: 9, color: '#475569', marginBottom: 8, fontWeight: 700 }}>DAY-BY-DAY P&amp;L</div>
                {(() => {
                  const maxAbs = Math.max(1, ...perf.days.map(d => Math.abs(d.pnl)))
                  return perf.days.map(d => {
                    const pos = d.pnl >= 0
                    const halfWidthPct = Math.min(50, (Math.abs(d.pnl) / maxAbs) * 50)
                    return (
                      <div key={d.key} style={{ marginBottom: 10 }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: 10, color: '#64748b', marginBottom: 3 }}>
                          <span>{d.date} · {d.trades} trade{d.trades > 1 ? 's' : ''} · {d.winRate}% win</span>
                          <span style={{ fontWeight: 700, color: pos ? '#22c55e' : '#ef4444' }}>{pos ? '+' : ''}₹{d.pnl.toLocaleString('en-IN')}</span>
                        </div>
                        <div style={{ position: 'relative', height: 8, background: '#1e2a3a', borderRadius: 4 }}>
                          <div style={{ position: 'absolute', left: '50%', top: 0, bottom: 0, width: 1, background: '#334155' }} />
                          <div style={{
                            position: 'absolute', top: 0, bottom: 0,
                            ...(pos ? { left: '50%' } : { right: '50%' }),
                            width: `${halfWidthPct}%`,
                            background: pos ? '#22c55e' : '#ef4444',
                            borderRadius: pos ? '0 4px 4px 0' : '4px 0 0 4px',
                          }} />
                        </div>
                      </div>
                    )
                  })
                })()}

                {perf.openCount > 0 && (
                  <div style={{ marginTop: 4, fontSize: 10, color: '#334155' }}>
                    {perf.openCount} trade{perf.openCount > 1 ? 's' : ''} still open — excluded from stats above until exit is logged.
                  </div>
                )}
              </>)}
            </div>
          )}
        </div>

        {/* Trade Log */}
        <div style={{ margin: '10px 12px 0', background: '#0d1117', borderRadius: 12, border: '1px solid #1e2a3a', overflow: 'hidden' }}>
          <div onClick={() => setShowLog(s => !s)}
            style={{ padding: '12px 16px', cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#475569' }}>TRADE LOG ({tradeLog.length})</div>
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {tradeLog.length > 0 && (
                <div onClick={e => {
                  e.stopPropagation()
                  const blob = new Blob([JSON.stringify(tradeLog, null, 2)], { type: 'application/json' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url; a.download = `nifty-log-${todayStr()}.json`
                  a.click(); URL.revokeObjectURL(url)
                }}
                  style={{ fontSize: 10, color: '#475569', cursor: 'pointer', padding: '2px 6px', border: '1px solid #1e2a3a', borderRadius: 3 }}>
                  ↓ export
                </div>
              )}
              <div style={{ fontSize: 11, color: '#334155' }}>{showLog ? '▲' : '▼'}</div>
            </div>
          </div>
          {showLog && (
            <div style={{ borderTop: '1px solid #1e2a3a', padding: '8px 12px' }}>
              {tradeLog.length === 0 && <div style={{ fontSize: 11, color: '#334155', padding: '8px 0' }}>No trades logged yet.</div>}
              {tradeLog.map(t => (
                <div key={t.id} style={{ padding: '10px 0', borderBottom: '1px solid #0f172a' }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <div>
                      <span style={{ fontSize: 11, fontWeight: 700, color: RC[t.signal] || '#fff' }}>{t.signal}</span>
                      <span style={{ fontSize: 11, color: '#64748b', marginLeft: 8 }}>{t.strike}{t.signal === 'CE Buy' ? 'C' : 'P'}</span>
                      <span style={{ fontSize: 10, color: '#334155', marginLeft: 8 }}>{t.regime}</span>
                      {t.confirmed === false && <span style={{ fontSize: 9, color: '#fb923c', marginLeft: 6 }}>UNCONFIRMED</span>}
                    </div>
                    <div style={{ textAlign: 'right' }}>
                      <div style={{ fontSize: 10, color: '#475569' }}>{t.time} {t.date}</div>
                      {t.spot && <div style={{ fontSize: 10, color: '#334155' }}>Nifty ₹{t.spot.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</div>}
                    </div>
                  </div>
                  <div style={{ fontSize: 11, color: '#475569', marginTop: 4 }}>
                    Entry ₹{t.entryLTP} · SL ₹{t.sl} · TGT ₹{t.target} · R:R {t.rr}
                    {t.spread != null && <span style={{ marginLeft: 6, color: t.spread > 8 ? '#fb923c' : '#475569' }}>· Spread ₹{t.spread}</span>}
                  </div>
                  {t.pnl != null ? (
                    <div style={{ marginTop: 4, fontSize: 12, fontWeight: 700, color: t.pnl >= 0 ? '#22c55e' : '#ef4444' }}>
                      Exit ₹{t.exitPrice} → {t.pnl >= 0 ? '+' : ''}₹{t.pnl}
                    </div>
                  ) : exitingId === t.id ? (
                    <div style={{ marginTop: 6, display: 'flex', gap: 6 }}>
                      <input type="number" placeholder="Exit price" value={exitInput}
                        onChange={e => setExitInput(e.target.value)}
                        style={{ flex: 1, background: '#1e2a3a', border: '1px solid #334155', borderRadius: 4, color: '#fff', padding: '6px 8px', fontSize: 12, fontFamily: 'inherit' }} />
                      <button onClick={() => saveExit(t.id)}
                        style={{ background: '#22c55e', border: 'none', borderRadius: 4, color: '#000', padding: '6px 12px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>Save</button>
                      <button onClick={() => { setExitingId(null); setExitInput('') }}
                        style={{ background: '#1e2a3a', border: '1px solid #334155', borderRadius: 4, color: '#64748b', padding: '6px 10px', fontSize: 12, cursor: 'pointer' }}>✕</button>
                    </div>
                  ) : (
                    <button onClick={() => setExitingId(t.id)}
                      style={{ marginTop: 6, background: '#1c1400', border: '1px solid #92400e', borderRadius: 4, color: '#fbbf24', padding: '4px 10px', fontSize: 11, cursor: 'pointer', fontFamily: 'inherit' }}>
                      📝 Log Exit
                    </button>
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{ margin: '16px 12px 0', fontSize: 10, color: '#1e2a3a', textAlign: 'center' }}>
          Refreshes every 15 min during market hours · Positioning-based, not financial advice
        </div>
      </>)}
    </div>
  )
}
