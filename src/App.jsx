import { useState, useEffect } from 'react'

const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params, _t: Date.now() }).toString()
  const res = await fetch(`/api/upstox?${qs}`, { cache: 'no-store' })
  const json = await res.json()
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`)
  return json
}

const todayStr = () => new Date().toISOString().split('T')[0]
const NTM=500, LOT=65, BUDGET=10000
const clip=(x,lo=-1,hi=1)=>Math.max(lo,Math.min(hi,x))
const fmtOI=v=>Math.abs(v)>=1e6?`${(v/1e6).toFixed(2)}M`:`${(v/1e3).toFixed(0)}K`
const safe=(fn,fallback=null)=>{try{return fn()}catch{return fallback}}

// ── ANALYSIS ──────────────────────────────────────────────────────────────────
function analyse(rows, spot, dte, oiData, vix, pdh, pdl, candles) {
  const near = rows.filter(r=>Math.abs(r.strike-spot)<=NTM)
  if(!near.length) return null

  // PCR
  const ceSum=near.reduce((s,r)=>s+r.ce_oi,0)||1
  const peSum=near.reduce((s,r)=>s+r.pe_oi,0)
  const cePrev=near.reduce((s,r)=>s+r.ce_prev_oi,0)||1
  const pePrev=near.reduce((s,r)=>s+r.pe_prev_oi,0)
  const pcr=+(peSum/ceSum).toFixed(2)
  const pcrPrev=+(pePrev/cePrev).toFixed(2)
  let pcrV=clip(0.6*(pcr-1)/0.5+0.4*(pcr-pcrPrev)/0.2)
  if(pcr>1.8||pcr<0.45) pcrV*=0.5

  // OI change
  let bull=0,bear=0,tCe=0,tPe=0
  if(oiData?.call_put_oi_data_list) {
    tCe=oiData.total_call_change_oi||0
    tPe=oiData.total_put_change_oi||0
    for(const s of oiData.call_put_oi_data_list) {
      if(Math.abs(s.strike_price-spot)>NTM) continue
      const sp=s.strike_price,ce=s.call_change_oi||0,pe=s.put_change_oi||0
      if(sp>spot){if(ce>0)bear+=ce;else bull+=Math.abs(ce);if(pe>0)bull+=pe*0.3}
      else{if(pe>0)bull+=pe;else bear+=Math.abs(pe);if(ce>0)bear+=ce*0.3}
    }
  }
  const bldTot=bull+bear
  const bldV=bldTot?clip((bull-bear)/bldTot):0

  // Max pain
  const mp=safe(()=>{
    const pain={}
    for(const r of rows){
      let l=0
      for(const o of rows){l+=Math.max(0,r.strike-o.strike)*o.ce_oi;l+=Math.max(0,o.strike-r.strike)*o.pe_oi}
      pain[r.strike]=l
    }
    return +Object.entries(pain).sort((a,b)=>a[1]-b[1])[0][0]
  }, spot)
  const mpGap=mp-spot
  const ew=dte<=1?1:dte<=2?0.6:dte<=4?0.35:0.2
  const mpV=clip(mpGap/spot/0.01)*ew

  // Walls
  const ceMax=near.reduce((b,r)=>r.ce_oi>b.ce_oi?r:b,near[0])
  const peMax=near.reduce((b,r)=>r.pe_oi>b.pe_oi?r:b,near[0])
  const R=ceMax.strike, S=peMax.strike
  const wallValid=R-S>150
  const wallPos=wallValid?(spot-S)/(R-S):0.5
  const wallStr=wallValid?(peMax.pe_oi-ceMax.ce_oi)/(peMax.pe_oi+ceMax.ce_oi):0
  const wallV=wallValid?clip(0.8*(0.5-wallPos)*2+0.2*wallStr):0
  const wallZone=wallPos<0.35?'near support':wallPos>0.65?'near resistance':'mid-range'

  // IV skew
  const pRow=safe(()=>rows.reduce((b,r)=>Math.abs(r.strike-(spot-NTM))<Math.abs(b.strike-(spot-NTM))?r:b,rows[0]))
  const cRow=safe(()=>rows.reduce((b,r)=>Math.abs(r.strike-(spot+NTM))<Math.abs(b.strike-(spot+NTM))?r:b,rows[0]))
  const skew=(pRow&&cRow)?(pRow.pe_iv-cRow.ce_iv):2.5
  const skewV=clip(-(skew-2.5)/4)

  // VIX
  let vixV=0,vixZone='unknown'
  if(vix!=null){
    if(vix<13){vixV=0.3;vixZone='LOW'}
    else if(vix<=16){vixV=0.1;vixZone='NORMAL'}
    else if(vix<=20){vixV=-0.2;vixZone='ELEVATED'}
    else{vixV=-0.5;vixZone='HIGH'}
  }

  // PDH/PDL
  let pdhlV=0
  if(pdh&&pdl&&pdh>pdl){
    if(spot>pdh){
      // Broken above PDH — bullish breakout
      pdhlV=0.5
    } else if(spot<pdl){
      // Broken below PDL — bearish breakdown
      pdhlV=-0.5
    } else {
      // Inside range — position within range
      const pos=(spot-pdl)/(pdh-pdl)
      pdhlV=clip((0.5-pos)*2)
    }
  }

  // 30min candles
  let trendV=0,trend='unknown',tLc=null,tPc=null
  if(candles&&candles.length>=2){
    tLc=safe(()=>candles[candles.length-1][4])
    tPc=safe(()=>candles[candles.length-2][4])
    if(tLc!=null&&tPc!=null){
      trendV=tLc>tPc?0.3:tLc<tPc?-0.3:0
      trend=tLc>tPc?'up':tLc<tPc?'down':'flat'
    }
  }

  // Time warning
  const ist=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
  const mins=ist.getHours()*60+ist.getMinutes()
  let timeWarning=null
  if(mins<9*60+45) timeWarning='Opening volatility (9:15–9:45) — wait for settlement'
  else if(mins>14*60+45) timeWarning='Last 45 mins — theta collapse, avoid buying options'

  // Signals
  const sigs=[
    {v:pcrV, w:2.0, r:`NTM PCR ${pcr} (${pcr>pcrPrev?'rising':'falling'} from ${pcrPrev}) — ${pcrV>0.1?'bullish':pcrV<-0.1?'bearish':'neutral'}`},
    {v:bldV, w:1.5, r:`OI change: put support ${fmtOI(bull)} vs call resistance ${fmtOI(bear)} (CE ${fmtOI(tCe)} / PE ${fmtOI(tPe)})`},
    {v:mpV,  w:1.2*ew, r:`Max pain ${mp} (${mpGap>0?'+':''}${Math.round(mpGap)} pts) — ${dte}d to expiry`},
    {v:wallV,w:2.0, r:`Spot ${wallZone} of ${S}–${R} (PE ${fmtOI(peMax.pe_oi)} / CE ${fmtOI(ceMax.ce_oi)})`},
    {v:skewV,w:1.5, r:`IV skew ${skew.toFixed(1)} (put ${Math.round(pRow?.pe_iv||0)} vs call ${Math.round(cRow?.ce_iv||0)}) — ${skew>3.5?'downside fear':skew<1.5?'call demand':'normal'}`},
    {v:vixV, w:1.0, r:`India VIX ${vix!=null?vix.toFixed(1):'—'} (${vixZone})`},
    {v:pdhlV,w:1.5, r:`PDH ${pdh?pdh.toFixed(0):'—'} / PDL ${pdl?pdl.toFixed(0):'—'} — ${pdhlV>0.1?'near PDL support':pdhlV<-0.1?'near PDH resistance':'mid-range'}`},
    {v:trendV,w:0.8, r:`30min trend ${trend}${tLc?' ('+tLc.toFixed(0)+' vs '+tPc?.toFixed(0)+')':''}`},
  ]

  const wsum=sigs.reduce((s,x)=>s+x.w,0)
  const score=sigs.reduce((s,x)=>s+x.v*x.w,0)/wsum
  const sign=score>=0?1:-1
  const aw=sigs.filter(x=>Math.abs(x.v)>0.05).reduce((s,x)=>s+x.w,0)
  const ag=sigs.filter(x=>Math.abs(x.v)>0.05&&(x.v>=0)===(sign>=0)).reduce((s,x)=>s+x.w,0)
  const conv=Math.round(Math.abs(score)*(aw?ag/aw:0.5)*100)

  let bias='NEUTRAL'
  if(Math.abs(score)>=0.15&&conv>=20){
    if(score>=0.40)bias='BULLISH'
    else if(score>=0.15)bias='CAUTIOUSLY BULLISH'
    else if(score<=-0.40)bias='BEARISH'
    else bias='CAUTIOUSLY BEARISH'
  }

  const ranked=[...sigs].sort((a,b)=>Math.abs(b.v*b.w)-Math.abs(a.v*a.w))

  // ATM for expected move
  const atm=rows.reduce((b,r)=>Math.abs(r.strike-spot)<Math.abs(b.strike-spot)?r:b,rows[0])
  const em=atm.ce_ltp+atm.pe_ltp

  // Channel detection
  const insidePDHL=pdh&&pdl?spot<pdh&&spot>pdl:true
  let todayHigh=spot,todayLow=spot
  if(candles?.length){todayHigh=Math.max(...candles.map(c=>c[2]||spot));todayLow=Math.min(...candles.map(c=>c[3]||spot))}
  const dayRange=todayHigh-todayLow

  // Sustained trend: needs 3 consecutive closes in same direction AND each move > 0.1% of spot
  // Prevents minor drift from being misclassified as a trend
  let sustained=false
  if(candles&&candles.length>=3){
    const c3=candles.slice(-3).map(c=>safe(()=>c[4],spot))
    const minMove=spot*0.001  // 0.1% of spot (~23 pts on Nifty 23000)
    const allUp=c3[0]<c3[1]&&c3[1]<c3[2]&&(c3[1]-c3[0])>minMove&&(c3[2]-c3[1])>minMove
    const allDown=c3[0]>c3[1]&&c3[1]>c3[2]&&(c3[0]-c3[1])>minMove&&(c3[1]-c3[2])>minMove
    sustained=allUp||allDown
  }

  const tightRange=dayRange<em*0.65
  const isChannel=insidePDHL&&tightRange&&!sustained
  const isTrend=!insidePDHL||sustained||dayRange>em*0.9
  const nearSup=isChannel&&wallPos<0.25
  const nearRes=isChannel&&wallPos>0.75

  let regime='RANGING'
  if(isTrend&&spot>pdh)regime='TRENDING UP'
  else if(isTrend&&spot<pdl)regime='TRENDING DOWN'
  else if(isTrend)regime='TRENDING'
  else if(isChannel)regime='CHANNELING'

  // Time of day scoring
  // 9:45-11:00 = prime (1.0), 11:00-14:00 = valid but later (0.7), outside = 0
  let timeScore = 0.7  // default
  if(mins>=9*60+45&&mins<=11*60) timeScore=1.0
  else if(mins>14*60) timeScore=0  // after 2 PM no new trend entries

  return {
    bias,conv,score,reasons:ranked.map(x=>x.r),
    pcr,maxPain:mp,R,S,wallPos,wallZone,
    nearSup,nearRes,isChannel,isTrend,regime,
    bld:{bull,bear,totalCe:tCe,totalPe:tPe},
    vixZone,timeWarning,trend,tLc,tPc,em,
    insidePDHL,tightRange,sustained,
    dayRange:Math.round(dayRange),emRound:Math.round(em),
    timeScore
  }
}

// ── ENTRY / SL / TARGET ───────────────────────────────────────────────────────
// Channel: SL = just outside the wall that invalidates the setup. Target = opposite wall.
// Trend:   SL = recent candle swing. Target = next major OI wall in direction of trade.
function calcLevels(side, ltp, delta, spot, a, candles, rows, isChannel) {
  if(!ltp||!delta||!spot) return null
  const absDelta = Math.abs(delta)
  if(absDelta < 0.05) return null

  let niftySL, niftyTGT

  if(side === 'ce') {
    if(isChannel) {
      // Channel scalp: entered near support → SL below support wall, Target = resistance wall
      niftySL  = Math.round(a.S - 30)
      niftyTGT = Math.round(a.R)
    } else {
      // Trend: SL below recent candle low, Target = heaviest CE wall above spot
      const cLow = safe(()=>Math.min(...(candles||[]).slice(-2).map(c=>c[3])), spot-50)
      niftySL  = Math.round(Math.min(cLow - 20, spot - 30))
      niftyTGT = safe(()=>{
        const ab=rows.filter(r=>r.strike>spot)
        return ab.length?ab.reduce((b,r)=>r.ce_oi>b.ce_oi?r:b,ab[0]).strike:spot+300
      }, spot+300)
    }
  } else {
    if(isChannel) {
      // Channel scalp: entered near resistance → SL above resistance wall, Target = support wall
      niftySL  = Math.round(a.R + 30)
      niftyTGT = Math.round(a.S)
    } else {
      // Trend: SL above recent candle high, Target = heaviest PE wall below spot
      const cHigh = safe(()=>Math.max(...(candles||[]).slice(-2).map(c=>c[2])), spot+50)
      niftySL  = Math.round(Math.max(cHigh + 20, spot + 30))
      niftyTGT = safe(()=>{
        const bl=rows.filter(r=>r.strike<spot)
        return bl.length?bl.reduce((b,r)=>r.pe_oi>b.pe_oi?r:b,bl[0]).strike:spot-300
      }, spot-300)
    }
  }

  const niftySlDist  = side==='ce' ? Math.max(30, spot-niftySL) : Math.max(30, niftySL-spot)
  const niftyTgtDist = side==='ce' ? Math.max(0, niftyTGT-spot) : Math.max(0, spot-niftyTGT)
  const optionEntry  = +ltp.toFixed(1)
  const optionSL     = Math.max(0.5, +(ltp - niftySlDist * absDelta).toFixed(1))
  const optionTGT    = +(ltp + niftyTgtDist * absDelta).toFixed(1)
  const rr           = +(niftyTgtDist / niftySlDist).toFixed(1)

  return { optionEntry, optionSL, optionTGT, rr, niftySlDist, niftyTgtDist, niftySL, niftyTGT }
}

// ── RECOMMENDATION ────────────────────────────────────────────────────────────
function getRec(rows, spot, a, vix, candles, belowPDLStreak=0) {
  if(!a) return {type:'No Trade',logic:'Analysis unavailable'}
  const {bias,conv,timeWarning,nearSup,nearRes,isChannel,isTrend,regime,timeScore=0.7}=a
  if(timeWarning) return {type:'Wait',logic:timeWarning}
  if(vix!=null&&vix>20) return {type:'No Trade',logic:`VIX ${vix.toFixed(1)} too high — premiums too expensive`}

  const pick=(side)=>safe(()=>{
    const lt=`${side}_ltp`,dl=`${side}_delta`
    const bk=`${side}_bid`,ak=`${side}_ask`
    const aff=rows.filter(r=>r[lt]*LOT<=BUDGET&&r[lt]>0.5)
      .map(r=>({...r,_ad:Math.abs(r[dl]),_spread:(r[ak]||0)-(r[bk]||0)}))
    if(!aff.length) return null
    // Filter illiquid (spread>15) unless no choice
    const liquid=aff.filter(r=>r._spread<=15)
    const cand=liquid.length?liquid:aff
    // Primary: highest delta. Secondary among similar delta (within 0.05): tightest spread
    cand.sort((a,b)=>{
      const dd=b._ad-a._ad
      if(Math.abs(dd)>0.05) return dd
      return a._spread-b._spread
    })
    const row=cand[0],cost=row[lt]*LOT
    const spread=+row._spread.toFixed(1)
    return {strike:row.strike,ltp:row[lt],delta:row[dl],theta:row[`${side}_theta`],iv:row[`${side}_iv`],
      cost,lots:Math.floor(BUDGET/cost),moneyness:Math.round(side==='ce'?spot-row.strike:row.strike-spot),
      lowQ:Math.abs(row[dl])<0.30,spread,spreadWide:spread>8,
      levels:calcLevels(side,row[lt],row[dl],spot,a,candles||[],rows,isChannel)}
  })

  if(isChannel){
    if(nearSup){const d=pick('ce');return{type:'CE Buy',...d,logic:`CHANNEL: Near support (${a.S}) — bounce setup.${vix>16?' VIX elevated, size small.':''}`}}
    if(nearRes){const d=pick('pe');return{type:'PE Buy',...d,logic:`CHANNEL: Near resistance (${a.R}) — rejection setup.${vix>16?' VIX elevated, size small.':''}`}}
    return{type:'No Trade',logic:`CHANNEL: Spot mid-range (${a.S}–${a.R}). Wait for spot to approach a wall.`}
  }

  if(isTrend){
    // After 2 PM — no new trend entries (theta too costly)
    if(timeScore===0) return{type:'No Trade',logic:'TREND MODE: After 2 PM — no new trend entries. Theta risk too high.'}

    // False breakdown protection — needs 2 consecutive refreshes below PDL
    const confirmed = belowPDLStreak>=2
    const breakdownNote = regime==='TRENDING DOWN'
      ? (confirmed?' ✓ Confirmed (2+ refreshes below PDL).' : ` ⚠ Unconfirmed — breakdown needs 1 more refresh to confirm. (${belowPDLStreak}/2)`)
      : ''
    const timeNote = timeScore<1.0 ? ' Later entry window (post 11 AM) — consider smaller size.' : ''

    if(regime==='TRENDING DOWN'||(regime==='TRENDING'&&bias.includes('BEAR'))){
      const d=pick('pe')
      return{type:'PE Buy',...d,confirmed,
        logic:`TREND (${regime}): Bearish.${breakdownNote}${timeNote}`}
    }
    if(regime==='TRENDING UP'||(regime==='TRENDING'&&bias.includes('BULL'))){
      const d=pick('ce')
      return{type:'CE Buy',...d,confirmed:true,
        logic:`TREND (${regime}): Bullish — ride the uptrend.${timeNote}`}
    }
    // Generic trend with no clear bias — stay out
    return{type:'No Trade',logic:`TREND MODE (${regime}): Direction unclear. Wait for confirmation.`}
  }

  // Default / no candle data
  if(bias==='NEUTRAL'||conv<25){
    const sorted=[...rows].sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot))
    for(const r of sorted.slice(0,8)){const c=(r.ce_ltp+r.pe_ltp)*LOT;if(c<=BUDGET)return{type:'Straddle',strike:r.strike,ceLtp:r.ce_ltp,peLtp:r.pe_ltp,cost:c,lots:Math.floor(BUDGET/c),logic:'No directional edge — straddle captures move either way'}}
    return{type:'No Trade',logic:'Low conviction — stay out'}
  }
  if(bias.includes('BULLISH')){const d=pick('ce');return{type:'CE Buy',...d,logic:`${bias} bias.`}}
  const d=pick('pe');return{type:'PE Buy',...d,logic:`${bias} bias.`}
}

// ── CONSTANTS ─────────────────────────────────────────────────────────────────
const isOpen=()=>{
  const ist=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
  const d=ist.getDay(),m=ist.getHours()*60+ist.getMinutes()
  return d>=1&&d<=5&&m>=9*60+15&&m<=15*60+30
}
const BC={BULLISH:'#22c55e','CAUTIOUSLY BULLISH':'#86efac','CAUTIOUSLY BEARISH':'#fb923c',BEARISH:'#ef4444',NEUTRAL:'#94a3b8'}
const RC={'CE Buy':'#22c55e','PE Buy':'#ef4444',Straddle:'#fb923c','No Trade':'#64748b',Wait:'#f59e0b'}

// ── APP ───────────────────────────────────────────────────────────────────────
export default function App() {
  const [tick,  setTick]     = useState(0)
  const [data,  setData]     = useState(null)
  const [err,   setErr]      = useState(null)
  const [loading,setLoading] = useState(false)
  const [updated,setUpdated] = useState(null)
  const [expiry, setExpiry]  = useState(null)
  const [expiries,setExpiries]= useState([])
  const [showLog, setShowLog] = useState(false)
  const [exitingId, setExitingId] = useState(null)
  const [exitPrice, setExitPrice] = useState('')
  const belowPDLRef = useRef(0)
  const [tradeLog, setTradeLog] = useState(()=>{
    try{
      if(typeof window==='undefined') return []
      return JSON.parse(localStorage.getItem('nifty_tradelog')||'[]')
    }catch{return[]}
  })

  // Load expiries once
  useEffect(()=>{
    api('option-contract',{instrument_key:'NSE_INDEX|Nifty 50'})
      .then(res=>{
        const list=[...new Set(res.data.map(i=>i.expiry))].sort()
        const nearest=list.find(e=>e>=todayStr())||list[0]
        setExpiries(list.slice(0,6)); setExpiry(nearest)
      }).catch(e=>setErr('Expiry load failed: '+e.message))
  },[])

  // Fetch when expiry changes OR tick increments
  useEffect(()=>{
    if(!expiry) return
    setLoading(true); setErr(null)
    const to=todayStr()
    const from=(()=>{const d=new Date();d.setDate(d.getDate()-5);return d.toISOString().split('T')[0]})()
    Promise.allSettled([
      api('option-chain',{instrument_key:'NSE_INDEX|Nifty 50',expiry_date:expiry}),
      api('change-oi',{instrument_key:'NSE_INDEX|Nifty 50',expiry,date:to,interval:1}),
      api('historical',{to_date:to,from_date:from}),
      api('intraday'),
      api('vix-intraday'),
    ]).then(([r1,r2,r3,r4,r5])=>{
      if(r1.status==='rejected') throw new Error('Chain failed: '+r1.reason?.message)
      const chain=r1.value.data
      const spot=safe(()=>chain[0].underlying_spot_price, 0)
      const oiData=r2.status==='fulfilled'?safe(()=>r2.value.data):null
      const hc=r3.status==='fulfilled'?safe(()=>r3.value.data?.candles||[],[]):[]
      const pdh=hc.length?safe(()=>hc[0][2]):null
      const pdl=hc.length?safe(()=>hc[0][3]):null
      const ic=r4.status==='fulfilled'?safe(()=>r4.value.data?.candles||null):null
      const vc=r5.status==='fulfilled'?safe(()=>r5.value.data?.candles||[],[]):[]
      const vix=vc.length?safe(()=>vc[vc.length-1][4]):null
      const rows=safe(()=>chain.map(s=>({
        strike:s.strike_price,
        ce_oi:s.call_options.market_data.oi||0,
        ce_prev_oi:s.call_options.market_data.prev_oi||0,
        ce_ltp:s.call_options.market_data.ltp||0,
        ce_bid:s.call_options.market_data.bid_price||0,
        ce_ask:s.call_options.market_data.ask_price||0,
        ce_iv:s.call_options.option_greeks.iv||0,
        ce_delta:s.call_options.option_greeks.delta||0,
        ce_theta:s.call_options.option_greeks.theta||0,
        pe_oi:s.put_options.market_data.oi||0,
        pe_prev_oi:s.put_options.market_data.prev_oi||0,
        pe_ltp:s.put_options.market_data.ltp||0,
        pe_bid:s.put_options.market_data.bid_price||0,
        pe_ask:s.put_options.market_data.ask_price||0,
        pe_iv:s.put_options.option_greeks.iv||0,
        pe_delta:s.put_options.option_greeks.delta||0,
        pe_theta:s.put_options.option_greeks.theta||0,
      })),[])
      const dte=Math.max(0,Math.round((new Date(expiry)-new Date(to))/86400000))
      const near=rows.filter(r=>Math.abs(r.strike-spot)<=NTM)
      const ceW=[...near].sort((a,b)=>b.ce_oi-a.ce_oi).slice(0,3)
      const peW=[...near].sort((a,b)=>b.pe_oi-a.pe_oi).slice(0,3)

      // Update false breakdown streak — needs 2 consecutive refreshes below PDL to confirm
      if(pdl&&spot<pdl) belowPDLRef.current = belowPDLRef.current + 1
      else belowPDLRef.current = 0

      const a=safe(()=>analyse(rows,spot,dte,oiData,vix,pdh,pdl,ic))
      const rec=safe(()=>getRec(rows,spot,a,vix,ic,belowPDLRef.current),{type:'No Trade',logic:'Analysis error'})
      setData({spot,rows,dte,ceW,peW,a,rec,vix,pdh,pdl})
      setUpdated(new Date())
    }).catch(e=>setErr(String(e?.message||e)))
    .finally(()=>setLoading(false))
  },[expiry,tick])

  // Auto-refresh every 15min
  useEffect(()=>{
    const t=setInterval(()=>{ if(isOpen()) setTick(c=>c+1) },15*60*1000)
    return()=>clearInterval(t)
  },[])

  const logEntry = () => {
    if(!data?.rec||!['CE Buy','PE Buy'].includes(data.rec.type)) return
    const entry = {
      id: Date.now(),
      date: new Date().toLocaleDateString('en-IN'),
      time: new Date().toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'}),
      regime: data.a?.regime||'—',
      signal: data.rec.type,
      strike: data.rec.strike,
      entryLTP: data.rec.ltp,
      sl: data.rec.levels?.optionSL,
      target: data.rec.levels?.optionTGT,
      rr: data.rec.levels?.rr,
      spread: data.rec.spread,
      confirmed: data.rec.confirmed,
      spot: data.spot,
      exitPrice: null, pnl: null
    }
    const newLog = [entry,...tradeLog].slice(0,30)
    setTradeLog(newLog)
    try{if(typeof window!=='undefined') localStorage.setItem('nifty_tradelog',JSON.stringify(newLog))}catch{}
  }

  const logExit = (id) => {
    const price = parseFloat(exitPrice)
    if(isNaN(price)||price<=0) return
    const updated2 = tradeLog.map(t=>{
      if(t.id!==id) return t
      const dir = t.signal==='CE Buy'?1:-1
      const pnl = Math.round((price-t.entryLTP)*dir*LOT)
      return {...t,exitPrice:price,pnl}
    })
    setTradeLog(updated2)
    try{if(typeof window!=='undefined') localStorage.setItem('nifty_tradelog',JSON.stringify(updated2))}catch{}
    setExitingId(null); setExitPrice('')
  }

  const a=data?.a
  const bias=a?.bias||'NEUTRAL'
  const bc=BC[bias]||'#94a3b8'
  const conv=a?.conv||0

  return (
    <div style={{background:'#070a0f',minHeight:'100vh',color:'#e2e8f0',fontFamily:"'JetBrains Mono',monospace",padding:'0 0 80px'}}>

      {/* Header */}
      <div style={{background:'#0d1117',borderBottom:'1px solid #1e2a3a',padding:'14px 16px',position:'sticky',top:0,zIndex:10}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:18,color:'#f8fafc'}}>NIFTY OPTIONS</div>
            <div style={{fontSize:10,color:'#475569',marginTop:1}}>
              {updated?`${updated.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`:'Loading...'}
              {' · '}<span style={{color:isOpen()?'#22c55e':'#ef4444'}}>{isOpen()?'● LIVE':'● CLOSED'}</span>
              {data?.vix!=null&&<span style={{marginLeft:8,color:data.vix>16?'#fb923c':'#64748b'}}>VIX {data.vix.toFixed(1)}</span>}
            </div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:22,color:'#f8fafc'}}>
              {data?`₹${data.spot.toLocaleString('en-IN',{minimumFractionDigits:2})}`:'—'}
            </div>
            <button onClick={()=>setTick(c=>c+1)} disabled={loading}
              style={{background:loading?'#1e2a3a':'#1d4ed8',border:'none',borderRadius:4,color:'#fff',fontSize:10,padding:'3px 10px',cursor:loading?'default':'pointer',fontFamily:'inherit',marginTop:2}}>
              {loading?'LOADING...':'↻ REFRESH'}
            </button>
          </div>
        </div>
        <div style={{display:'flex',gap:6,marginTop:10,overflowX:'auto',paddingBottom:2}}>
          {expiries.map(e=>(
            <button key={e} onClick={()=>setExpiry(e)}
              style={{background:expiry===e?'#1d4ed8':'#1e2a3a',border:'none',borderRadius:4,color:expiry===e?'#fff':'#94a3b8',fontSize:10,padding:'5px 10px',cursor:'pointer',whiteSpace:'nowrap',fontFamily:'inherit'}}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {err&&<div style={{margin:16,padding:12,background:'#1c0a0a',border:'1px solid #7f1d1d',borderRadius:8,color:'#fca5a5',fontSize:12}}>⚠ {err}</div>}

      {data&&a&&(<>
        {a.timeWarning&&<div style={{margin:'12px 12px 0',padding:'10px 14px',background:'#1c1400',border:'1px solid #92400e',borderRadius:8,color:'#fbbf24',fontSize:12}}>⏰ {a.timeWarning}</div>}

        {/* Bias */}
        <div style={{margin:'12px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${bc}33`}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <div style={{fontSize:10,color:'#475569',marginBottom:4}}>MARKET BIAS</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:26,color:bc,lineHeight:1}}>{bias}</div>
              <div style={{fontSize:11,color:'#64748b',marginTop:6}}>±{a.emRound} pts · PCR {a.pcr} · MP {a.maxPain}</div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:10,color:'#475569',marginBottom:4}}>CONVICTION</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:36,color:conv>=50?'#22c55e':conv>=30?'#fb923c':'#64748b',lineHeight:1}}>{conv}%</div>
              <div style={{width:80,height:4,background:'#1e2a3a',borderRadius:2,marginTop:6,marginLeft:'auto'}}>
                <div style={{width:`${Math.min(conv,100)}%`,height:'100%',background:conv>=50?'#22c55e':conv>=30?'#fb923c':'#475569',borderRadius:2}}/>
              </div>
            </div>
          </div>
          <div style={{marginTop:12,borderTop:'1px solid #1e2a3a',paddingTop:10}}>
            {a.reasons.slice(0,5).map((r,i)=>(
              <div key={i} style={{fontSize:11,color:i===0?'#cbd5e1':'#64748b',padding:'3px 0',lineHeight:1.4}}>
                <span style={{color:'#334155',marginRight:6}}>{i+1}.</span>{r}
              </div>
            ))}
          </div>
        </div>

        {/* VIX / PDH PDL / Trend */}
        <div style={{margin:'10px 12px 0',display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          {[
            {label:'INDIA VIX', val:data.vix!=null?data.vix.toFixed(1):'—', sub:a.vixZone, color:data.vix>16?'#fb923c':data.vix<13?'#22c55e':'#94a3b8'},
            {label:'PDH / PDL', val:data.pdh?data.pdh.toFixed(0):'—', val2:data.pdl?data.pdl.toFixed(0):'—', sub:'high / low'},
            {label:'30M TREND', val:a.trend==='up'?'↑':a.trend==='down'?'↓':'→', sub:a.trend, color:a.trend==='up'?'#22c55e':a.trend==='down'?'#ef4444':'#94a3b8'},
          ].map(({label,val,val2,sub,color})=>(
            <div key={label} style={{background:'#0d1117',borderRadius:10,border:'1px solid #1e2a3a',padding:'10px 12px'}}>
              <div style={{fontSize:9,color:'#475569',marginBottom:4}}>{label}</div>
              <div style={{fontSize:val2?12:20,fontWeight:700,color:color||'#f8fafc'}}>{val}</div>
              {val2&&<div style={{fontSize:12,fontWeight:700,color:'#22c55e'}}>{val2}</div>}
              <div style={{fontSize:9,color:'#475569',marginTop:2}}>{sub}</div>
            </div>
          ))}
        </div>

        {/* Channel */}
        <div style={{margin:'10px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${a.nearSup?'#22c55e33':a.nearRes?'#ef444433':'#1e2a3a'}`}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:8}}>
            <div style={{fontSize:10,color:'#475569'}}>
              CHANNEL POSITION
              {a.nearSup&&<span style={{color:'#22c55e',marginLeft:8,fontWeight:700}}>● NEAR SUPPORT</span>}
              {a.nearRes&&<span style={{color:'#ef4444',marginLeft:8,fontWeight:700}}>● NEAR RESISTANCE</span>}
            </div>
            <div style={{fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:4,
              background:a.regime==='CHANNELING'?'#14532d':a.regime.includes('UP')?'#1e3a5f':a.regime.includes('DOWN')?'#3b0000':'#1c1917',
              color:a.regime==='CHANNELING'?'#4ade80':a.regime.includes('UP')?'#60a5fa':a.regime.includes('DOWN')?'#f87171':'#d6d3d1'
            }}>{a.regime}</div>
          </div>
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:4,marginBottom:10}}>
            {[
              [a.insidePDHL,'Inside PDH/PDL'],
              [a.tightRange,`Tight (${a.dayRange} vs ±${a.emRound})`],
              [!a.sustained,'No sustained trend'],
            ].map(([ok,label])=>(
              <div key={label} style={{fontSize:10,color:ok?'#4ade80':'#f87171',textAlign:'center'}}>{ok?'✓':'✗'} {label}</div>
            ))}
          </div>
          <div style={{position:'relative',height:40}}>
            <div style={{position:'absolute',top:16,left:0,right:0,height:8,background:'#1e2a3a',borderRadius:4}}>
              <div style={{position:'absolute',left:0,width:'25%',height:'100%',background:'#22c55e22',borderRadius:'4px 0 0 4px'}}/>
              <div style={{position:'absolute',right:0,width:'25%',height:'100%',background:'#ef444422',borderRadius:'0 4px 4px 0'}}/>
              <div style={{position:'absolute',left:`${Math.max(2,Math.min(96,(a.wallPos||0.5)*100))}%`,top:'50%',transform:'translate(-50%,-50%)',width:14,height:14,background:bc,borderRadius:'50%',boxShadow:`0 0 8px ${bc}88`,zIndex:2}}/>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:30}}>
              <div style={{fontSize:11,color:'#22c55e'}}>⬆ {a.S}</div>
              <div style={{fontSize:11,color:'#64748b'}}>{a.wallZone}</div>
              <div style={{fontSize:11,color:'#ef4444'}}>{a.R} ⬇</div>
            </div>
          </div>
        </div>

        {/* Walls */}
        <div style={{margin:'10px 12px 0',display:'grid',gridTemplateColumns:'1fr 1fr',gap:10}}>
          {[{title:'CE WALLS',color:'#ef4444',walls:data.ceW,ok:'ce_oi'},{title:'PE WALLS',color:'#22c55e',walls:data.peW,ok:'pe_oi'}].map(({title,color,walls,ok})=>(
            <div key={title} style={{background:'#0d1117',borderRadius:12,border:'1px solid #1e2a3a',padding:12}}>
              <div style={{fontSize:10,color,marginBottom:8,fontWeight:700}}>{title}</div>
              {walls.map((w,i)=>(
                <div key={i} style={{display:'flex',justifyContent:'space-between',padding:'4px 0',borderBottom:i<2?'1px solid #0f172a':'none'}}>
                  <div style={{fontSize:12}}>{w.strike}</div>
                  <div style={{fontSize:11,color}}>{fmtOI(w[ok])}</div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Trade */}
        {data.rec&&(
          <div style={{margin:'10px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${RC[data.rec.type]||'#334155'}55`}}>
            <div style={{fontSize:10,color:'#475569',marginBottom:10}}>RECOMMENDED TRADE · Budget ₹{BUDGET.toLocaleString('en-IN')}</div>
            <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
              <div>
                <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:20,color:RC[data.rec.type]||'#64748b'}}>{data.rec.type}</div>
                {data.rec.strike&&<div style={{fontSize:22,fontWeight:700,color:'#f8fafc',marginTop:2}}>{data.rec.strike}{data.rec.type==='CE Buy'?'C':data.rec.type==='PE Buy'?'P':''}</div>}
              </div>
              {data.rec.cost&&<div style={{textAlign:'right'}}>
                <div style={{fontSize:14,color:'#94a3b8'}}>₹{data.rec.cost.toLocaleString('en-IN',{maximumFractionDigits:0})}/lot</div>
                <div style={{fontSize:16,fontWeight:700}}>{data.rec.lots} lot{data.rec.lots>1?'s':''}</div>
              </div>}
            </div>
            {data.rec.ltp&&<div style={{marginTop:8,fontSize:11,color:'#475569'}}>
              LTP ₹{data.rec.ltp} · Δ {Math.abs(data.rec.delta||0).toFixed(2)} · {Math.abs(data.rec.moneyness||0)} pts {(data.rec.moneyness||0)>=0?'ITM':'OTM'} · θ {(data.rec.theta||0).toFixed(0)}/day · IV {(data.rec.iv||0).toFixed(0)}
              {data.rec.spread!=null&&<span style={{marginLeft:8,color:data.rec.spreadWide?'#fb923c':'#64748b'}}>· Spread ₹{data.rec.spread}{data.rec.spreadWide?' ⚠':''}</span>}
            </div>}

            {/* Entry / SL / Target levels */}
            {data.rec.levels&&(()=>{
              const lv=data.rec.levels
              const rrColor=lv.rr>=2?'#22c55e':lv.rr>=1.5?'#86efac':'#fb923c'
              return (
                <div style={{marginTop:12,padding:12,background:'#0a0f1a',borderRadius:8,border:'1px solid #1e2a3a'}}>
                  <div style={{fontSize:10,color:'#475569',marginBottom:10,fontWeight:700}}>TRADE LEVELS</div>
                  <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
                    <div style={{textAlign:'center',background:'#111827',borderRadius:6,padding:'10px 6px'}}>
                      <div style={{fontSize:9,color:'#475569',marginBottom:4}}>ENTRY</div>
                      <div style={{fontSize:20,fontWeight:700,color:'#f8fafc'}}>₹{lv.optionEntry}</div>
                    </div>
                    <div style={{textAlign:'center',background:'#1c0a0a',borderRadius:6,padding:'10px 6px'}}>
                      <div style={{fontSize:9,color:'#ef4444',marginBottom:4}}>STOP LOSS</div>
                      <div style={{fontSize:20,fontWeight:700,color:'#ef4444'}}>₹{lv.optionSL}</div>
                      <div style={{fontSize:9,color:'#475569',marginTop:2}}>−₹{(lv.optionEntry-lv.optionSL).toFixed(1)}</div>
                    </div>
                    <div style={{textAlign:'center',background:'#052e16',borderRadius:6,padding:'10px 6px'}}>
                      <div style={{fontSize:9,color:'#22c55e',marginBottom:4}}>TARGET</div>
                      <div style={{fontSize:20,fontWeight:700,color:'#22c55e'}}>₹{lv.optionTGT}</div>
                      <div style={{fontSize:9,color:'#475569',marginTop:2}}>+₹{(lv.optionTGT-lv.optionEntry).toFixed(1)}</div>
                    </div>
                  </div>
                  {lv.rr&&<div style={{marginTop:8,textAlign:'center',fontSize:12,fontWeight:700,color:rrColor}}>R:R {lv.rr}:1</div>}
                </div>
              )
            })()}
            {data.rec.ceLtp&&<div style={{marginTop:8,fontSize:11,color:'#475569'}}>CE ₹{data.rec.ceLtp} + PE ₹{data.rec.peLtp}</div>}
            <div style={{marginTop:8,fontSize:11,color:'#475569',fontStyle:'italic'}}>{data.rec.logic}</div>
            {data.rec.lowQ&&<div style={{marginTop:6,fontSize:11,color:'#fb923c'}}>⚠ Far-OTM only within budget</div>}
            {data.dte<=2&&!['No Trade','Wait'].includes(data.rec.type)&&<div style={{marginTop:6,fontSize:11,color:'#fb923c'}}>⚠ {data.dte}d to expiry — steep theta</div>}
            {['CE Buy','PE Buy'].includes(data.rec.type)&&(
              <button onClick={logEntry}
                style={{marginTop:12,width:'100%',padding:'10px',background:'#1e3a5f',border:'1px solid #3b82f6',borderRadius:6,color:'#60a5fa',fontSize:12,fontWeight:700,cursor:'pointer',fontFamily:'inherit'}}>
                📝 Log Entry at ₹{data.rec.ltp}
              </button>
            )}
          </div>
        )}

        {/* OI Change */}
        {(a.bld.bull>0||a.bld.bear>0)&&(
          <div style={{margin:'10px 12px 0',padding:14,background:'#0d1117',borderRadius:12,border:'1px solid #1e2a3a'}}>
            <div style={{fontSize:10,color:'#475569',marginBottom:8}}>OI CHANGE (TODAY vs YESTERDAY)</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div style={{background:'#052e16',borderRadius:8,padding:10,textAlign:'center'}}>
                <div style={{fontSize:10,color:'#4ade80'}}>PUT SUPPORT</div>
                <div style={{fontSize:16,fontWeight:700,color:'#22c55e',marginTop:2}}>{fmtOI(a.bld.bull)}</div>
              </div>
              <div style={{background:'#2d0a0a',borderRadius:8,padding:10,textAlign:'center'}}>
                <div style={{fontSize:10,color:'#f87171'}}>CALL RESIST</div>
                <div style={{fontSize:16,fontWeight:700,color:'#ef4444',marginTop:2}}>{fmtOI(a.bld.bear)}</div>
              </div>
            </div>
            <div style={{marginTop:8,fontSize:11,color:'#334155',display:'flex',justifyContent:'space-between'}}>
              <span>Total CE: {fmtOI(a.bld.totalCe)}</span>
              <span>Total PE: {fmtOI(a.bld.totalPe)}</span>
            </div>
          </div>
        )}
        {/* Trade Log */}
        <div style={{margin:'10px 12px 0',background:'#0d1117',borderRadius:12,border:'1px solid #1e2a3a',overflow:'hidden'}}>
          <div onClick={()=>setShowLog(s=>!s)}
            style={{padding:'12px 16px',cursor:'pointer',display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div style={{fontSize:11,fontWeight:700,color:'#475569'}}>TRADE LOG ({tradeLog.length})</div>
            <div style={{fontSize:11,color:'#334155'}}>{showLog?'▲':'▼'}</div>
          </div>
          {showLog&&(
            <div style={{borderTop:'1px solid #1e2a3a',padding:'8px 12px'}}>
              {tradeLog.length===0&&<div style={{fontSize:11,color:'#334155',padding:'8px 0'}}>No trades logged yet. Hit "Log Entry" when a CE/PE Buy is active.</div>}
              {tradeLog.map(t=>(
                <div key={t.id} style={{padding:'10px 0',borderBottom:'1px solid #0f172a'}}>
                  <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
                    <div>
                      <span style={{fontSize:11,fontWeight:700,color:RC[t.signal]||'#fff'}}>{t.signal}</span>
                      <span style={{fontSize:11,color:'#64748b',marginLeft:8}}>{t.strike}{t.signal==='CE Buy'?'C':'P'}</span>
                      <span style={{fontSize:10,color:'#334155',marginLeft:8}}>{t.regime}</span>
                      {t.confirmed===false&&<span style={{fontSize:9,color:'#fb923c',marginLeft:6}}>UNCONFIRMED</span>}
                    </div>
                    <div style={{fontSize:10,color:'#475569'}}>{t.time} {t.date}</div>
                  </div>
                  <div style={{fontSize:11,color:'#475569',marginTop:4}}>
                    Entry ₹{t.entryLTP} · SL ₹{t.sl} · TGT ₹{t.target} · R:R {t.rr}
                    {t.spread&&<span style={{marginLeft:6,color:t.spread>8?'#fb923c':'#475569'}}>· Spread ₹{t.spread}</span>}
                  </div>
                  {t.pnl!=null?(
                    <div style={{marginTop:4,fontSize:12,fontWeight:700,color:t.pnl>=0?'#22c55e':'#ef4444'}}>
                      Exit ₹{t.exitPrice} → {t.pnl>=0?'+':''}₹{t.pnl}
                    </div>
                  ):(
                    exitingId===t.id?(
                      <div style={{marginTop:6,display:'flex',gap:6}}>
                        <input
                          type="number" placeholder="Exit price"
                          value={exitPrice}
                          onChange={e=>setExitPrice(e.target.value)}
                          style={{flex:1,background:'#1e2a3a',border:'1px solid #334155',borderRadius:4,color:'#fff',padding:'6px 8px',fontSize:12,fontFamily:'inherit'}}/>
                        <button onClick={()=>logExit(t.id)}
                          style={{background:'#22c55e',border:'none',borderRadius:4,color:'#000',padding:'6px 12px',fontSize:12,fontWeight:700,cursor:'pointer'}}>
                          Save
                        </button>
                        <button onClick={()=>{setExitingId(null);setExitPrice('')}}
                          style={{background:'#1e2a3a',border:'1px solid #334155',borderRadius:4,color:'#64748b',padding:'6px 10px',fontSize:12,cursor:'pointer'}}>
                          ✕
                        </button>
                      </div>
                    ):(
                      <button onClick={()=>{setExitingId(t.id);setExitPrice('')}}
                        style={{marginTop:6,background:'#1c1400',border:'1px solid #92400e',borderRadius:4,color:'#fbbf24',padding:'4px 10px',fontSize:11,cursor:'pointer',fontFamily:'inherit'}}>
                        📝 Log Exit
                      </button>
                    )
                  )}
                </div>
              ))}
            </div>
          )}
        </div>

        <div style={{margin:'16px 12px 0',fontSize:10,color:'#1e2a3a',textAlign:'center'}}>Refreshes every 15 min · Positioning-based, not financial advice</div>
      </>)}
    </div>
  )
}

