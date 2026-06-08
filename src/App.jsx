import { useState, useEffect, useRef } from 'react'

// ─── API ──────────────────────────────────────────────────────────────────────
const api = async (endpoint, params = {}) => {
  const qs = new URLSearchParams({ endpoint, ...params }).toString()
  const res = await fetch(`/api/upstox?${qs}`)
  const json = await res.json()
  if (!res.ok) throw new Error(`${endpoint} ${res.status}`)
  return json
}

const todayStr = () => new Date().toISOString().split('T')[0]

// ─── SIGNAL ENGINE ────────────────────────────────────────────────────────────
const NTM   = 500
const LOT   = 65
const BUDGET= 10000
const clip  = (x, lo=-1, hi=1) => Math.max(lo, Math.min(hi, x))
const fmtOI = v => Math.abs(v)>=1e6 ? `${(v/1e6).toFixed(2)}M` : `${(v/1e3).toFixed(0)}K`

function sigPCR(near) {
  const ce=near.reduce((s,r)=>s+r.ce_oi,0), pe=near.reduce((s,r)=>s+r.pe_oi,0)
  const cep=near.reduce((s,r)=>s+r.ce_prev_oi,0), pep=near.reduce((s,r)=>s+r.pe_prev_oi,0)
  const pcr=ce?+(pe/ce).toFixed(2):0, prev=cep?+(pep/cep).toFixed(2):pcr
  let v=clip(0.6*(pcr-1)/0.5+0.4*(pcr-prev)/0.2)
  if(pcr>1.8||pcr<0.45) v*=0.5
  const dir=v>0.1?'bullish':v<-0.1?'bearish':'neutral'
  return {vote:clip(v),pcr,prev,reason:`NTM PCR ${pcr} (${pcr>prev?'rising':'falling'} from ${prev}) — ${dir}`}
}

function sigBuildup(spot, oiData) {
  if (!oiData?.call_put_oi_data_list?.length) return {vote:0,bull:0,bear:0,totalCe:0,totalPe:0,reason:'OI change — no data'}
  let bull=0,bear=0
  for (const s of oiData.call_put_oi_data_list) {
    if (Math.abs(s.strike_price-spot)>NTM) continue
    const {strike_price:sp,call_change_oi:ce,put_change_oi:pe}=s
    if(sp>spot){if(ce>0)bear+=ce;else bull+=Math.abs(ce);if(pe>0)bull+=pe*0.3}
    else{if(pe>0)bull+=pe;else bear+=Math.abs(pe);if(ce>0)bear+=ce*0.3}
  }
  const tot=bull+bear, v=tot?clip((bull-bear)/tot):0
  const dir=v>0.1?'bullish':v<-0.1?'bearish':'balanced'
  const tCe=oiData.total_call_change_oi||0, tPe=oiData.total_put_change_oi||0
  return {vote:v,bull,bear,totalCe:tCe,totalPe:tPe,reason:`OI change ${dir}: put support ${fmtOI(bull)} vs call resistance ${fmtOI(bear)} (CE chg ${fmtOI(tCe)} / PE chg ${fmtOI(tPe)})`}
}

function sigMaxPain(rows, spot, dte) {
  const pain={}
  for(const r of rows){let l=0;for(const o of rows){l+=Math.max(0,r.strike-o.strike)*o.ce_oi;l+=Math.max(0,o.strike-r.strike)*o.pe_oi};pain[r.strike]=l}
  const mp=+Object.entries(pain).sort((a,b)=>a[1]-b[1])[0][0]
  const gap=mp-spot, ew=dte<=1?1:dte<=2?0.6:dte<=4?0.35:0.2
  return {vote:clip(gap/spot/0.01)*ew,maxPain:mp,expW:ew,reason:`Max pain ${mp} (${gap>0?'+':''}${Math.round(gap)} pts) — ${dte}d to expiry (wt ${ew})`}
}

function sigWalls(near, spot) {
  if(!near.length) return {vote:0,R:spot+500,S:spot-500,zone:'unknown',pos:0.5,reason:'Walls — no data'}
  const ceM=near.reduce((b,r)=>r.ce_oi>b.ce_oi?r:b,near[0])
  const peM=near.reduce((b,r)=>r.pe_oi>b.pe_oi?r:b,near[0])
  const R=ceM.strike,S=peM.strike
  if(R-S<150) return {vote:0,R,S,zone:'tight',pos:0.5,reason:`Walls tight (${S}–${R})`}
  const pos=(spot-S)/(R-S)
  const str=(peM.pe_oi-ceM.ce_oi)/(peM.pe_oi+ceM.ce_oi)
  const v=clip(0.8*(0.5-pos)*2+0.2*str)
  const zone=pos<0.35?'near support':pos>0.65?'near resistance':'mid-range'
  return {vote:v,R,S,ceOI:ceM.ce_oi,peOI:peM.pe_oi,zone,pos,reason:`Spot ${zone} of ${S}–${R} (PE ${fmtOI(peM.pe_oi)} / CE ${fmtOI(ceM.ce_oi)})`}
}

function sigSkew(rows, spot) {
  const BASE=2.5
  const pR=rows.reduce((b,r)=>Math.abs(r.strike-(spot-NTM))<Math.abs(b.strike-(spot-NTM))?r:b,rows[0])
  const cR=rows.reduce((b,r)=>Math.abs(r.strike-(spot+NTM))<Math.abs(b.strike-(spot+NTM))?r:b,rows[0])
  if(!pR||!cR) return {vote:0,reason:'IV skew — no data'}
  const skew=pR.pe_iv-cR.ce_iv, v=clip(-(skew-BASE)/4)
  const tone=skew>BASE+1?'downside fear':skew<BASE-1?'call demand':'normal'
  return {vote:v,skew,reason:`IV skew ${skew.toFixed(1)} (put ${Math.round(pR.pe_iv)} vs call ${Math.round(cR.ce_iv)}) — ${tone}`}
}

function sigVix(vix) {
  if(!vix) return {vote:0,vix:null,zone:'unknown',reason:'VIX — unavailable'}
  let v=0,zone='',note=''
  if(vix<13){v=0.3;zone='LOW';note='cheap premiums — good for buying'}
  else if(vix<=16){v=0.1;zone='NORMAL';note='normal premiums'}
  else if(vix<=20){v=-0.2;zone='ELEVATED';note='expensive — size down'}
  else{v=-0.5;zone='HIGH';note='avoid buying options'}
  return {vote:v,vix,zone,note,reason:`India VIX ${vix.toFixed(1)} (${zone}) — ${note}`}
}

function sigPDHL(spot, pdh, pdl) {
  if(!pdh||!pdl) return {vote:0,pdh,pdl,reason:'PDH/PDL — unavailable'}
  const range=pdh-pdl, pos=(spot-pdl)/range
  const v=clip((0.5-pos)*2)
  const zone=pos>0.8?'near PDH (resistance)':pos<0.2?'near PDL (support)':'mid-range'
  return {vote:v,pdh,pdl,distPDH:Math.round(pdh-spot),distPDL:Math.round(spot-pdl),reason:`PDH ${pdh.toFixed(0)} (+${Math.round(pdh-spot)} pts) / PDL ${pdl.toFixed(0)} (-${Math.round(spot-pdl)} pts) — ${zone}`}
}

function getTrend(candles) {
  if(!candles||candles.length<2) return {trend:'unknown',trendVote:0,timeWarning:null}
  const last=candles[candles.length-1],prev=candles[candles.length-2]
  const lc=last[4],pc=prev[4]
  const trend=lc>pc?'up':lc<pc?'down':'flat'
  const trendVote=lc>pc?0.3:lc<pc?-0.3:0
  const now=new Date()
  const ist=new Date(now.toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
  const mins=ist.getHours()*60+ist.getMinutes()
  let timeWarning=null
  if(mins<9*60+45) timeWarning='Opening volatility (9:15–9:45) — wait for settlement'
  else if(mins>14*60+45) timeWarning='Last 45 mins — theta collapse, avoid buying options'
  return {trend,trendVote,timeWarning,lc,pc}
}

function computeBias(rows, spot, dte, oiData, vix, pdh, pdl, candles) {
  const near=rows.filter(r=>Math.abs(r.strike-spot)<=NTM)
  const pcr=sigPCR(near), bld=sigBuildup(spot,oiData), mp=sigMaxPain(rows,spot,dte)
  const wall=sigWalls(near,spot), skew=sigSkew(rows,spot), vixS=sigVix(vix)
  const pdhl=sigPDHL(spot,pdh,pdl), tctx=getTrend(candles)
  const sigs=[
    {v:pcr.vote, w:2.0, r:pcr.reason},
    {v:bld.vote, w:1.5, r:bld.reason},
    {v:mp.vote,  w:1.2*mp.expW, r:mp.reason},
    {v:wall.vote,w:2.0, r:wall.reason},
    {v:skew.vote,w:1.5, r:skew.reason},
    {v:vixS.vote,w:1.0, r:vixS.reason},
    {v:pdhl.vote,w:1.5, r:pdhl.reason},
    {v:tctx.trendVote,w:0.8,r:`30min trend ${tctx.trend} (${tctx.lc?.toFixed(0)} vs ${tctx.pc?.toFixed(0)})`},
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
  return {bias,conv,score,reasons:ranked.map(x=>x.r),
    pcr:pcr.pcr,maxPain:mp.maxPain,R:wall.R,S:wall.S,
    wallZone:wall.zone,wallPos:wall.pos,bld,vixS,pdhl,tctx}
}

function getRec(rows, spot, bias, conv, vix, timeWarning) {
  if(timeWarning) return {type:'Wait',logic:timeWarning}
  if(vix&&vix>20) return {type:'No Trade',logic:`VIX ${vix.toFixed(1)} too high — premiums too expensive`}
  const pick=(side)=>{
    const ltp=`${side}_ltp`,dlt=`${side}_delta`
    const aff=rows.filter(r=>r[ltp]*LOT<=BUDGET&&r[ltp]>0.5)
    if(!aff.length) return null
    aff.forEach(r=>r._ad=Math.abs(r[dlt]))
    aff.sort((a,b)=>b._ad-a._ad||a[ltp]-b[ltp])
    const row=aff[0],cost=row[ltp]*LOT
    const mon=side==='ce'?spot-row.strike:row.strike-spot
    return {strike:row.strike,ltp:row[ltp],delta:row[dlt],theta:row[`${side}_theta`],iv:row[`${side}_iv`],cost,lots:Math.floor(BUDGET/cost),moneyness:Math.round(mon),lowQ:Math.abs(row[dlt])<0.30}
  }
  if(bias==='NEUTRAL'||conv<25){
    const sorted=[...rows].sort((a,b)=>Math.abs(a.strike-spot)-Math.abs(b.strike-spot))
    for(const r of sorted.slice(0,8)){const c=(r.ce_ltp+r.pe_ltp)*LOT;if(c<=BUDGET)return{type:'Straddle',strike:r.strike,ceLtp:r.ce_ltp,peLtp:r.pe_ltp,cost:c,lots:Math.floor(BUDGET/c),logic:'No directional edge — straddle captures move either way'}}
    return {type:'No Trade',logic:'Low conviction — stay out'}
  }
  if(bias.includes('BULLISH')){const d=pick('ce');return{type:'CE Buy',...d,logic:d?.lowQ?`Far-OTM only (Δ${Math.abs(d.delta).toFixed(2)}) — consider skipping`:'Bullish — closest-to-ITM call in budget'}}
  const d=pick('pe');return{type:'PE Buy',...d,logic:d?.lowQ?`Far-OTM only (Δ${Math.abs(d.delta).toFixed(2)}) — consider skipping`:'Bearish — closest-to-ITM put in budget'}
}

// ─── APP ──────────────────────────────────────────────────────────────────────
const BIAS_COLOR={BULLISH:'#22c55e','CAUTIOUSLY BULLISH':'#86efac','CAUTIOUSLY BEARISH':'#fb923c',BEARISH:'#ef4444',NEUTRAL:'#94a3b8'}
const REC_COLOR={'CE Buy':'#22c55e','PE Buy':'#ef4444',Straddle:'#fb923c','No Trade':'#64748b',Wait:'#f59e0b'}

function isOpen(){
  const ist=new Date(new Date().toLocaleString('en-US',{timeZone:'Asia/Kolkata'}))
  const d=ist.getDay(),m=ist.getHours()*60+ist.getMinutes()
  return d>=1&&d<=5&&m>=9*60+15&&m<=15*60+30
}

export default function App() {
  const [state, setState] = useState({data:null,error:null,loading:false,lastUpdate:null,marketOpen:false})
  const [expiry, setExpiry] = useState(null)
  const [expiries, setExpiries] = useState([])
  const loadingRef = useRef(false)

  // Load expiries once
  useEffect(()=>{
    api('option-contract',{instrument_key:'NSE_INDEX|Nifty 50'})
      .then(res=>{
        const list=[...new Set(res.data.map(i=>i.expiry))].sort()
        const nearest=list.find(e=>e>=todayStr())||list[0]
        setExpiries(list.slice(0,6))
        setExpiry(nearest)
      })
      .catch(e=>setState(s=>({...s,error:'Failed to load expiries: '+e.message})))
  },[])

  const fetchData = async (sel) => {
    if(!sel||loadingRef.current) return
    loadingRef.current=true
    setState(s=>({...s,loading:true,error:null}))
    try {
      const to=todayStr()
      const from=(()=>{const d=new Date();d.setDate(d.getDate()-5);return d.toISOString().split('T')[0]})()
      const [c1,c2,c3,c4,c5]=await Promise.all([
        api('option-chain',{instrument_key:'NSE_INDEX|Nifty 50',expiry_date:sel}),
        api('change-oi',{instrument_key:'NSE_INDEX|Nifty 50',expiry:sel,date:to,interval:1}),
        api('historical',{to_date:to,from_date:from}),
        api('intraday'),
        api('vix-intraday'),
      ])
      const chain=c1.data, spot=chain[0].underlying_spot_price
      const oiData=c2.data
      const histCandles=c3.data?.candles||[]
      const pdh=histCandles.length?histCandles[0][2]:null
      const pdl=histCandles.length?histCandles[0][3]:null
      const intCandles=c4.data?.candles||null
      const vixC=c5.data?.candles||[]
      const vix=vixC.length?vixC[vixC.length-1][4]:null
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
      const em=atm.ce_ltp+atm.pe_ltp
      const near=rows.filter(r=>Math.abs(r.strike-spot)<=NTM)
      const ceW=[...near].sort((a,b)=>b.ce_oi-a.ce_oi).slice(0,3)
      const peW=[...near].sort((a,b)=>b.pe_oi-a.pe_oi).slice(0,3)
      const analysis=computeBias(rows,spot,dte,oiData,vix,pdh,pdl,intCandles)
      const rec=getRec(rows,spot,analysis.bias,analysis.conv,vix,analysis.tctx.timeWarning)
      setState({data:{spot,rows,dte,em,ceW,peW,analysis,rec,vix,pdh,pdl},error:null,loading:false,lastUpdate:new Date(),marketOpen:isOpen()})
    } catch(e) {
      setState(s=>({...s,error:e.message,loading:false}))
    } finally {
      loadingRef.current=false
    }
  }

  // Fetch when expiry set
  useEffect(()=>{ if(expiry) fetchData(expiry) },[expiry])

  // Auto-refresh every 15min during market hours
  useEffect(()=>{
    const t=setInterval(()=>{ if(isOpen()&&expiry) fetchData(expiry) },15*60*1000)
    return ()=>clearInterval(t)
  },[expiry])

  const {data,error,loading,lastUpdate,marketOpen}=state
  const bias=data?.analysis?.bias||'NEUTRAL'
  const bc=BIAS_COLOR[bias]||'#94a3b8'
  const conv=data?.analysis?.conv||0

  return (
    <div style={{background:'#070a0f',minHeight:'100vh',color:'#e2e8f0',fontFamily:"'JetBrains Mono',monospace",padding:'0 0 80px'}}>
      {/* Header */}
      <div style={{background:'#0d1117',borderBottom:'1px solid #1e2a3a',padding:'14px 16px',position:'sticky',top:0,zIndex:10}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
          <div>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:18,color:'#f8fafc'}}>NIFTY OPTIONS</div>
            <div style={{fontSize:10,color:'#475569',marginTop:1}}>
              {lastUpdate?`Updated ${lastUpdate.toLocaleTimeString('en-IN',{hour:'2-digit',minute:'2-digit',timeZone:'Asia/Kolkata'})} IST`:'Loading...'}
              {' · '}<span style={{color:marketOpen?'#22c55e':'#ef4444'}}>{marketOpen?'● LIVE':'● CLOSED'}</span>
              {data?.vix&&<span style={{marginLeft:8,color:data.vix>16?'#fb923c':'#64748b'}}>VIX {data.vix.toFixed(1)}</span>}
            </div>
          </div>
          <div style={{textAlign:'right'}}>
            <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:22,color:'#f8fafc'}}>
              {data?`₹${data.spot.toLocaleString('en-IN',{minimumFractionDigits:2})}`:'—'}
            </div>
            <button
              onClick={()=>fetchData(expiry)}
              disabled={loading}
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

      {error&&<div style={{margin:16,padding:12,background:'#1c0a0a',border:'1px solid #7f1d1d',borderRadius:8,color:'#fca5a5',fontSize:12}}>⚠ {error}</div>}

      {data&&(<>
        {data.analysis.tctx.timeWarning&&(
          <div style={{margin:'12px 12px 0',padding:'10px 14px',background:'#1c1400',border:'1px solid #92400e',borderRadius:8,color:'#fbbf24',fontSize:12}}>
            ⏰ {data.analysis.tctx.timeWarning}
          </div>
        )}

        {/* Bias */}
        <div style={{margin:'12px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${bc}33`}}>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'flex-start'}}>
            <div>
              <div style={{fontSize:10,color:'#475569',marginBottom:4}}>MARKET BIAS</div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:26,color:bc,lineHeight:1}}>{bias}</div>
              <div style={{fontSize:11,color:'#64748b',marginTop:6}}>±{data.em.toFixed(0)} pts · PCR {data.analysis.pcr} · MP {data.analysis.maxPain}</div>
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
            {data.analysis.reasons.slice(0,5).map((r,i)=>(
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
            <div style={{fontSize:20,fontWeight:700,color:data.vix>16?'#fb923c':data.vix<13?'#22c55e':'#94a3b8'}}>{data.vix?data.vix.toFixed(1):'—'}</div>
            <div style={{fontSize:9,color:'#475569',marginTop:2}}>{data.analysis.vixS.zone}</div>
          </div>
          <div style={{background:'#0d1117',borderRadius:10,border:'1px solid #1e2a3a',padding:'10px 12px'}}>
            <div style={{fontSize:9,color:'#475569',marginBottom:4}}>PDH / PDL</div>
            <div style={{fontSize:12,color:'#ef4444'}}>{data.pdh?data.pdh.toFixed(0):'—'}</div>
            <div style={{fontSize:12,color:'#22c55e'}}>{data.pdl?data.pdl.toFixed(0):'—'}</div>
            <div style={{fontSize:9,color:'#475569',marginTop:2}}>high / low</div>
          </div>
          <div style={{background:'#0d1117',borderRadius:10,border:'1px solid #1e2a3a',padding:'10px 12px'}}>
            <div style={{fontSize:9,color:'#475569',marginBottom:4}}>30M TREND</div>
            <div style={{fontSize:20,fontWeight:700,color:data.analysis.tctx.trend==='up'?'#22c55e':data.analysis.tctx.trend==='down'?'#ef4444':'#94a3b8'}}>
              {data.analysis.tctx.trend==='up'?'↑':data.analysis.tctx.trend==='down'?'↓':'→'}
            </div>
            <div style={{fontSize:9,color:'#475569',marginTop:2}}>{data.analysis.tctx.trend}</div>
          </div>
        </div>

        {/* Channel */}
        <div style={{margin:'10px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:'1px solid #1e2a3a'}}>
          <div style={{fontSize:10,color:'#475569',marginBottom:10}}>CHANNEL POSITION</div>
          <div style={{position:'relative',height:48}}>
            <div style={{position:'absolute',top:20,left:0,right:0,height:8,background:'#1e2a3a',borderRadius:4}}>
              <div style={{position:'absolute',left:0,width:'20%',height:'100%',background:'#22c55e22',borderRadius:'4px 0 0 4px'}}/>
              <div style={{position:'absolute',right:0,width:'20%',height:'100%',background:'#ef444422',borderRadius:'0 4px 4px 0'}}/>
              <div style={{position:'absolute',left:`${Math.max(2,Math.min(96,(data.analysis.wallPos||0.5)*100))}%`,top:'50%',transform:'translate(-50%,-50%)',width:14,height:14,background:bc,borderRadius:'50%',boxShadow:`0 0 8px ${bc}88`,zIndex:2}}/>
            </div>
            <div style={{display:'flex',justifyContent:'space-between',marginTop:36}}>
              <div style={{fontSize:11,color:'#22c55e'}}>⬆ {data.analysis.S} <span style={{color:'#334155',fontSize:10}}>support</span></div>
              <div style={{fontSize:11,color:'#64748b'}}>{data.analysis.wallZone}</div>
              <div style={{fontSize:11,color:'#ef4444'}}>{data.analysis.R} ⬇ <span style={{color:'#334155',fontSize:10}}>resist</span></div>
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
        <div style={{margin:'10px 12px 0',padding:16,background:'#0d1117',borderRadius:12,border:`1px solid ${REC_COLOR[data.rec.type]||'#334155'}44`}}>
          <div style={{fontSize:10,color:'#475569',marginBottom:10}}>RECOMMENDED TRADE · Budget ₹{BUDGET.toLocaleString('en-IN')}</div>
          <div style={{display:'flex',justifyContent:'space-between',alignItems:'center'}}>
            <div>
              <div style={{fontFamily:"'Syne',sans-serif",fontWeight:800,fontSize:20,color:REC_COLOR[data.rec.type]||'#64748b'}}>{data.rec.type}</div>
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
          {data.rec.lowQ&&<div style={{marginTop:6,fontSize:11,color:'#fb923c'}}>⚠ Far-OTM — low probability</div>}
          {data.dte<=2&&!['No Trade','Wait'].includes(data.rec.type)&&<div style={{marginTop:6,fontSize:11,color:'#fb923c'}}>⚠ {data.dte}d to expiry — steep theta</div>}
        </div>

        {/* OI Change */}
        {data.analysis.bld?.bull>0&&(
          <div style={{margin:'10px 12px 0',padding:14,background:'#0d1117',borderRadius:12,border:'1px solid #1e2a3a'}}>
            <div style={{fontSize:10,color:'#475569',marginBottom:8}}>OI CHANGE (TODAY vs YESTERDAY)</div>
            <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:8}}>
              <div style={{background:'#052e16',borderRadius:8,padding:10,textAlign:'center'}}>
                <div style={{fontSize:10,color:'#4ade80'}}>PUT SUPPORT</div>
                <div style={{fontSize:16,fontWeight:700,color:'#22c55e',marginTop:2}}>{fmtOI(data.analysis.bld.bull)}</div>
              </div>
              <div style={{background:'#2d0a0a',borderRadius:8,padding:10,textAlign:'center'}}>
                <div style={{fontSize:10,color:'#f87171'}}>CALL RESIST</div>
                <div style={{fontSize:16,fontWeight:700,color:'#ef4444',marginTop:2}}>{fmtOI(data.analysis.bld.bear)}</div>
              </div>
            </div>
            <div style={{marginTop:8,fontSize:11,color:'#334155',display:'flex',justifyContent:'space-between'}}>
              <span>Total CE chg: {fmtOI(data.analysis.bld.totalCe)}</span>
              <span>Total PE chg: {fmtOI(data.analysis.bld.totalPe)}</span>
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
