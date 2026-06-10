import { useState, useEffect, useRef } from 'react'

const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params, _t: Date.now() }).toString()
  const res = await fetch(`/api/upstox?${qs}`, { cache: 'no-store' })
  const json = await res.json()
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`)
  return json
}

const todayStr = () => new Date().toISOString().split('T')[0]
const NTM = 500, LOT = 65, BUDGET = 10000
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
  const ceM = near.reduce((b, r) => r.ce_oi > b.ce_oi ? r : b, near[0])
  const peM = near.reduce((b, r) => r.pe_oi > b.pe_oi ? r : b, near[0])
  const R = ceM.strike, S = peM.strike
  if (R - S < 150) return { vote: 0, R, S, zone: 'tight', pos: 0.5, reason: `Walls tight (${S}–${R})` }
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
  const trendVote = lc > pc ? 0.3 : lc < pc ? -0.3 : 0
  const trend = lc > pc ? 'up' : lc < pc ? 'down' : 'flat'
  const mins = getISTMins()
  let timeWarning = null
  if (mins < 9 * 60 + 45) timeWarning = 'Opening volatility (9:15–9:45 IST) — wait for settlement'
  else if (mins > 14 * 60 + 45) timeWarning = 'Last 45 mins — theta collapse, avoid buying options'
  return { trend, trendVote, timeWarning, lc, pc }
}

// ── ANALYSIS ──────────────────────────────────────────────────────────────────
function analyse(rows, spot, dte, oiData, vix, pdh, pdl, candles, prevClose, prev2Close) {
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
    { v: tctx.trendVote, w: 0.8, r: `30min trend ${tctx.trend} (${tctx.lc ? tctx.lc.toFixed(0) : '—'} vs ${tctx.pc ? tctx.pc.toFixed(0) : '—'})` },
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

  // Channel detection — all 3 must pass
  const insidePDHL = pdh && pdl ? (spot < pdh && spot > pdl) : true
  let todayHigh = spot, todayLow = spot
  if (candles && candles.length) { todayHigh = Math.max(...candles.map(c => c[2] || spot)); todayLow = Math.min(...candles.map(c => c[3] || spot)) }
  const dayRange = todayHigh - todayLow
  let sustained = false
  if (candles && candles.length >= 3) {
    const c3 = candles.slice(-3).map(c => safe(() => c[4], spot))
    const minMove = spot * 0.001
    const allUp = c3[0] < c3[1] && c3[1] < c3[2] && (c3[1] - c3[0]) > minMove && (c3[2] - c3[1]) > minMove
    const allDown = c3[0] > c3[1] && c3[1] > c3[2] && (c3[0] - c3[1]) > minMove && (c3[1] - c3[2]) > minMove
    sustained = allUp || allDown
  }
  const tightRange = dayRange < em * 0.65
  const isChannel = insidePDHL && tightRange && !sustained
  const isTrend = !insidePDHL || sustained || dayRange > em * 0.9
  const nearSup = isChannel && wall.pos < 0.25
  const nearRes = isChannel && wall.pos > 0.75

  let regime = 'RANGING'
  if (isTrend && pdh && spot > pdh) regime = 'TRENDING UP'
  else if (isTrend && pdl && spot < pdl) regime = 'TRENDING DOWN'
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
    nearSup, nearRes, isChannel, isTrend, regime,
    bld, vixZone: vixS.zone,
    timeWarning: tctx.timeWarning, trend: tctx.trend, tLc: tctx.lc, tPc: tctx.pc,
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

  if (side === 'ce') {
    if (isChannel) {
      niftySL = Math.round(a.S - 30)
      niftyTGT = Math.round(a.R)
    } else {
      const cLow = safe(() => Math.min(...(candles || []).slice(-2).map(c => c[3])), spot - 50)
      niftySL = Math.round(Math.min(cLow - 20, spot - 30))
      // Skip ATM noise — target must be at least 50pts away (or 30% of expected move)
      const minTgt = Math.max(50, a.emRound * 0.3)
      niftyTGT = safe(() => {
        const ab = rows.filter(r => r.strike > spot + minTgt)
        return ab.length ? ab.reduce((b, r) => r.ce_oi > b.ce_oi ? r : b, ab[0]).strike : spot + 200
      }, spot + 200)
    }
  } else {
    if (isChannel) {
      niftySL = Math.round(a.R + 30)
      niftyTGT = Math.round(a.S)
    } else {
      const cHigh = safe(() => Math.max(...(candles || []).slice(-2).map(c => c[2])), spot + 50)
      niftySL = Math.round(Math.max(cHigh + 20, spot + 30))
      // Skip ATM noise — target must be at least 50pts away (or 30% of expected move)
      const minTgt = Math.max(50, a.emRound * 0.3)
      niftyTGT = safe(() => {
        const bl = rows.filter(r => r.strike < spot - minTgt)
        return bl.length ? bl.reduce((b, r) => r.pe_oi > b.pe_oi ? r : b, bl[0]).strike : spot - 200
      }, spot - 200)
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

// ── RECOMMENDATION ────────────────────────────────────────────────────────────
function getRec(rows, spot, a, vix, candles5, belowPDLStreak) {
  if (!a) return { type: 'No Trade', logic: 'Analysis unavailable' }
  const { bias, conv, timeWarning, nearSup, nearRes, isChannel, isTrend, regime, timeScore } = a
  if (timeWarning) return { type: 'Wait', logic: timeWarning }
  if (vix != null && vix > 20) return { type: 'No Trade', logic: `VIX ${vix.toFixed(1)} too high — premiums too expensive` }

  const streak = belowPDLStreak || 0

  const pick = (side) => safe(() => {
    const lt = `${side}_ltp`, dl = `${side}_delta`
    const bk = `${side}_bid`, ak = `${side}_ask`
    const aff = rows
      .filter(r => r[lt] * LOT <= BUDGET && r[lt] > 0.5)
      .map(r => ({ ...r, _ad: Math.abs(r[dl]), _sp: (r[ak] || 0) - (r[bk] || 0) }))
    if (!aff.length) return null
    const liquid = aff.filter(r => r._sp <= 15)
    const cand = liquid.length ? liquid : aff
    cand.sort((x, y) => {
      const dd = y._ad - x._ad
      if (Math.abs(dd) > 0.05) return dd
      return x._sp - y._sp
    })
    const row = cand[0], cost = row[lt] * LOT
    const spread = +row._sp.toFixed(1)
    const levels = calcLevels(side, row[lt], row[dl], spot, a, candles5 || [], rows, isChannel)
    return {
      strike: row.strike, ltp: row[lt], delta: row[dl],
      theta: row[`${side}_theta`], iv: row[`${side}_iv`],
      cost, lots: Math.floor(BUDGET / cost),
      moneyness: Math.round(side === 'ce' ? spot - row.strike : row.strike - spot),
      lowQ: Math.abs(row[dl]) < 0.30, spread, spreadWide: spread > 8, levels
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

  if (isChannel) {
    if (nearSup) { const d = pick('ce'); return { type: 'CE Buy', ...d, logic: `CHANNEL: Near support (${a.S}) — bounce setup.${vix > 16 ? ' VIX elevated, size small.' : ''}` } }
    if (nearRes) { const d = pick('pe'); return { type: 'PE Buy', ...d, logic: `CHANNEL: Near resistance (${a.R}) — rejection setup.${vix > 16 ? ' VIX elevated, size small.' : ''}` } }
    return { type: 'No Trade', logic: `CHANNEL: Spot mid-range (${a.S}–${a.R}). Wait for spot to approach a wall.` }
  }

  if (isTrend) {
    if (timeScore === 0) return { type: 'No Trade', logic: 'TREND MODE: After 2 PM IST — no new trend entries. Theta risk too high.' }

    // Price-based confirmation — instant, no waiting for refreshes
    // Confirmed breakdown: nearest CE wall 30+ pts ABOVE spot (writers stepped back = breakdown is real)
    // Confirmed breakout: nearest PE wall 30+ pts BELOW spot
    const nearestCeAbove = safe(() => {
      const ab = rows.filter(r => r.strike >= spot)
      return ab.length ? ab.reduce((b, r) => r.ce_oi > b.ce_oi ? r : b, ab[0]).strike : null
    }, null)
    const nearestPeBelow = safe(() => {
      const bl = rows.filter(r => r.strike <= spot)
      return bl.length ? bl.reduce((b, r) => r.pe_oi > b.pe_oi ? r : b, bl[0]).strike : null
    }, null)
    const ceWallGap = nearestCeAbove != null ? nearestCeAbove - spot : 0
    const peWallGap = nearestPeBelow != null ? spot - nearestPeBelow : 0
    const timeNote = timeScore < 1.0 ? ' Post 11 AM — consider smaller size.' : ''

    if (regime === 'TRENDING DOWN' || (regime === 'TRENDING' && bias.includes('BEAR'))) {
      const confirmed = ceWallGap >= 30
      const bdNote = confirmed
        ? ` ✓ Confirmed — CE wall ${Math.round(ceWallGap)} pts above spot.`
        : ` ⚠ Unconfirmed — CE wall only ${Math.round(ceWallGap)} pts above, bounce risk.`
      const d = pick('pe')
      return { type: 'PE Buy', ...d, confirmed, logic: `TREND (${regime}): Bearish.${bdNote}${timeNote}` }
    }
    if (regime === 'TRENDING UP' || (regime === 'TRENDING' && bias.includes('BULL'))) {
      const confirmed = peWallGap >= 30
      const d = pick('ce')
      return { type: 'CE Buy', ...d, confirmed, logic: `TREND (${regime}): Bullish.${confirmed ? ` ✓ Confirmed — PE wall ${Math.round(peWallGap)} pts below.` : ` ⚠ Unconfirmed.`}${timeNote}` }
    }
    if (regime === 'TRENDING') {
      if (a.priorV <= -0.3) {
        const confirmed = ceWallGap >= 30
        const d = pick('pe')
        return { type: 'PE Buy', ...d, confirmed, logic: `TREND: Prior day bearish.${confirmed ? ` ✓ Confirmed — CE wall ${Math.round(ceWallGap)} pts above.` : ' ⚠ Unconfirmed.'}${timeNote}` }
      }
      if (a.priorV >= 0.3) {
        const confirmed = peWallGap >= 30
        const d = pick('ce')
        return { type: 'CE Buy', ...d, confirmed, logic: `TREND: Prior day bullish.${confirmed ? ` ✓ Confirmed — PE wall ${Math.round(peWallGap)} pts below.` : ' ⚠ Unconfirmed.'}${timeNote}` }
      }
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
    for (const r of sorted.slice(0, 8)) {
      const c = (r.ce_ltp + r.pe_ltp) * LOT
      if (c <= BUDGET) return { type: 'Straddle', strike: r.strike, ceLtp: r.ce_ltp, peLtp: r.pe_ltp, cost: c, lots: Math.floor(BUDGET / c), logic: 'No directional edge, no prior day bias — straddle captures move either way' }
    }
    return { type: 'No Trade', logic: 'Low conviction — stay out' }
  }
  if (bias.includes('BULLISH')) { const d = pick('ce'); return { type: 'CE Buy', ...d, logic: `${bias} bias.` } }
  const d = pick('pe'); return { type: 'PE Buy', ...d, logic: `${bias} bias.` }
}

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
  const [exitingId, setExitingId] = useState(null)
  const [exitInput, setExitInput] = useState('')
  const belowPDLRef = useRef(0)
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
      setData({ spot, rows, dte, ceW, peW, a, rec, vix, pdh, pdl, prevClose, prev2Close })
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
    const newLog = [entry, ...tradeLog].slice(0, 30)
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
            { label: '30M TREND', val: a.trend === 'up' ? '↑' : a.trend === 'down' ? '↓' : '→', sub: a.trend, color: a.trend === 'up' ? '#22c55e' : a.trend === 'down' ? '#ef4444' : '#94a3b8' },
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

        {/* Trade */}
        {data.rec && (
          <div style={{ margin: '10px 12px 0', padding: 16, background: '#0d1117', borderRadius: 12, border: `1px solid ${RC[data.rec.type] || '#334155'}55` }}>
            <div style={{ fontSize: 10, color: '#475569', marginBottom: 10 }}>RECOMMENDED TRADE · Budget ₹{BUDGET.toLocaleString('en-IN')}</div>
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
              {data.rec.cost && (
                <div style={{ textAlign: 'right' }}>
                  <div style={{ fontSize: 14, color: '#94a3b8' }}>₹{data.rec.cost.toLocaleString('en-IN', { maximumFractionDigits: 0 })}/lot</div>
                  <div style={{ fontSize: 16, fontWeight: 700 }}>{data.rec.lots} lot{data.rec.lots > 1 ? 's' : ''}</div>
                </div>
              )}
            </div>
            {data.rec.ltp && (
              <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>
                LTP ₹{data.rec.ltp} · Δ {Math.abs(data.rec.delta || 0).toFixed(2)} · {Math.abs(data.rec.moneyness || 0)} pts {(data.rec.moneyness || 0) >= 0 ? 'ITM' : 'OTM'} · θ {(data.rec.theta || 0).toFixed(0)}/day · IV {(data.rec.iv || 0).toFixed(0)}
                {data.rec.spread != null && <span style={{ marginLeft: 8, color: data.rec.spreadWide ? '#fb923c' : '#64748b' }}>· Spread ₹{data.rec.spread}{data.rec.spreadWide ? ' ⚠' : ''}</span>}
              </div>
            )}
            {data.rec.ceLtp && <div style={{ marginTop: 8, fontSize: 11, color: '#475569' }}>CE ₹{data.rec.ceLtp} + PE ₹{data.rec.peLtp}</div>}
            <div style={{ marginTop: 8, fontSize: 11, color: '#475569', fontStyle: 'italic' }}>{data.rec.logic}</div>
            {data.rec.confirmed === false && <div style={{ marginTop: 4, fontSize: 11, color: '#fb923c' }}>⚠ Unconfirmed breakdown — wait for next refresh to confirm</div>}
            {data.rec.lowQ && <div style={{ marginTop: 4, fontSize: 11, color: '#fb923c' }}>⚠ Far-OTM only within budget</div>}
            {data.dte <= 2 && !['No Trade', 'Wait'].includes(data.rec.type) && <div style={{ marginTop: 4, fontSize: 11, color: '#fb923c' }}>⚠ {data.dte}d to expiry — steep theta</div>}

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
