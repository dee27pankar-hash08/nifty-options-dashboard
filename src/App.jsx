import { useState, useEffect, useRef } from 'react'

const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params }).toString()
  const res = await fetch(`/api/upstox?${qs}`)
  const json = await res.json()
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`)
  return json
}

const todayStr = () => new Date().toISOString().split('T')[0]
const NTM=500, LOT=65, BUDGET=10000
const clip=(x,lo=-1,hi=1)=>Math.max(lo,Math.min(hi,x))
const fmtOI=v=>Math.abs(v)>=1e6?`${(v/1e6).toFixed(2)}M`:`${(v/1e3).toFixed(0)}K`

function analyse(rows, spot, dte, oiData, vix, pdh, pdl, candles) {
  const near=rows.filter(r=>Math.abs(r.strike-spot)<=NTM)

  // PCR
  const ce=near.reduce((s,r)=>s+r.ce_oi,0), pe=near.reduce((s,r)=>s+r.pe_oi,0)
  const cep=near.reduce((s,r)=>s+r.ce_prev_oi,0), pep=near.reduce((s,r)=>s+r.pe_prev_oi,0)
  const pcr=ce?+(pe/ce).toFixed(2):0, pcrP=cep?+(pep/cep).toFixed(2):pcr
  let pcrV=clip(0.6*(pcr-1)/0.5+0.4*(pcr-pcrP)/0.2)
  if(pcr>1.8||pcr<0.45) pcrV*=0.5

  // OI Change
  let bldV=0, bull=0, bear=0, tCe=0, tPe=0
  if(oiData?.call_put_oi_data_list?.length) {
    for(const s of oiData.call_put_oi_data_list) {
      if(Math.abs(s.strike_price-spot)>NTM) continue
      const {strike_price:sp,call_change_oi:ce2,put_change_oi:pe2}=s
      if(sp>spot){if(ce2>0)bear+=ce2;else bull+=Math.abs(ce2);if(pe2>0)bull+=pe2*0.3}
      else{if(pe2>0)bull+=pe2;else bear+=Math.abs(pe2);if(ce2>0)bear+=ce2*0.3}
    }
    const tot=bull+bear; bldV=tot?clip((bull-bear)/tot):0
    tCe=oiData.total_call_change_oi||0; tPe=oiData.total_put_change_oi||0
  }

  // Max pain
  const pain={}
  for(const r of rows){let l=0;for(const o of rows){l+=Math.max(0,r.strike-o.strike)*o.ce_oi;l+=Math.max(0,o.strike-r.strike)*o.pe_oi};pain[r.strike]=l}
  const mp=+Object.entries(pain).sort((a,b)=>a[1]-b[1])[0][0]
  const mpGap=mp-spot, ew=dte<=1?1:dte<=2?0.6:dte<=4?0.35:0.2
  const mpV=clip(mpGap/spot/0.01)*ew

  // Walls
  const ceM=near.length?near.reduce((b,r)=>r.ce_oi>b.ce_oi?r:b,near[0]):null
  const peM=near.length?near.reduce((b,r)=>r.pe_oi>b.pe_oi?r:b,near[0]):null
  const R=ceM?.strike||spot+500, S=peM?.strike||spot-500
  const wallPos=(R-S>150)?(spot-S)/(R-S):0.5
  const wallV=(R-S>150)?clip(0.8*(0.5-wallPos)*2+0.2*((peM?.pe_oi||0)-(ceM?.ce_oi||0))/((peM?.pe_oi||1)+(ceM?.ce_oi||1))):0
  const wallZone=wallPos<0.35?'near support':wallPos>0.65?'near resistance':'mid-range'

  // IV Skew
  const pR=rows.reduce((b,r)=>Math.abs(r.strike-(spot-NTM))<Math.abs(b.strike-(spot-NTM))?r:b,rows[0])
  const cR=rows.reduce((b,r)=>Math.abs(r.strike-(spot+NTM))<Math.abs(b.strike-(spot+NTM))?r:b,rows[0])
  const skew=pR&&cR?pR.pe_iv-cR.ce_iv:2.5
  const skewV=clip(-(skew-2.5)/4)

  // VIX
  let vixV=0, vixZone='unknown'
  if(vix){if(vix<13){vixV=0.3;vixZone='LOW'}else if(vix<=16){vixV=0.1;vixZone='NORMAL'}else if(vix<=20){vixV=-0.2;vixZone='ELEVATED'}else{vixV=-0.5;vixZone='HIGH'}}

  // PDH/PDL
  let pdhlV=0
  if(pdh&&pdl){const pos=(spot-pdl)/(pdh-pdl);pdhlV=clip((0.5-pos)*2)}

  // 30min trend
  let trendV=0, trend='unknown', trendLc=null, trendPc=null
  if(candles?.length>=2){
    trendLc=candles[candles.length-1][4]; trendPc=candles[candles.length-2][4]
    trendV=trendLc>trendPc?0.3:trendLc<trendPc?-0.3:0
    trend=trendLc>trendPc?'up':trendLc<trendPc?'down':'flat'
  }

  // Time warning
  const ist=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
  const mins=ist.getHours()*60+ist.getMinutes()
  let timeWarning=null
  if(mins<9*60+45) timeWarning='Opening volatility (9:15–9:45) — wait for settlement'
  else if(mins>14*60+45) timeWarning='Last 45 mins — theta collapse, avoid buying options'

  const sigs=[
    {v:pcrV, w:2.0, r:`NTM PCR ${pcr} (${pcr>pcrP?'rising':'falling'} from ${pcrP}) — ${pcrV>0.1?'bullish':pcrV<-0.1?'bearish':'neutral'}`},
    {v:bldV, w:1.5, r:`OI change: put support ${fmtOI(bull)} vs call resistance ${fmtOI(bear)} (CE chg ${fmtOI(tCe)} / PE chg ${fmtOI(tPe)})`},
    {v:mpV,  w:1.2*ew, r:`Max pain ${mp} (${mpGap>0?'+':''}${Math.round(mpGap)} pts) — ${dte}d to expiry (wt ${ew})`},
    {v:wallV,w:2.0, r:`Spot ${wallZone} of ${S}–${R} (PE ${fmtOI(peM?.pe_oi||0)} / CE ${fmtOI(ceM?.ce_oi||0)})`},
    {v:skewV,w:1.5, r:`IV skew ${skew.toFixed(1)} (put ${Math.round(pR?.pe_iv||0)} vs call ${Math.round(cR?.ce_iv||0)}) — ${skew>3.5?'downside fear':skew<1.5?'call demand':'normal'}`},
    {v:vixV, w:1.0, r:`India VIX ${vix?vix.toFixed(1):'—'} (${vixZone})`},
    {v:pdhlV,w:1.5, r:`PDH ${pdh?pdh.toFixed(0):'—'} / PDL ${pdl?pdl.toFixed(0):'—'} — ${pdhlV>0.1?'near PDL support':pdhlV<-0.1?'near PDH resistance':'mid-range'}`},
    {v:trendV,w:0.8, r:`30min trend ${trend} (${trendLc?.toFixed(0)} vs ${trendPc?.toFixed(0)})`},
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

  // ── Channel detection ────────────────────────────────────────────────────
  // Uses 3 criteria — all must pass for channel mode to activate

  // 1. Spot inside yesterday's PDH/PDL range (no range expansion)
  const insideYesterdaysRange = pdh && pdl ? (spot < pdh && spot > pdl) : true

  // 2. Today's candle range is tight vs expected move (consolidation)
  //    Get today's high/low from intraday candles
  let todayHigh = spot, todayLow = spot
  if (candles?.length) {
    todayHigh = Math.max(...candles.map(c => c[2]))  // index 2 = high
    todayLow  = Math.min(...candles.map(c => c[3]))  // index 3 = low
  }
  const atm = rows.reduce((b,r) => Math.abs(r.strike-spot)<Math.abs(b.strike-spot)?r:b, rows[0])
  const expectedMove = atm.ce_ltp + atm.pe_ltp
  const todayRange = todayHigh - todayLow
  const tightRange = todayRange < expectedMove * 0.65  // using <65% of expected move

  // 3. No sustained directional trend in last 3 candles
  let sustainedTrend = false
  if (candles?.length >= 3) {
    const last3 = candles.slice(-3).map(c => c[4])  // last 3 closes
    const allUp   = last3[0] < last3[1] && last3[1] < last3[2]
    const allDown = last3[0] > last3[1] && last3[1] > last3[2]
    sustainedTrend = allUp || allDown
  }

  const isChanneling = insideYesterdaysRange && tightRange && !sustainedTrend
  const isTrending   = !insideYesterdaysRange || sustainedTrend || todayRange > expectedMove * 0.9

  // Channel proximity — only meaningful when channeling
  const nearSupport = isChanneling && wallPos < 0.25
  const nearResist  = isChanneling && wallPos > 0.75

  // Market regime label for display
  let regime = 'RANGING'
  if (isTrending && !insideYesterdaysRange && spot > pdh) regime = 'TRENDING UP'
  else if (isTrending && !insideYesterdaysRange && spot < pdl) regime = 'TRENDING DOWN'
  else if (isTrending) regime = 'TRENDING'
  else if (isChanneling) regime = 'CHANNELING'

  return {bias,conv,score,reasons:ranked.map(x=>x.r),pcr,maxPain:mp,
    R,S,wallPos,wallZone,nearSupport,nearResist,
    bld:{bull,bear,totalCe:tCe,totalPe:tPe},
    vixZone,timeWarning,trend,trendLc,trendPc,
    isChanneling,isTrending,regime,
    todayRange:Math.round(todayRange),expectedMove:Math.round(expectedMove),
    insideYesterdaysRange,tightRange,sustainedTrend}
}

function getRec(rows, spot, a, vix) {
  const {bias,conv,timeWarning,nearSupport,nearResist,isChanneling,isTrending,regime}=a

  if(timeWarning) return {type:'Wait',logic:timeWarning}
  if(vix&&vix>20) return {type:'No Trade',logic:`VIX ${vix.toFixed(1)} too high — premiums too expensive`}

  const pick=(side)=>{
    const ltp=`${side}_ltp`,dlt=`${side}_delta`
    const aff=rows.filter(r=>r[ltp]*LOT<=BUDGET&&r[ltp]>0.5).map(r=>({...r,_ad:Math.abs(r[dlt])}))
    if(!aff.length) return null
    aff.sort((a,b)=>b._ad-a._ad||a[ltp]-b[ltp])
    const row=aff[0],cost=row[ltp]*LOT
    const mon=side==='ce'?spot-row.strike:row.strike-spot
    return {strike:row.strike,ltp:row[ltp],delta:row[dlt],theta:row[`${side}_theta`],iv:row[`${side}_iv`],cost,lots:Math.floor(BUDGET/cost),moneyness:Math.round(mon),lowQ:Math.abs(row[dlt])<0.30}
  }

  // ── CHANNELING: wall proximity drives the trade ───────────────────────────
  if(isChanneling) {
    if(nearSupport) {
      const d=pick('ce')
      return {type:'CE Buy',...d,
        logic:`CHANNEL MODE: Near support wall (${a.S}) — bounce setup.${vix&&vix>16?' VIX elevated, size small.':''}`}
    }
    if(nearResist) {
      const d=pick('pe')
      return {type:'PE Buy',...d,
        logic:`CHANNEL MODE: Near resistance wall (${a.R}) — rejection setup.${vix&&vix>16?' VIX elevated, size small.':''}`}
    }
    // Channeling but mid-range — wait for spot to reach a wall
    return {type:'No Trade',
      logic:`CHANNEL MODE: Spot mid-range (${a.S}–${a.R}). Wait for spot to approach a wall before entering.`}
  }

  // ── TRENDING: use directional bias, ignore wall proximity ─────────────────
  if(isTrending) {
    if(bias==='NEUTRAL'||conv<25) {
      return {type:'No Trade',logic:`TREND MODE (${regime}): Awaiting clear directional signal. Conviction ${conv}% too low.`}
    }
    if(bias.includes('BULLISH')){
      const d=pick('ce')
      return {type:'CE Buy',...d,logic:`TREND MODE (${regime}): ${bias} — ride the trend with calls.${d?.lowQ?' Far-OTM only within budget.':''}`}
    }
    const d=pick('pe')
    return {type:'PE Buy',...d,logic:`TREND MODE (${regime}): ${bias} — ride the trend with puts.${d?.lowQ?' Far-OTM only within budget.':''}`}
  }

  // ── DEFAULT: insufficient candle data, use bias ───────────────────────────
  if(bias==='NEUTRAL'||conv<25){
    const sorted=[...rows].sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot))
    for(const r of sorted.slice(0,8)){const c=(r.ce_ltp+r.pe_ltp)*LOT;if(c<=BUDGET)return{type:'Straddle',strike:r.strike,ceLtp:r.ce_ltp,peLtp:r.pe_ltp,cost:c,lots:Math.floor(BUDGET/c),logic:'No directional edge — straddle captures move either way'}}
    return {type:'No Trade',logic:'Low conviction — stay out'}
  }
  if(bias.includes('BULLISH')){const d=pick('ce');return{type:'CE Buy',...d,logic:`${bias} bias.${d?.lowQ?' Far-OTM only.':''}`}}
  const d=pick('pe');return{type:'PE Buy',...d,logic:`${bias} bias.${d?.lowQ?' Far-OTM only.':''}`}
}

function isOpen(){
  const ist=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
  const d=ist.getDay(),m=ist.getHours()*60+ist.getMinutes()
  return d>=1&&d<=5&&m>=9*60+15&&m<=15*60+30
}

const BIAS_COL={BULLISH:'#22c55e','CAUTIOUSLY BULLISH':'#86efac','CAUTIOUSLY BEARISH':'#fb923c',BEARISH:'#ef4444',NEUTRAL:'#94a3b8'}
const REC_COL={'CE Buy':'#22c55e','PE Buy':'#ef4444',Straddle:'#fb923c','No Trade':'#64748b',Wait:'#f59e0b'}

// Outside component — never affected by re-renders
let isFetching = false

export default function App() {
  const [data,  setData]  = useState(null)
  const [err,   setErr]   = useState(null)
  const [loading,setLoading] = useState(false)
  const [updated,setUpdated] = useState(null)
  const [expiry, setExpiry] = useState(null)
  const [expiries,setExpiries] = useState([])
  const expiryRef = useRef(null)

  const fetchData = (sel) => {
    if(!sel||isFetching) return
    isFetching = true
    expiryRef.current = sel
    setLoading(true)
    setErr(null)
    const to=todayStr()
    const from=(()=>{const d=new Date();d.setDate(d.getDate()-5);return d.toISOString().split('T')[0]})()
    Promise.allSettled([
      api('option-chain',{instrument_key:'NSE_INDEX|Nifty 50',expiry_date:sel}),
      api('change-oi',{instrument_key:'NSE_INDEX|Nifty 50',expiry:sel,date:to,interval:1}),
      api('historical',{to_date:to,from_date:from}),
      api('intraday'),
      api('vix-intraday'),
    ]).then(([r1,r2,r3,r4,r5])=>{
      if(r1.status==='rejected') throw new Error('Option chain failed: '+r1.reason.message)
      const chain=r1.value.data, spot=chain[0].underlying_spot_price
      const oiData=r2.status==='fulfilled'?r2.value.data:null
      const hc=r3.status==='fulfilled'?r3.value.data?.candles||[]:[]
      const pdh=hc.length?hc[0][2]:null, pdl=hc.length?hc[0][3]:null
      const ic=r4.status==='fulfilled'?r4.value.data?.candles||null:null
      const vc=r5.status==='fulfilled'?r5.value.data?.candles||[]:[]
      const vix=vc.length?vc[vc.length-1][4]:null
      const rows=chain.map(s=>({
        strike:s.strike_price,
        ce_oi:s.call_options.market_data.oi,ce_prev_oi:s.call_options.market_data.prev_oi,
        ce_ltp:s.call_options.market_data.ltp,ce_iv:s.call_options.option_greeks.iv,
        ce_delta:s.call_options.option_greeks.delta,ce_theta:s.call_options.option_greeks.theta,
        pe_oi:s.put_options.market_data.oi,pe_prev_oi:s.put_options.market_data.prev_oi,
        pe_ltp:s.put_options.market_data.ltp,pe_iv:s.put_options.option_greeks.iv,
        pe_delta:s.put_options.option_greeks.delta,pe_theta:s.put_options.option_greeks.theta,
      }))
      const dte=Math.max(0,Math.round((new Date(sel)-new Date(to))/86400000))
      const atm=rows.reduce((b,r)=>Math.abs(r.strike-spot)<Math.abs(b.strike-spot)?r:b,rows[0])
      const near=rows.filter(r=>Math.abs(r.strike-spot)<=NTM)
      const ceW=[...near].sort((a,b)=>b.ce_oi-a.ce_oi).slice(0,3)
      const peW=[...near].sort((a,b)=>b.pe_oi-a.pe_oi).slice(0,3)
      const a=analyse(rows,spot,dte,oiData,vix,pdh,pdl,ic)
      const rec=getRec(rows,spot,a,vix)
      setData({spot,rows,dte,em:atm.ce_ltp+atm.pe_ltp,ceW,peW,a,rec,vix,pdh,pdl})
      setUpdated(new Date())
      setErr(null)
    }).catch(e=>{
      setErr(e.message)
    }).finally(()=>{
      isFetching = false
      setLoading(false)
    })
  }

  useEffect(()=>{
    api('option-contract',{instrument_key:'NSE_INDEX|Nifty 50'})
      .then(res=>{
        const list=[...new Set(res.data.map(i=>i.expiry))].sort()
        const nearest=list.find(e=>e>=todayStr())||list[0]
        setExpiries(list.slice(0,6))
        setExpiry(nearest)
        expiryRef.current = nearest
      }).catch(e=>setErr('Expiry load failed: '+e.message))
  },[])

  useEffect(()=>{ if(expiry) fetchData(expiry) },[expiry])

  useEffect(()=>{
    const t=setInterval(()=>{ if(isOpen()&&expiry) fetchData(expiry) },15*60*1000)
    return ()=>clearInterval(t)
  },[expiry])

  const bias=data?.a?.bias||'NEUTRAL'
  const bc=BIAS_COL[bias]||'#94a3b8'
  const conv=data?.a?.conv||0

  return (
    <div style={{background:'#070a0f',minHeight:'100vh',color:'#e2e8f0',fontFamily:"'JetBrains Mono',monospace",padding:'0 0 80px'}}>
      <link href="https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;600;700&family=Syne:wght@400;600;800&display=swap" rel="stylesheet"/>

      {/* Header */}
      <div style={{background:'#0d1117',borderBottom:'1px solid #1e2a3a',padding:'14px 16px',position:'sticky',top:0,zIndex:10}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:18,color:'#f8fafc'}}>NIFTY OPTIONS</div>
            <div style={{fontSize:10,color:'#475569',marginTop:1}}>
              {updated?`Updated ${updated.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`:'Loading...'}
              {' · '}<span style={{color:isOpen()?'#22c55e':'#ef4444'}}>{isOpen()?'● LIVE':'● CLOSED'}</span>
              {data?.vix!=null&&<span style={{marginLeft:8,color:data.vix>16?'#fb923c':'#64748b'}}>VIX {data.vix.toFixed(1)}</span>}
            </div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:22,color:'#f8fafc'}}>
              {data?`₹${data.spot.toLocaleString('en-IN',{minimumFractionDigits:2})}`:'—'}
            </div>
            <button onClick={()=>{ isFetching=false; fetchData(expiryRef.current||expiry) }} disabled={loading}
              style={{background:loading?'#1e2a3a':'#1d4ed8',border:'none',borderRadius:4,color:'#fff',fontSize:10,padding:'3px 10px',cursor:loading?'default':'pointer',fontFamily:'inherit',marginTop:2}}>
              {loading?'LOADING...':'↻ REFRESH'}
            </button>
          </div>
        </div>
        <div style={{display:'flex',gap:6,marginTop:10,overflowX:'auto',paddingBottom:2}}>
          {expiries.map(e=>(
            <button key={e} onClick={()=>{ expiryRef.current=e; setExpiry(e) }}
              style={{background:expiry===e?'#1d4ed8':'#1e2a3a',border:'none',borderRadius:4,color:expiry===e?'#fff':'#94a3b8',fontSize:10,padding:'5px 10px',cursor:'pointer',whiteSpace:'nowrap',fontFamily:'inherit'}}>
              {e}
            </button>
          ))}
        </div>
      </div>

      {err&&<div style={{margin:16,padding:12,background:'#1c0a0a',border:'1px solid #7f1d1d',borderRadius:8,color:'#fca5a5',fontSize:12}}>⚠ {err}</div>}

      {data&&(<>
        {data.a.timeWarning&&<div style={{margin:'12px 12px 0',padding:'10px 14px',background:'#1c1400',border:'1px solid #92400e',borderRadius:8,color:'#fbbf24',fontSize:12}}>⏰ {data.a.timeWarning}</div>}

        {/* Bias */}
        <div style={{margin:'12px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${bc}33`}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <div style={{fontSize:10,color:'#475569',marginBottom:4}}>MARKET BIAS</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:26,color:bc,lineHeight:1}}>{bias}</div>
              <div style={{fontSize:11,color:'#64748b',marginTop:6}}>±{data.em.toFixed(0)} pts · PCR {data.a.pcr} · MP {data.a.maxPain}</div>
            </div>
            <div style={{textAlign:'right'}}>
              <div style={{fontSize:10,color:'#475569',marginBottom:4}}>CONVICTION</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:36,color:conv>=50?'#22c55e':conv>=30?'#fb923c':'#64748b',lineHeight:1}}>{conv}%</div>
              <div style={{width:80,height:4,background:'#1e2a3a',borderRadius:2,marginTop:6,marginLeft:'auto'}}>
                <div style={{width:`${conv}%`,height:'100%',background:conv>=50?'#22c55e':conv>=30?'#fb923c':'#475569',borderRadius:2}}/>
              </div>
            </div>
          </div>
          <div style={{marginTop:12,borderTop:'1px solid #1e2a3a',paddingTop:10}}>
            {data.a.reasons.slice(0,5).map((r,i)=>(
              <div key={i} style={{fontSize:11,color:i===0?'#cbd5e1':'#64748b',padding:'3px 0',lineHeight:1.4}}>
                <span style={{color:'#334155',marginRight:6}}>{i+1}.</span>{r}
              </div>
            ))}
          </div>
        </div>

        {/* VIX / PDH PDL / Trend */}
        <div style={{margin:'10px 12px 0',display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:8}}>
          <div style={{background:'#0d1117',borderRadius:10,border:'1px solid #1e2a3a',padding:'10px 12px'}}>
            <div style={{fontSize:9,color:'#475569',marginBottom:4}}>INDIA VIX</div>
            <div style={{fontSize:20,fontWeight:700,color:data.vix>16?'#fb923c':data.vix<13?'#22c55e':'#94a3b8'}}>{data.vix!=null?data.vix.toFixed(1):'—'}</div>
            <div style={{fontSize:9,color:'#475569',marginTop:2}}>{data.a.vixZone}</div>
          </div>
          <div style={{background:'#0d1117',borderRadius:10,border:'1px solid #1e2a3a',padding:'10px 12px'}}>
            <div style={{fontSize:9,color:'#475569',marginBottom:4}}>PDH / PDL</div>
            <div style={{fontSize:12,color:'#ef4444'}}>{data.pdh?data.pdh.toFixed(0):'—'}</div>
            <div style={{fontSize:12,color:'#22c55e'}}>{data.pdl?data.pdl.toFixed(0):'—'}</div>
            <div style={{fontSize:9,color:'#475569',marginTop:2}}>high / low</div>
          </div>
          <div style={{background:'#0d1117',borderRadius:10,border:'1px solid #1e2a3a',padding:'10px 12px'}}>
            <div style={{fontSize:9,color:'#475569',marginBottom:4}}>30M TREND</div>
            <div style={{fontSize:20,fontWeight:700,color:data.a.trend==='up'?'#22c55e':data.a.trend==='down'?'#ef4444':'#94a3b8'}}>
              {data.a.trend==='up'?'↑':data.a.trend==='down'?'↓':'→'}
            </div>
            <div style={{fontSize:9,color:'#475569',marginTop:2}}>{data.a.trend}</div>
          </div>
        </div>

        {/* Channel */}
        <div style={{margin:'10px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${data.a.nearSupport?'#22c55e33':data.a.nearResist?'#ef444433':'#1e2a3a'}`}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',marginBottom:10}}>
            <div style={{fontSize:10,color:'#475569'}}>
              CHANNEL POSITION
              {data.a.nearSupport&&<span style={{color:'#22c55e',marginLeft:8,fontWeight:700}}>● NEAR SUPPORT</span>}
              {data.a.nearResist&&<span style={{color:'#ef4444',marginLeft:8,fontWeight:700}}>● NEAR RESISTANCE</span>}
            </div>
            <div style={{
              fontSize:10,fontWeight:700,padding:'3px 8px',borderRadius:4,
              background: data.a.regime==='CHANNELING'?'#14532d':
                          data.a.regime.includes('UP')?'#1e3a5f':
                          data.a.regime.includes('DOWN')?'#3b0000':'#1c1917',
              color: data.a.regime==='CHANNELING'?'#4ade80':
                     data.a.regime.includes('UP')?'#60a5fa':
                     data.a.regime.includes('DOWN')?'#f87171':'#d6d3d1'
            }}>{data.a.regime}</div>
          </div>
          {/* Channel detection reasoning */}
          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr 1fr',gap:6,marginBottom:12}}>
            <div style={{fontSize:10,color:data.a.insideYesterdaysRange?'#4ade80':'#f87171',textAlign:'center'}}>
              {data.a.insideYesterdaysRange?'✓':'✗'} Inside PDH/PDL
            </div>
            <div style={{fontSize:10,color:data.a.tightRange?'#4ade80':'#f87171',textAlign:'center'}}>
              {data.a.tightRange?'✓':'✗'} Tight range ({data.a.todayRange} vs ±{data.a.expectedMove})
            </div>
            <div style={{fontSize:10,color:!data.a.sustainedTrend?'#4ade80':'#f87171',textAlign:'center'}}>
              {!data.a.sustainedTrend?'✓':'✗'} No sustained trend
            </div>
          </div>
          <div style={{position:'relative',height:48}}>
            <div style={{position:'absolute',top:20,left:0,right:0,height:8,background:'#1e2a3a',borderRadius:4}}>
              <div style={{position:'absolute',left:0,width:'25%',height:'100%',background:'#22c55e22',borderRadius:'4px 0 0 4px'}}/>
              <div style={{position:'absolute',right:0,width:'25%',height:'100%',background:'#ef444422',borderRadius:'0 4px 4px 0'}}/>
              <div style={{position:'absolute',left:`${Math.max(2,Math.min(96,(data.a.wallPos||0.5)*100))}%`,top:'50%',transform:'translate(-50%,-50%)',width:14,height:14,background:bc,borderRadius:'50%',boxShadow:`0 0 8px ${bc}88`,zIndex:2}}/>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:36}}>
              <div style={{fontSize:11,color:'#22c55e'}}>⬆ {data.a.S} <span style={{color:'#334155',fontSize:10}}>support</span></div>
              <div style={{fontSize:11,color:'#64748b'}}>{data.a.wallZone}</div>
              <div style={{fontSize:11,color:'#ef4444'}}>{data.a.R} ⬇ <span style={{color:'#334155',fontSize:10}}>resist</span></div>
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
                  <div style={{fontSize:12,color:'#e2e8f0'}}>{w.strike}</div>
                  <div style={{fontSize:11,color}}>{fmtOI(w[ok])}</div>
                </div>
              ))}
            </div>
          ))}
        </div>

        {/* Trade */}
        <div style={{margin:'10px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${REC_COL[data.rec.type]||'#334155'}55`}}>
          <div style={{fontSize:10,color:'#475569',marginBottom:10}}>RECOMMENDED TRADE · Budget ₹{BUDGET.toLocaleString('en-IN')}</div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:20,color:REC_COL[data.rec.type]||'#64748b'}}>{data.rec.type}</div>
              {data.rec.strike&&<div style={{fontSize:22,fontWeight:700,color:'#f8fafc',marginTop:2}}>{data.rec.strike}{data.rec.type==='CE Buy'?'C':data.rec.type==='PE Buy'?'P':''}</div>}
            </div>
            {data.rec.cost&&<div style={{textAlign:'right'}}>
              <div style={{fontSize:14,color:'#94a3b8'}}>₹{data.rec.cost.toLocaleString('en-IN',{maximumFractionDigits:0})}<span style={{fontSize:10}}>/lot</span></div>
              <div style={{fontSize:16,color:'#f8fafc',fontWeight:700}}>{data.rec.lots} lot{data.rec.lots>1?'s':''}</div>
            </div>}
          </div>
          {data.rec.ltp&&<div style={{marginTop:8,fontSize:11,color:'#475569'}}>LTP ₹{data.rec.ltp} · Δ {Math.abs(data.rec.delta).toFixed(2)} · {Math.abs(data.rec.moneyness)} pts {data.rec.moneyness>=0?'ITM':'OTM'} · θ {data.rec.theta?.toFixed(0)}/day · IV {data.rec.iv?.toFixed(0)}</div>}
          {data.rec.ceLtp&&<div style={{marginTop:8,fontSize:11,color:'#475569'}}>CE ₹{data.rec.ceLtp} + PE ₹{data.rec.peLtp}</div>}
          <div style={{marginTop:8,fontSize:11,color:'#334155',fontStyle:'italic'}}>{data.rec.logic}</div>
          {data.rec.lowQ&&<div style={{marginTop:6,fontSize:11,color:'#fb923c'}}>⚠ Far-OTM only within budget</div>}
          {data.dte<=2&&!['No Trade','Wait'].includes(data.rec.type)&&<div style={{marginTop:6,fontSize:11,color:'#fb923c'}}>⚠ {data.dte}d to expiry — steep theta</div>}
        </div>

        {/* OI Change */}
        {(data.a.bld.bull>0||data.a.bld.bear>0)&&(
          <div style={{margin:'10px 12px 0',padding:14,background:'#0d1117',borderRadius:12,border:'1px solid #1e2a3a'}}>
            <div style={{fontSize:10,color:'#475569',marginBottom:8}}>OI CHANGE (TODAY vs YESTERDAY)</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div style={{background:'#052e16',borderRadius:8,padding:10,textAlign:'center'}}>
                <div style={{fontSize:10,color:'#4ade80'}}>PUT SUPPORT</div>
                <div style={{fontSize:16,fontWeight:700,color:'#22c55e',marginTop:2}}>{fmtOI(data.a.bld.bull)}</div>
              </div>
              <div style={{background:'#2d0a0a',borderRadius:8,padding:10,textAlign:'center'}}>
                <div style={{fontSize:10,color:'#f87171'}}>CALL RESIST</div>
                <div style={{fontSize:16,fontWeight:700,color:'#ef4444',marginTop:2}}>{fmtOI(data.a.bld.bear)}</div>
              </div>
            </div>
            <div style={{marginTop:8,fontSize:11,color:'#334155',display:'flex',justifyContent:'space-between'}}>
              <span>Total CE chg: {fmtOI(data.a.bld.totalCe)}</span>
              <span>Total PE chg: {fmtOI(data.a.bld.totalPe)}</span>
            </div>
          </div>
        )}

        <div style={{margin:'16px 12px 0',fontSize:10,color:'#1e2a3a',textAlign:'center'}}>
          Refreshes every 15 min during market hours · Positioning-based, not financial advice
        </div>
      </>)}
    </div>
  )
}
