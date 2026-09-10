"use client";
import {useState,useEffect,useRef} from "react";
import {useRouter} from "next/navigation";
import {createClient} from "@/lib/supabase/client";
import JsBarcode from "jsbarcode";
import {jsPDF} from "jspdf";

const SHARED_KEY="eps-inventory-data-v1";
const NAVY="#1A3C5E",ACCENT="#2D6A9F";
const CAP_WT=0.56,ASM_WT=0.96,PCS_INJ=64,BAG_KG=25,PLASTIC_BAG_KG=25,WASTE_PER_INJ=28,DEFAULT_SCRAP_RATE_EGP=160;
const ALCAP_WT_KG=0.405,COIL_KG_TO_CAPS=1972.4;
// Starting labor rates, worked back from real figures — all editable in Finance since actual
// pay varies: Sorting 10 girls x 300 EGP/day, 200,000 pcs sorted/day; Injection 27,000 EGP/26
// days over 2 x 12h shifts/day; Press 12,000 EGP/16 shifts/month, 1 shift = 240,000 pcs.
// usdToEgpFallbackRate converts aluminum coil cost to EGP when the coil itself has no rate
// recorded from when it was actually bought — real purchase-time rates (set on the coil lot)
// are always preferred over this fallback.
// Press (stamps aluminum coil into aluminum caps) and Assembly (combines sorted plastic +
// aluminum caps into a finished cap) are two different machines/people, paid differently —
// Press: 12,000 EGP/month salary, ~18 visits/month, 240,000 pcs/visit; Assembly: 500 EGP paid
// per visit, ~160,000 pcs/visit. Keeping the "pressCostPerPc" key for its real meaning (Press)
// and adding assemblyCostPerPc for what used to be lumped in under that same name.
// assemblyCostPerPc is now only a fallback for shifts saved before Assembly workers were
// tracked (assemblyWorkers undefined) — a shift that DOES use the picker but has nobody
// selected (a sorting girl covered it for free, unrecorded) instead uses the flat
// assemblyDefaultShiftEGP, and a shift with real workers picked uses their actual wages.
const DEFAULT_LABOR_RATES={sortingCostPerPc:0.015,injectionCostPerShift:519.23,pressCostPerPc:12000/(18*240000),assemblyCostPerPc:500/160000,assemblyDefaultShiftEGP:500,silicaLaborCostPerShift:461,usdToEgpFallbackRate:50};
const ALU_DEN=2700/1e9;
const COMPANY_NAME="EAST PHARMACEUTICAL SERVICES";
const COMPANY_CERT="GMP & ISO 9001:2015 CERTIFIED";
const COMPANY_PHONE="+20 100 208 9590 | +20 111 005 5538 | Factory: 02 3833 6566";
const COMPANY_EMAIL="neweastpharma@gmail.com | www.eastpharmaceutical.com";
const COMPANY_ADDRESS="Plot 602, Industrial Zone, 6th of October City, Giza, Egypt";

// ══ EMPLOYEES ═══════════════════════════════════════════════════════════
// Real staff roster, used to replace free-text "Operator" fields with a picker that carries a
// real wage — so labor cost on a shift can be the actual amount paid instead of only ever the
// flat DEFAULT_LABOR_RATES estimate. "monthly" people (paid a fixed salary regardless of exactly
// which days they work) get their effective cost for one day computed as salary ÷
// assumedDaysPerMonth — a standard day count (26, the usual Egyptian payroll convention),
// editable per employee, not however many days they actually happened to be logged this month
// (that self-adjusting version was tried and dropped: it suggested an entire month's salary as
// the cost of a single shift the first time someone was logged each month). "perShift" people
// (daily/casual workers) just use their stored rate directly.
const EMPLOYEE_STATIONS=["Injection","Assembly","Plastic Sorting","Final Sorting","Silica","Press"];
const INITIAL_EMPLOYEES=[
  {id:"emp-ziad",name:"Ziad Menshawy",stations:["Injection"],payType:"monthly",rate:15000,assumedDaysPerMonth:26,active:true,notes:"12h, 6 days/week"},
  {id:"emp-mohamed",name:"Mohamed Mousa",stations:["Injection","Silica","Assembly"],payType:"monthly",rate:12000,assumedDaysPerMonth:26,active:true,notes:"12h, 6 days/week — moves to Silica when it's running, sometimes Assembly"},
  {id:"emp-ashraf",name:"Ashraf",stations:["Press"],payType:"monthly",rate:12000,assumedDaysPerMonth:17,active:true,notes:"8h, 4 days/week"},
  {id:"emp-nagy",name:"Nagy",stations:["Assembly"],payType:"perShift",rate:500,active:true,notes:"Occasional fill-in"},
  {id:"emp-somia",name:"Somia",stations:["Plastic Sorting","Final Sorting"],payType:"perShift",rate:350,active:true,notes:"Supervises — 300 base + 50"},
  {id:"emp-rahma",name:"Rahma",stations:["Plastic Sorting","Final Sorting"],payType:"perShift",rate:300,active:true,notes:""},
  {id:"emp-mena",name:"Mena",stations:["Plastic Sorting","Final Sorting"],payType:"perShift",rate:300,active:true,notes:""},
  {id:"emp-habiba",name:"Habiba",stations:["Plastic Sorting","Final Sorting"],payType:"perShift",rate:300,active:true,notes:""},
  {id:"emp-yasmine",name:"Yasmine",stations:["Plastic Sorting","Final Sorting"],payType:"perShift",rate:300,active:true,notes:""},
  {id:"emp-omrahma",name:"Om Rahma",stations:["Plastic Sorting","Final Sorting"],payType:"perShift",rate:300,active:true,notes:""},
];
// The default wage suggested when an employee is first added to a shift/lot — a starting point,
// always editable, and once saved the number stored on that shift/lot is what's actually used
// everywhere else (never silently recalculated later, so adding more shifts this month doesn't
// retroactively change what an earlier shift shows it paid).
function effectiveDailyRate(emp){
  if(!emp)return 0;
  if(emp.payType!=="monthly")return Number(emp.rate)||0;
  const days=Number(emp.assumedDaysPerMonth)||26;
  return (Number(emp.rate)||0)/days;
}
// Aggregates each sorter's total accepted/rejected pcs and shift count across every batch —
// "field" is plasticSorters or finalSorters — feeding the productivity comparison charts so the
// user can see "who is good, who we should keep extra" for Plastic Sorting and Final Sorting.
function sorterStats(field,batches){
  const map={};
  (batches||[]).forEach(b=>{
    if(!b.isSubBatch)return;
    (b[field]||[]).forEach(s=>{
      if(!s.employeeId)return;
      if(!map[s.employeeId])map[s.employeeId]={employeeId:s.employeeId,name:s.name,acceptedPcs:0,rejectedPcs:0,wagePaid:0,shifts:0};
      map[s.employeeId].acceptedPcs+=Number(s.acceptedPcs)||0;
      map[s.employeeId].rejectedPcs+=Number(s.rejectedPcs)||0;
      map[s.employeeId].wagePaid+=Number(s.wage)||0;
      map[s.employeeId].shifts+=1;
      map[s.employeeId].name=s.name||map[s.employeeId].name;
    });
  });
  return Object.values(map).sort((a,b)=>b.acceptedPcs-a.acceptedPcs);
}
function SorterPerformanceChart({title,accent,stats}){
  const maxAcc=Math.max(1,...stats.map(s=>s.acceptedPcs));
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16,marginBottom:14}}>
    <div style={{fontWeight:800,fontSize:14,color:accent,marginBottom:12}}>{title}</div>
    {stats.length===0&&<div style={{fontSize:12,color:"#999"}}>No sorting data logged yet — record who sorted on a shift to see comparisons here.</div>}
    {stats.map(s=>{
      const total=s.acceptedPcs+s.rejectedPcs;
      const rejRate=total>0?(s.rejectedPcs/total*100):0;
      const pct=Math.round(s.acceptedPcs/maxAcc*100);
      return(<div key={s.employeeId} style={{marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",fontSize:12,marginBottom:4,gap:8}}>
          <span style={{fontWeight:700,color:"#333"}}>{s.name}</span>
          <span style={{color:"#888",whiteSpace:"nowrap"}}>{fmtN(s.acceptedPcs)} pcs · {s.shifts} shift{s.shifts!==1?"s":""}{total>0?" · "+rejRate.toFixed(1)+"% rejected":""}</span></div>
        <div style={{height:10,background:"#F0F0F0",borderRadius:6,overflow:"hidden"}}>
          <div style={{height:"100%",width:pct+"%",background:rejRate>10?"#E6A817":accent,borderRadius:6}}/></div></div>);
    })}
  </div>);
}
// Aggregates each Injection worker's totals across every shift they're logged on — injection
// count, actual pcs produced (weighed output before sorting, not the theoretical figure),
// plastic used, and pcs later rejected at Plastic Sorting. Injection output is a shared machine
// total, not split per person like Sorting, so when more than one worker is on a shift, each of
// them is credited with that shift's full numbers (the normal case is one operator per shift).
function injectionWorkerStats(batches){
  const map={};
  (batches||[]).forEach(b=>{
    if(!b.isSubBatch)return;
    (b.injectionWorkers||[]).forEach(w=>{
      if(!w.employeeId)return;
      if(!map[w.employeeId])map[w.employeeId]={employeeId:w.employeeId,name:w.name,shifts:0,injections:0,producedPcs:0,plasticKg:0,rejectedPcs:0};
      const capWt=b.capWt||CAP_WT;
      const s=map[w.employeeId];
      s.shifts+=1;
      s.injections+=Number(b.injections)||0;
      s.producedPcs+=kgToPcs(Number(b.weightBeforeSorting)||0,capWt);
      s.plasticKg+=Number(b.totalPlasticKg||b.virginKg)||0;
      s.rejectedPcs+=Number(b.rejectedPcs)||0;
      s.name=w.name||s.name;
    });
  });
  return Object.values(map).sort((a,b)=>b.producedPcs-a.producedPcs);
}
function InjectionPerformanceChart({stats}){
  const maxProduced=Math.max(1,...stats.map(s=>s.producedPcs));
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16,marginBottom:14}}>
    <div style={{fontWeight:800,fontSize:14,color:"#856404",marginBottom:12}}>💉 Injection</div>
    {stats.length===0&&<div style={{fontSize:12,color:"#999"}}>No injection shifts logged with a worker picked yet.</div>}
    {stats.map(s=>{
      const rejRate=s.producedPcs>0?(s.rejectedPcs/s.producedPcs*100):0;
      const pct=Math.round(s.producedPcs/maxProduced*100);
      return(<div key={s.employeeId} style={{marginBottom:14}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"baseline",fontSize:12,marginBottom:4,gap:8}}>
          <span style={{fontWeight:700,color:"#333"}}>{s.name}</span>
          <span style={{color:"#888",whiteSpace:"nowrap"}}>{s.shifts} shift{s.shifts!==1?"s":""} · {fmtN(s.injections)} injections</span></div>
        <div style={{height:10,background:"#F0F0F0",borderRadius:6,overflow:"hidden",marginBottom:8}}>
          <div style={{height:"100%",width:pct+"%",background:rejRate>10?"#E6A817":"#856404",borderRadius:6}}/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:11,color:"#666"}}>
          <div>Produced<div style={{fontWeight:700,fontSize:13,color:"#333"}}>{fmtN(s.producedPcs)} pcs</div></div>
          <div>Plastic used<div style={{fontWeight:700,fontSize:13,color:"#333"}}>{fmtN(s.plasticKg)} KG</div></div>
          <div>Rejected<div style={{fontWeight:700,fontSize:13,color:rejRate>10?"#DC3545":"#1A6B2A"}}>{fmtN(s.rejectedPcs)} pcs{s.producedPcs>0?" ("+rejRate.toFixed(1)+"%)":""}</div></div>
        </div></div>);
    })}
  </div>);
}
// Multi-select employee + wage picker — used on Injection/Assembly/Silica shifts, where output
// is shared (not split per person) but each worker still has their own real wage for that shift.
// "station" is usually one station name, but Assembly passes an array — a sorting girl covering
// assembly (double duty) isn't an "Assembly" employee by station, so the candidate filter needs
// to accept any of several stations rather than just one exact match.
function WorkerPicker({employees,station,value,onChange}){
  const list=value||[];
  const stationList=station==null?null:Array.isArray(station)?station:[station];
  const candidates=(employees||[]).filter(e=>e.active!==false&&(!stationList||stationList.some(st=>(e.stations||[]).indexOf(st)>=0))&&list.every(v=>v.employeeId!==e.id));
  const add=id=>{
    const emp=(employees||[]).filter(e=>e.id===id)[0];
    if(!emp)return;
    const wage=Math.round(effectiveDailyRate(emp)*100)/100;
    onChange(list.concat([{employeeId:emp.id,name:emp.name,wage:wage}]));
  };
  const remove=id=>onChange(list.filter(v=>v.employeeId!==id));
  const setWage=(id,w)=>onChange(list.map(v=>v.employeeId===id?Object.assign({},v,{wage:Number(w)||0}):v));
  const total=list.reduce((s,v)=>s+(Number(v.wage)||0),0);
  return(<div>
    {list.map(v=>(<div key={v.employeeId} style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
      <div style={{flex:1,fontSize:13,fontWeight:600,color:"#333"}}>{v.name}</div>
      <input type="number" value={v.wage} onChange={e=>setWage(v.employeeId,e.target.value)} style={{width:100,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"7px 10px",fontSize:13,boxSizing:"border-box"}}/>
      <span style={{fontSize:11,color:"#888"}}>EGP</span>
      <button type="button" onClick={()=>remove(v.employeeId)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button></div>))}
    {candidates.length>0&&<select value="" onChange={e=>{if(e.target.value)add(e.target.value);}} style={{width:"100%",border:"1.5px dashed #CBD5E0",borderRadius:8,padding:"8px 10px",fontSize:13,background:"#fff",color:"#555"}}>
      <option value="">+ Add worker…</option>
      {candidates.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select>}
    {list.length===0&&candidates.length===0&&<div style={{fontSize:12,color:"#999"}}>No employees set up for this station yet — add them under Employees.</div>}
    {list.length>0&&<div style={{marginTop:6,fontSize:12,color:"#666"}}>Labor: <strong>{fmtN(total)} EGP</strong></div>}
  </div>);
}
// Sorting-specific picker — each sorter also gets her own accepted/rejected pcs, since sorting
// output is naturally per-person (each sorter handles her own tray), unlike the shared-output
// stages above. Feeds both the labor cost and the sorter productivity charts.
function SorterPicker({employees,station,value,onChange}){
  const list=value||[];
  const candidates=(employees||[]).filter(e=>e.active!==false&&(!station||(e.stations||[]).indexOf(station)>=0)&&list.every(v=>v.employeeId!==e.id));
  const add=id=>{
    const emp=(employees||[]).filter(e=>e.id===id)[0];
    if(!emp)return;
    const wage=Math.round(effectiveDailyRate(emp)*100)/100;
    onChange(list.concat([{employeeId:emp.id,name:emp.name,wage:wage,acceptedPcs:0,rejectedPcs:0}]));
  };
  const remove=id=>onChange(list.filter(v=>v.employeeId!==id));
  const setField=(id,field,v)=>onChange(list.map(x=>x.employeeId===id?Object.assign({},x,{[field]:field==="acceptedPcs"||field==="rejectedPcs"?Number(v)||0:(Number(v)||0)}):x));
  const total=list.reduce((s,v)=>s+(Number(v.wage)||0),0);
  const totalAcc=list.reduce((s,v)=>s+(Number(v.acceptedPcs)||0),0),totalRej=list.reduce((s,v)=>s+(Number(v.rejectedPcs)||0),0);
  return(<div>
    {list.map(v=>(<div key={v.employeeId} style={{background:"#fff",border:"1px solid #E2E8F0",borderRadius:8,padding:10,marginBottom:8}}>
      <div style={{display:"flex",gap:8,alignItems:"center",marginBottom:8}}>
        <div style={{flex:1,fontSize:13,fontWeight:700,color:"#333"}}>{v.name}</div>
        <button type="button" onClick={()=>remove(v.employeeId)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8}}>
        <div><label style={{display:"block",fontSize:10,fontWeight:700,color:"#888",marginBottom:3,textTransform:"uppercase"}}>Wage (EGP)</label>
          <input type="number" value={v.wage} onChange={e=>setField(v.employeeId,"wage",e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:6,padding:"6px 8px",fontSize:13,boxSizing:"border-box"}}/></div>
        <div><label style={{display:"block",fontSize:10,fontWeight:700,color:"#888",marginBottom:3,textTransform:"uppercase"}}>Accepted (pcs)</label>
          <input type="number" value={v.acceptedPcs} onChange={e=>setField(v.employeeId,"acceptedPcs",e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:6,padding:"6px 8px",fontSize:13,boxSizing:"border-box"}}/></div>
        <div><label style={{display:"block",fontSize:10,fontWeight:700,color:"#888",marginBottom:3,textTransform:"uppercase"}}>Rejected (pcs)</label>
          <input type="number" value={v.rejectedPcs} onChange={e=>setField(v.employeeId,"rejectedPcs",e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:6,padding:"6px 8px",fontSize:13,boxSizing:"border-box"}}/></div>
      </div></div>))}
    {candidates.length>0&&<select value="" onChange={e=>{if(e.target.value)add(e.target.value);}} style={{width:"100%",border:"1.5px dashed #CBD5E0",borderRadius:8,padding:"8px 10px",fontSize:13,background:"#fff",color:"#555"}}>
      <option value="">+ Add sorter…</option>
      {candidates.map(e=><option key={e.id} value={e.id}>{e.name}</option>)}</select>}
    {list.length===0&&candidates.length===0&&<div style={{fontSize:12,color:"#999"}}>No employees set up for this station yet — add them under Employees.</div>}
    {list.length>0&&<div style={{marginTop:6,fontSize:12,color:"#666"}}>Labor: <strong>{fmtN(total)} EGP</strong> · Attributed: <strong>{fmtN(totalAcc)} accepted</strong>{totalRej>0?", "+fmtN(totalRej)+" rejected":""}</div>}
  </div>);
}
function EmployeeStationPicker({stations,onToggle}){
  return(<div style={{display:"flex",flexWrap:"wrap",gap:6}}>
    {EMPLOYEE_STATIONS.map(s=><button type="button" key={s} onClick={()=>onToggle(s)} style={{padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer",border:"1.5px solid "+(stations.indexOf(s)>=0?NAVY:"#E2E8F0"),background:stations.indexOf(s)>=0?NAVY:"#fff",color:stations.indexOf(s)>=0?"#fff":"#666"}}>{s}</button>)}
  </div>);
}
function NewEmployeeForm({onSave,onCancel}){
  const [name,setName]=useState(""),[stations,setStations]=useState([]),[payType,setPayType]=useState("perShift"),[rate,setRate]=useState(""),[assumedDaysPerMonth,setAssumedDaysPerMonth]=useState("26"),[notes,setNotes]=useState(""),[err,setErr]=useState("");
  const toggleStation=s=>setStations(stations.indexOf(s)>=0?stations.filter(x=>x!==s):stations.concat([s]));
  const save=()=>{
    if(!name.trim()){setErr("Enter a name.");return;}
    if(stations.length===0){setErr("Pick at least one station.");return;}
    onSave({id:genId(),name:name.trim(),stations:stations,payType:payType,rate:Number(rate)||0,assumedDaysPerMonth:Number(assumedDaysPerMonth)||26,active:true,notes:notes.trim()});
  };
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid "+NAVY,padding:14,marginBottom:14}}>
    <div style={{marginBottom:10}}><Field label="Name" value={name} onChange={v=>{setName(v);setErr("");}} ph="e.g. Mohamed Mousa"/></div>
    <div style={{marginBottom:10}}>
      <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Stations</label>
      <EmployeeStationPicker stations={stations} onToggle={s=>{toggleStation(s);setErr("");}}/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Pay Type</label>
        <select value={payType} onChange={e=>setPayType(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
          <option value="perShift">Per Shift/Day</option><option value="monthly">Monthly Salary</option></select></div>
      <Field label={payType==="monthly"?"Monthly Rate (EGP)":"Rate per Shift (EGP)"} value={rate} onChange={setRate} type="number" ph="e.g. 300"/></div>
    {payType==="monthly"&&<div style={{marginBottom:10}}><Field label="Assumed Days/Month (for daily cost)" value={assumedDaysPerMonth} onChange={setAssumedDaysPerMonth} type="number" ph="26"/></div>}
    <div style={{marginBottom:14}}><Field label="Notes (optional)" value={notes} onChange={setNotes}/></div>
    {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
    <div style={{display:"flex",gap:8}}>
      <button type="button" onClick={save} style={{flex:1,padding:11,background:NAVY,color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:13}}>💾 Add</button>
      <button type="button" onClick={onCancel} style={{padding:"11px 16px",border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:13}}>Cancel</button></div>
  </div>);
}
function EmployeeRow({emp,onSave,onDelete}){
  const [editing,setEditing]=useState(false),[confDel,setConfDel]=useState(false);
  const [name,setName]=useState(emp.name),[stations,setStations]=useState(emp.stations||[]);
  const [payType,setPayType]=useState(emp.payType),[rate,setRate]=useState(String(emp.rate));
  const [assumedDaysPerMonth,setAssumedDaysPerMonth]=useState(String(emp.assumedDaysPerMonth||26));
  const [notes,setNotes]=useState(emp.notes||""),[active,setActive]=useState(emp.active!==false);
  const toggleStation=s=>setStations(stations.indexOf(s)>=0?stations.filter(x=>x!==s):stations.concat([s]));
  const save=()=>{onSave(Object.assign({},emp,{name:name.trim()||emp.name,stations:stations,payType:payType,rate:Number(rate)||0,assumedDaysPerMonth:Number(assumedDaysPerMonth)||26,notes:notes,active:active}));setEditing(false);};
  if(!editing)return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:8,opacity:active?1:0.5}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{fontWeight:700,fontSize:14}}>{emp.name}{!active?" (inactive)":""}</div>
        <div style={{fontSize:12,color:"#888",marginTop:2}}>{(emp.stations||[]).join(", ")||"—"}</div>
        <div style={{fontSize:13,color:NAVY,fontWeight:700,marginTop:4}}>{fmtN(emp.rate)} EGP {emp.payType==="monthly"?"/ month":"/ shift"}</div>
        {emp.payType==="monthly"&&<div style={{fontSize:11,color:"#888",marginTop:2}}>≈ {fmtN(Math.round(effectiveDailyRate(emp)))} EGP/day ÷ {emp.assumedDaysPerMonth||26} days</div>}
        {emp.notes&&<div style={{fontSize:11,color:"#999",marginTop:2}}>{emp.notes}</div>}</div>
      <button type="button" onClick={()=>setEditing(true)} style={{background:"#F5F7FA",border:"none",borderRadius:7,padding:"6px 12px",cursor:"pointer",fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}>✏️ Edit</button></div></div>);
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid "+NAVY,padding:14,marginBottom:8}}>
    <div style={{marginBottom:10}}><Field label="Name" value={name} onChange={setName}/></div>
    <div style={{marginBottom:10}}>
      <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Stations</label>
      <EmployeeStationPicker stations={stations} onToggle={toggleStation}/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Pay Type</label>
        <select value={payType} onChange={e=>setPayType(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
          <option value="monthly">Monthly Salary</option><option value="perShift">Per Shift/Day</option></select></div>
      <Field label={payType==="monthly"?"Monthly Rate (EGP)":"Rate per Shift (EGP)"} value={rate} onChange={setRate} type="number"/></div>
    {payType==="monthly"&&<div style={{marginBottom:10}}><Field label="Assumed Days/Month (for daily cost)" value={assumedDaysPerMonth} onChange={setAssumedDaysPerMonth} type="number" ph="26"/></div>}
    <div style={{marginBottom:10}}><Field label="Notes" value={notes} onChange={setNotes}/></div>
    <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#555",cursor:"pointer",marginBottom:14}}>
      <input type="checkbox" checked={active} onChange={e=>setActive(e.target.checked)} style={{width:16,height:16}}/> Active</label>
    <div style={{display:"flex",gap:8,marginBottom:10}}>
      <button type="button" onClick={save} style={{flex:1,padding:11,background:NAVY,color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:13}}>💾 Save</button>
      <button type="button" onClick={()=>setEditing(false)} style={{padding:"11px 16px",border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    {confDel?(<div style={{display:"flex",gap:8}}>
      <button type="button" onClick={()=>{onDelete();setConfDel(false);}} style={{padding:"8px 14px",background:"#DC3545",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>Yes, delete</button>
      <button type="button" onClick={()=>setConfDel(false)} style={{padding:"8px 14px",border:"1.5px solid #E2E8F0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:12}}>Cancel</button></div>)
    :(<button type="button" onClick={()=>setConfDel(true)} style={{padding:"8px 14px",border:"1.5px solid #F1948A",color:"#DC3545",background:"#FFF0F0",borderRadius:6,cursor:"pointer",fontSize:12}}>Delete employee</button>)}
  </div>);
}
function EmployeesSection({employees,batches,onSave,onDelete,onClose}){
  const [showAdd,setShowAdd]=useState(false);
  const [tab,setTab]=useState("roster");
  const sorted=employees.slice().sort((a,b)=>(b.active!==false?1:0)-(a.active!==false?1:0)||a.name.localeCompare(b.name));
  const plasticStats=tab==="performance"?sorterStats("plasticSorters",batches):[];
  const finalStats=tab==="performance"?sorterStats("finalSorters",batches):[];
  const injectionStats=tab==="performance"?injectionWorkerStats(batches):[];
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0D1F3C,"+NAVY+")",position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:17}}>👷 Employees</div>
          <div style={{color:"rgba(255,255,255,0.5)",fontSize:11}}>Staff roster, stations & wages</div></div></div>
      <div style={{maxWidth:700,margin:"0 auto",display:"flex"}}>
        {[["roster","Roster"],["performance","📊 Sorting Performance"]].map(x=>(
          <button type="button" key={x[0]} onClick={()=>setTab(x[0])}
            style={{flex:1,background:"none",border:"none",color:tab===x[0]?"#fff":"rgba(255,255,255,0.45)",padding:"11px 8px",fontSize:12,fontWeight:tab===x[0]?700:400,cursor:"pointer",borderBottom:"2px solid "+(tab===x[0]?ACCENT:"transparent"),fontFamily:"inherit"}}>{x[1]}</button>))}
      </div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16}}>
      {tab==="roster"&&<>
        {!showAdd&&<button type="button" onClick={()=>setShowAdd(true)} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:14,cursor:"pointer",marginBottom:14}}>+ Add Employee</button>}
        {showAdd&&<NewEmployeeForm onSave={emp=>{onSave(emp);setShowAdd(false);}} onCancel={()=>setShowAdd(false)}/>}
        {sorted.map(e=><EmployeeRow key={e.id} emp={e} onSave={onSave} onDelete={()=>onDelete(e.id)}/>)}
        {employees.length===0&&<div style={{textAlign:"center",padding:30,color:"#888",fontSize:13}}>No employees yet — add your first one above.</div>}
      </>}
      {tab==="performance"&&<>
        <div style={{fontSize:12,color:"#888",marginBottom:14}}>Totals per worker, across every shift logged with them picked. Use this to see who&apos;s most productive and who to keep on extra.</div>
        <InjectionPerformanceChart stats={injectionStats}/>
        <SorterPerformanceChart title="🔍 Plastic Sorting" accent="#0C5460" stats={plasticStats}/>
        <SorterPerformanceChart title="📦 Final Sorting" accent="#B8860B" stats={finalStats}/>
      </>}
    </div></div>);
}

// ══ CASH LEDGER ═══════════════════════════════════════════════════════════
// A second, separate money-tracking system from the estimate-based Finance tab. Finance builds
// cost estimates from batch/order data (what things SHOULD cost); this ledger only records real
// cash that has actually moved, logged as it's paid or received, so its running balance is always
// the true amount on hand — never an estimate. Money owed but not yet paid/received is
// deliberately NOT entered here until it actually moves, so a pending customer payment can never
// inflate the balance. "Owner Capital" is its own income category, separate from "Customer
// Payment", since the starting balance is mostly money the owner put in, not revenue collected.
// "Owner Draw" (money the owner takes out personally) is likewise its own expense category,
// separate from real business expenses — both exist so Profit & Loss can exclude owner
// capital/draws from income/expenses (they're equity movements, not business performance).
const CASH_CATEGORIES_IN=["Customer Payment","Owner Capital","Asset Sale","Other Income"];
const CASH_CATEGORIES_OUT=["Material Purchase","Wages","Maintenance","Utilities","Rent","Transport","Owner Draw","Other Expense"];
function cashRunningBalance(opening,ledger){
  const start=opening?Number(opening.balance)||0:0;
  return (ledger||[]).reduce((s,e)=>s+(e.type==="in"?Number(e.amount)||0:-(Number(e.amount)||0)),start);
}
function cashMonthlySummary(ledger){
  const map={};
  (ledger||[]).forEach(e=>{
    const mk=e.date?String(e.date).slice(0,7):"—";
    if(!map[mk])map[mk]={month:mk,in:0,out:0};
    if(e.type==="in")map[mk].in+=Number(e.amount)||0;else map[mk].out+=Number(e.amount)||0;
  });
  return Object.values(map).sort((a,b)=>b.month.localeCompare(a.month));
}
// Profit & Loss excludes equity movements (Owner Capital coming in, Owner Draw going out) from
// income/expenses — those are money moving between the owner and the business, not revenue
// earned or cost incurred, so counting them as profit/loss would misstate performance.
function cashPnL(entries){
  const incomeByCat={},expenseByCat={};
  let totalIncome=0,totalExpense=0,ownerCapital=0,ownerDraws=0;
  (entries||[]).forEach(e=>{
    const amt=Number(e.amount)||0;
    if(e.type==="in"){
      if(e.category==="Owner Capital"){ownerCapital+=amt;return;}
      incomeByCat[e.category]=(incomeByCat[e.category]||0)+amt;totalIncome+=amt;
    }else{
      if(e.category==="Owner Draw"){ownerDraws+=amt;return;}
      expenseByCat[e.category]=(expenseByCat[e.category]||0)+amt;totalExpense+=amt;
    }
  });
  return {incomeByCat:incomeByCat,expenseByCat:expenseByCat,totalIncome:totalIncome,totalExpense:totalExpense,
    netProfit:totalIncome-totalExpense,ownerCapital:ownerCapital,ownerDraws:ownerDraws};
}
// Net profit per month (income/expense only, same exclusions as cashPnL) — feeds the P&L trend
// chart so the owner can see which months were actually profitable, not just cash-positive.
function cashMonthlyNetProfit(ledger){
  const map={};
  (ledger||[]).forEach(e=>{
    if(e.category==="Owner Capital"||e.category==="Owner Draw")return;
    const mk=e.date?String(e.date).slice(0,7):"—";
    if(!map[mk])map[mk]=0;
    map[mk]+=(e.type==="in"?1:-1)*(Number(e.amount)||0);
  });
  return Object.keys(map).sort().map(mk=>({month:mk,net:map[mk]}));
}
// Inventory value for the Balance Sheet — same USD→EGP conversion convention used everywhere
// else in Finance: a lot's own purchase-time rate when set, otherwise the Finance fallback rate;
// a USD lot with neither is excluded rather than guessed at.
function inventoryValueEGP(data,laborRates){
  const fallbackRate=Number(laborRates&&laborRates.usdToEgpFallbackRate)||0;
  let total=0;
  Object.keys(data||{}).forEach(matKey=>{
    ((data[matKey]&&data[matKey].lots)||[]).forEach(l=>{
      const qty=Number(l.qtyRemaining)||0,cost=Number(l.unitCost)||0;
      if(qty<=0||cost<=0)return;
      const cur=l.unitCostCurrency||"EGP";
      let lineEGP=qty*cost;
      if(cur!=="EGP"){
        if(l.usdToEgpRate)lineEGP*=Number(l.usdToEgpRate);
        else if(fallbackRate>0)lineEGP*=fallbackRate;
        else return;
      }
      total+=lineEGP;
    });
  });
  return total;
}
// A cash-basis snapshot, not a fully reconciled accrual balance sheet — Material Purchases are
// expensed the moment they're paid (matching how the ledger is logged), while the material
// itself keeps counting as an Inventory asset until it's used up, so Assets will generally run
// ahead of Equity by roughly the value of inventory still on hand. That gap is real, not a bug —
// see the note rendered alongside this in BalanceSheetView.
function cashBalanceSheet(opening,ledger,data,laborRates){
  const cash=cashRunningBalance(opening,ledger);
  const inventory=inventoryValueEGP(data,laborRates);
  const pnl=cashPnL(ledger);
  const openingBalance=opening?Number(opening.balance)||0:0;
  const equity=openingBalance+pnl.ownerCapital-pnl.ownerDraws+pnl.netProfit;
  return {cash:cash,inventory:inventory,totalAssets:cash+inventory,
    openingBalance:openingBalance,ownerCapital:pnl.ownerCapital,ownerDraws:pnl.ownerDraws,retainedEarnings:pnl.netProfit,
    totalEquity:equity,unreconciled:(cash+inventory)-equity};
}
function cashPeriodFilter(ledger,period){
  const now=new Date();
  const thisMonth=now.toISOString().slice(0,7),thisYear=String(now.getFullYear());
  if(period==="month")return (ledger||[]).filter(e=>e.date&&e.date.slice(0,7)===thisMonth);
  if(period==="year")return (ledger||[]).filter(e=>e.date&&e.date.slice(0,4)===thisYear);
  return ledger||[];
}
function PnLView({cashLedger}){
  const [period,setPeriod]=useState("month");
  const entries=cashPeriodFilter(cashLedger,period);
  const pnl=cashPnL(entries);
  const monthly=cashMonthlyNetProfit(cashLedger).slice(-12);
  const maxAbs=Math.max(1,...monthly.map(m=>Math.abs(m.net)));
  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      {[["month","This Month"],["year","This Year"],["all","All Time"]].map(x=>(
        <button type="button" key={x[0]} onClick={()=>setPeriod(x[0])}
          style={{flex:1,padding:9,borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",border:"1.5px solid "+(period===x[0]?NAVY:"#E2E8F0"),background:period===x[0]?NAVY:"#fff",color:period===x[0]?"#fff":"#666"}}>{x[1]}</button>))}
    </div>
    <div style={{background:"#fff",borderRadius:14,border:"1.5px solid #EEF2F7",padding:18,marginBottom:14,textAlign:"center"}}>
      <div style={{fontSize:11,fontWeight:700,color:"#888",textTransform:"uppercase"}}>Net Profit / Loss</div>
      <div style={{fontSize:30,fontWeight:900,color:pnl.netProfit>=0?"#1A6B2A":"#DC3545",marginTop:4}}>{fmtN(pnl.netProfit)} EGP</div>
      <div style={{fontSize:11,color:"#999",marginTop:6}}>Income {fmtN(pnl.totalIncome)} − Expenses {fmtN(pnl.totalExpense)}</div></div>
    <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:13,color:"#1A6B2A",marginBottom:10}}>🟢 Income (excl. Owner Capital)</div>
      {Object.keys(pnl.incomeByCat).length===0&&<div style={{fontSize:12,color:"#999"}}>None this period.</div>}
      {Object.keys(pnl.incomeByCat).map(c=>(<div key={c} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"5px 0",borderBottom:"1px solid #F5F5F5"}}>
        <span>{c}</span><strong>{fmtN(pnl.incomeByCat[c])}</strong></div>))}
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:800,marginTop:8,paddingTop:8,borderTop:"1.5px solid #E2E8F0"}}>
        <span>Total Income</span><span style={{color:"#1A6B2A"}}>{fmtN(pnl.totalIncome)}</span></div></div>
    <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:13,color:"#DC3545",marginBottom:10}}>🔴 Expenses (excl. Owner Draw)</div>
      {Object.keys(pnl.expenseByCat).length===0&&<div style={{fontSize:12,color:"#999"}}>None this period.</div>}
      {Object.keys(pnl.expenseByCat).map(c=>(<div key={c} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"5px 0",borderBottom:"1px solid #F5F5F5"}}>
        <span>{c}</span><strong>{fmtN(pnl.expenseByCat[c])}</strong></div>))}
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,fontWeight:800,marginTop:8,paddingTop:8,borderTop:"1.5px solid #E2E8F0"}}>
        <span>Total Expenses</span><span style={{color:"#DC3545"}}>{fmtN(pnl.totalExpense)}</span></div></div>
    {(pnl.ownerCapital>0||pnl.ownerDraws>0)&&<div style={{background:"#FFF9E6",borderRadius:12,border:"1px solid #E6A817",padding:14,marginBottom:14,fontSize:12,color:"#856404"}}>
      <div style={{fontWeight:700,marginBottom:6}}>Not counted as profit/loss (equity movements, this period):</div>
      {pnl.ownerCapital>0&&<div>Owner Capital in: <strong>{fmtN(pnl.ownerCapital)} EGP</strong></div>}
      {pnl.ownerDraws>0&&<div>Owner Draws out: <strong>{fmtN(pnl.ownerDraws)} EGP</strong></div>}</div>}
    <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14}}>
      <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:12}}>📈 Monthly Net Profit Trend</div>
      {monthly.length===0&&<div style={{fontSize:12,color:"#999"}}>No entries yet.</div>}
      {monthly.map(m=>{
        const pct=Math.round(Math.abs(m.net)/maxAbs*100);
        return(<div key={m.month} style={{marginBottom:8}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,marginBottom:3}}>
            <span style={{fontWeight:700,color:"#555"}}>{m.month}</span>
            <span style={{fontWeight:700,color:m.net>=0?"#1A6B2A":"#DC3545"}}>{fmtN(m.net)}</span></div>
          <div style={{height:8,background:"#F0F0F0",borderRadius:4,overflow:"hidden"}}>
            <div style={{height:"100%",width:pct+"%",background:m.net>=0?"#1A7A45":"#DC3545",borderRadius:4}}/></div></div>);})}
    </div>
  </div>);
}
function BalanceSheetView({cashOpening,cashLedger,data,laborRates}){
  const bs=cashBalanceSheet(cashOpening,cashLedger,data,laborRates);
  return(<div>
    <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:10}}>💼 Assets</div>
      <div style={{fontSize:11,fontWeight:700,color:"#888",textTransform:"uppercase",marginBottom:6}}>Current Assets</div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}><span>Cash</span><strong>{fmtN(bs.cash)} EGP</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}><span>Inventory (raw materials, at cost)</span><strong>{fmtN(bs.inventory)} EGP</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:14,fontWeight:800,marginTop:8,paddingTop:8,borderTop:"1.5px solid #E2E8F0"}}><span>Total Assets</span><span style={{color:NAVY}}>{fmtN(bs.totalAssets)} EGP</span></div></div>
    <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:10}}>🏛️ Liabilities</div>
      <div style={{fontSize:12,color:"#999"}}>Not tracked yet — nothing owed to suppliers is logged here, so this shows as zero rather than a guessed number. Ask to add Accounts Payable tracking whenever you&apos;re ready to log it.</div></div>
    <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
      <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:10}}>👤 Owner Equity</div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}><span>Opening Balance (as of {cashOpening?cashOpening.date:"—"})</span><strong>{fmtN(bs.openingBalance)} EGP</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}><span>+ Owner Capital Contributed</span><strong>{fmtN(bs.ownerCapital)} EGP</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}><span>− Owner Draws</span><strong>{fmtN(bs.ownerDraws)} EGP</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:13,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}><span>+ Retained Earnings (all-time net profit)</span><strong style={{color:bs.retainedEarnings>=0?"#1A6B2A":"#DC3545"}}>{fmtN(bs.retainedEarnings)} EGP</strong></div>
      <div style={{display:"flex",justifyContent:"space-between",fontSize:14,fontWeight:800,marginTop:8,paddingTop:8,borderTop:"1.5px solid #E2E8F0"}}><span>Total Equity</span><span style={{color:NAVY}}>{fmtN(bs.totalEquity)} EGP</span></div></div>
    <div style={{background:"#FFF9E6",border:"1px solid #E6A817",borderRadius:12,padding:14,fontSize:12,color:"#856404"}}>
      <div style={{fontWeight:700,marginBottom:6}}>⚠️ Why Assets and Equity don&apos;t match exactly</div>
      <div>Material purchases count as an expense the moment they&apos;re paid (matching how you log the ledger), but the material itself keeps counting as Inventory until it&apos;s used up. So Assets normally run ahead of Equity by roughly the value of unconsumed inventory — right now that gap is <strong>{fmtN(bs.unreconciled)} EGP</strong>. That&apos;s not an error to fix — it&apos;s the tradeoff of a simple cash-basis ledger. A fully reconciled balance sheet would need proper accrual accounting (tracking cost of goods sold as material is actually consumed), which is a bigger step we can take later if you want it.</div></div>
  </div>);
}
function CashEntryForm({existing,onSave,onCancel}){
  const e=existing||{};
  const [date,setDate]=useState(e.date||new Date().toISOString().split("T")[0]);
  const [type,setType]=useState(e.type||"out");
  const cats=type==="in"?CASH_CATEGORIES_IN:CASH_CATEGORIES_OUT;
  const [category,setCategory]=useState(e.category||cats[0]);
  const [amount,setAmount]=useState(e.amount!=null?String(e.amount):"");
  const [note,setNote]=useState(e.note||"");
  const [err,setErr]=useState("");
  const switchType=t=>{setType(t);const nc=t==="in"?CASH_CATEGORIES_IN:CASH_CATEGORIES_OUT;setCategory(nc.indexOf(category)>=0?category:nc[0]);};
  const save=()=>{
    const amt=Number(amount)||0;
    if(amt<=0){setErr("Enter an amount.");return;}
    onSave({id:e.id||genId(),date:date,type:type,category:category,amount:amt,note:note.trim(),createdAt:e.createdAt||new Date().toISOString()});
  };
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid "+NAVY,padding:14,marginBottom:14}}>
    <div style={{display:"flex",gap:8,marginBottom:12}}>
      {[["in","🟢 Money In"],["out","🔴 Money Out"]].map(x=>(
        <button type="button" key={x[0]} onClick={()=>switchType(x[0])}
          style={{flex:1,padding:11,borderRadius:8,fontWeight:700,fontSize:13,cursor:"pointer",border:"1.5px solid "+(type===x[0]?(x[0]==="in"?"#1A7A45":"#DC3545"):"#E2E8F0"),background:type===x[0]?(x[0]==="in"?"#E8F5E9":"#FFF0F0"):"#fff",color:type===x[0]?(x[0]==="in"?"#1A7A45":"#DC3545"):"#666"}}>{x[1]}</button>))}
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date</label>
        <input type="date" value={date} onChange={ev=>setDate(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
      <Field label="Amount (EGP)" value={amount} onChange={v=>{setAmount(v);setErr("");}} type="number" ph="0.00"/></div>
    <div style={{marginBottom:10}}>
      <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Category</label>
      <select value={category} onChange={ev=>setCategory(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
        {cats.map(c=><option key={c}>{c}</option>)}</select></div>
    <div style={{marginBottom:14}}><Field label="Note (optional)" value={note} onChange={setNote} ph="e.g. Paid Ahmed for coil delivery"/></div>
    {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
    <div style={{display:"flex",gap:8}}>
      <button type="button" onClick={save} style={{flex:1,padding:11,background:NAVY,color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:13}}>💾 {existing?"Save Changes":"Add Entry"}</button>
      <button type="button" onClick={onCancel} style={{padding:"11px 16px",border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:13}}>Cancel</button></div>
  </div>);
}
function CashEntryRow({entry,onSave,onDelete}){
  const [editing,setEditing]=useState(false),[confDel,setConfDel]=useState(false);
  if(editing)return <CashEntryForm existing={entry} onSave={u=>{onSave(u);setEditing(false);}} onCancel={()=>setEditing(false)}/>;
  const isIn=entry.type==="in";
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:"12px 14px",marginBottom:8}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap"}}>
          <span style={{background:isIn?"#C6EFCE":"#FDDEDE",color:isIn?"#1A6B2A":"#8B1A1A",borderRadius:20,padding:"2px 9px",fontSize:11,fontWeight:700}}>{isIn?"🟢 In":"🔴 Out"}</span>
          <span style={{fontSize:12,fontWeight:700,color:"#333"}}>{entry.category}</span>
          <span style={{fontSize:11,color:"#999"}}>{entry.date}</span></div>
        {entry.note&&<div style={{fontSize:12,color:"#888",marginTop:4}}>{entry.note}</div>}</div>
      <div style={{textAlign:"right"}}>
        <div style={{fontWeight:800,fontSize:15,color:isIn?"#1A6B2A":"#DC3545",whiteSpace:"nowrap"}}>{isIn?"+":"-"}{fmtN(entry.amount)} EGP</div>
        <div style={{display:"flex",gap:10,marginTop:4,justifyContent:"flex-end"}}>
          <button type="button" onClick={()=>setEditing(true)} style={{background:"none",border:"none",color:NAVY,cursor:"pointer",fontSize:11,fontWeight:600,padding:0}}>Edit</button>
          {confDel?<>
            <button type="button" onClick={()=>onDelete()} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:11,fontWeight:700,padding:0}}>Confirm?</button>
            <button type="button" onClick={()=>setConfDel(false)} style={{background:"none",border:"none",color:"#888",cursor:"pointer",fontSize:11,padding:0}}>Cancel</button></>
          :<button type="button" onClick={()=>setConfDel(true)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:11,fontWeight:600,padding:0}}>Delete</button>}
        </div></div></div>
  </div>);
}
function CashOpeningSetup({opening,onSave}){
  const [editing,setEditing]=useState(!opening);
  const [date,setDate]=useState(opening?opening.date:new Date().toISOString().split("T")[0]);
  const [balance,setBalance]=useState(opening?String(opening.balance):"");
  const [err,setErr]=useState("");
  const save=()=>{
    const b=Number(balance);
    if(balance===""||isNaN(b)){setErr("Enter the actual cash balance.");return;}
    onSave({balance:b,date:date});
    setEditing(false);
  };
  if(!editing)return(<div style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:11,color:"#888",marginBottom:10}}>
    <span>Opening balance: <strong style={{color:"#555"}}>{fmtN(opening.balance)} EGP</strong> as of {opening.date}</span>
    <button type="button" onClick={()=>setEditing(true)} style={{background:"none",border:"none",color:NAVY,cursor:"pointer",fontSize:11,fontWeight:600,padding:0}}>Edit</button></div>);
  return(<div style={{background:"#FFF9E6",border:"1.5px solid #E6A817",borderRadius:12,padding:14,marginBottom:14}}>
    <div style={{fontWeight:800,fontSize:13,color:"#856404",marginBottom:4}}>💵 Set Your Starting Cash Balance</div>
    <div style={{fontSize:11,color:"#856404",opacity:0.85,marginBottom:10}}>The real amount of cash you have on hand right now — everything logged after this date adds to or subtracts from it. It&apos;s fine if most of it is capital the owner put in rather than customer payments — that&apos;s what the &quot;Owner Capital&quot; category on each entry is for.</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>As Of Date</label>
        <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
      <Field label="Actual Balance (EGP)" value={balance} onChange={v=>{setBalance(v);setErr("");}} type="number" ph="e.g. 50000"/></div>
    {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
    <button type="button" onClick={save} style={{width:"100%",padding:11,background:"#856404",color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:13}}>💾 Save Starting Balance</button>
  </div>);
}
function CashLedgerSection({cashLedger,cashOpening,data,laborRates,onSaveEntry,onDeleteEntry,onSetOpening,
  batches,silicaEntries,silicaSettings,silicaWithdrawals,flipOffSettings,flipOffWithdrawals,
  onSaveSilicaEntry,onDeleteSilicaEntry,onSaveSilicaSettings,onAddSilicaWithdrawal,onDeleteSilicaWithdrawal,
  onSaveBatch,onSaveFlipOffSettings,onAddFlipOffWithdrawal,onDeleteFlipOffWithdrawal,onClose}){
  const [showAdd,setShowAdd]=useState(false);
  const [tab,setTab]=useState("ledger");
  const balance=cashRunningBalance(cashOpening,cashLedger);
  const sorted=cashLedger.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||"")||(b.createdAt||"").localeCompare(a.createdAt||""));
  const monthly=cashMonthlySummary(cashLedger);
  const totalIn=cashLedger.reduce((s,e)=>e.type==="in"?s+(Number(e.amount)||0):s,0);
  const totalOut=cashLedger.reduce((s,e)=>e.type==="out"?s+(Number(e.amount)||0):s,0);
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0E4A2A,#1A7A45)",position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:17}}>🏦 East Pharma Finance</div>
          <div style={{color:"rgba(255,255,255,0.6)",fontSize:11}}>Actual money in/out — separate from Finance estimates</div></div></div>
      <div style={{maxWidth:700,margin:"0 auto",display:"flex"}}>
        {[["ledger","📒 Ledger"],["pnl","📈 Profit & Loss"],["balance","🧾 Balance Sheet"],["commissions","🤝 Commissions"]].map(x=>(
          <button type="button" key={x[0]} onClick={()=>setTab(x[0])}
            style={{flex:1,background:"none",border:"none",color:tab===x[0]?"#fff":"rgba(255,255,255,0.45)",padding:"11px 8px",fontSize:12,fontWeight:tab===x[0]?700:400,cursor:"pointer",borderBottom:"2px solid "+(tab===x[0]?"#fff":"transparent"),fontFamily:"inherit"}}>{x[1]}</button>))}
      </div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16}}>
      {tab!=="commissions"&&<CashOpeningSetup opening={cashOpening} onSave={onSetOpening}/>}
      {tab==="commissions"&&<CommissionsView batches={batches} data={data} laborRates={laborRates}
        silicaEntries={silicaEntries} silicaSettings={silicaSettings} silicaWithdrawals={silicaWithdrawals}
        flipOffSettings={flipOffSettings} flipOffWithdrawals={flipOffWithdrawals}
        onSaveSilicaEntry={onSaveSilicaEntry} onDeleteSilicaEntry={onDeleteSilicaEntry} onSaveSilicaSettings={onSaveSilicaSettings}
        onAddSilicaWithdrawal={onAddSilicaWithdrawal} onDeleteSilicaWithdrawal={onDeleteSilicaWithdrawal}
        onSaveBatch={onSaveBatch} onSaveFlipOffSettings={onSaveFlipOffSettings}
        onAddFlipOffWithdrawal={onAddFlipOffWithdrawal} onDeleteFlipOffWithdrawal={onDeleteFlipOffWithdrawal}/>}
      {tab!=="commissions"&&cashOpening&&<>
      {tab==="ledger"&&<>
      <div style={{background:"#fff",borderRadius:14,border:"1.5px solid #EEF2F7",padding:18,marginBottom:14,textAlign:"center"}}>
        <div style={{fontSize:11,fontWeight:700,color:"#888",textTransform:"uppercase"}}>Current Cash Balance</div>
        <div style={{fontSize:32,fontWeight:900,color:balance>=0?"#1A6B2A":"#DC3545",marginTop:4}}>{fmtN(balance)} EGP</div>
        <div style={{display:"flex",justifyContent:"center",gap:20,marginTop:10,fontSize:12}}>
          <div>🟢 In: <strong style={{color:"#1A6B2A"}}>{fmtN(totalIn)}</strong></div>
          <div>🔴 Out: <strong style={{color:"#DC3545"}}>{fmtN(totalOut)}</strong></div></div></div>
      {monthly.length>0&&<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
        <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:10}}>📅 Monthly Summary</div>
        {monthly.map(m=>(<div key={m.month} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}>
          <span style={{fontWeight:700,color:"#555"}}>{m.month}</span>
          <span>🟢 {fmtN(m.in)} · 🔴 {fmtN(m.out)} · <strong style={{color:m.in-m.out>=0?"#1A6B2A":"#DC3545"}}>{fmtN(m.in-m.out)} net</strong></span></div>))}
      </div>}
      {!showAdd&&<button type="button" onClick={()=>setShowAdd(true)} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:14,cursor:"pointer",marginBottom:14}}>+ Add Entry</button>}
      {showAdd&&<CashEntryForm onSave={en=>{onSaveEntry(en);setShowAdd(false);}} onCancel={()=>setShowAdd(false)}/>}
      {sorted.map(en=><CashEntryRow key={en.id} entry={en} onSave={onSaveEntry} onDelete={()=>onDeleteEntry(en.id)}/>)}
      {cashLedger.length===0&&<div style={{textAlign:"center",padding:30,color:"#888",fontSize:13}}>No entries yet — log your first payment in or out above.</div>}
      </>}
      {tab==="pnl"&&<PnLView cashLedger={cashLedger}/>}
      {tab==="balance"&&<BalanceSheetView cashOpening={cashOpening} cashLedger={cashLedger} data={data} laborRates={laborRates}/>}
      </>}
    </div></div>);
}

// ══ SALES COMMISSION TRACKER ═══════════════════════════════════════════════
// Replicates the company's commission spreadsheet: Income Tax → Net Profit After Tax →
// Commission (only once money is actually RECEIVED from the client, never on a pending sale) —
// then split among the owners by their share, with a withdrawal log tracking what each has
// already taken against their share. Two independent trackers, matching the spreadsheet's two
// separate sheets — Silica Gel and Flip-Off have different owner splits and are tracked
// separately. Flip-Off rows pull Total Sales/Gross Profit live from orderFinance() (the app's
// own Finance estimate) rather than being typed in, since every Flip-Off order already lives in
// Orders; Silica Gel rows are typed in directly, since its receipts are made up differently from
// the batch records and the typed figure is the one that's actually collected.
const COMMISSION_OWNERS_SILICA=[{name:"Youssef",share:1/3},{name:"Roger",share:1/3},{name:"Islam",share:1/3}];
const COMMISSION_OWNERS_FLIPOFF=[{name:"Youssef",share:0.5},{name:"Roger",share:0.5}];
const DEFAULT_COMMISSION_SETTINGS={incomeTaxRate:0.22,commissionRate:0.08,paymentTermsDays:60};
const INITIAL_SILICA_COMMISSION_ENTRIES=[
  {id:"sc-1",date:"2026-07-14",client:"Adwia",product:"Silica Gel Sachet",size:"0.5",qty:520000,totalSalesEGP:163800,grossProfitEGP:127400,moneyReceived:false,commissionPaid:false,datePaid:null},
  {id:"sc-2",date:"2026-07-16",client:"Adwia",product:"Silica Gel Sachet",size:"0.5",qty:480000,totalSalesEGP:151200,grossProfitEGP:117600,moneyReceived:false,commissionPaid:false,datePaid:null},
  {id:"sc-3",date:"2026-08-10",client:"Organix Eg",product:"Silica Gel Sachet",size:"0.5",qty:100000,totalSalesEGP:39000,grossProfitEGP:32000,moneyReceived:true,commissionPaid:true,datePaid:null},
  {id:"sc-4",date:"2026-08-18",client:"EVA",product:"Silica Gel Sachet",size:"1 g",qty:50000,totalSalesEGP:35256,grossProfitEGP:26200,moneyReceived:false,commissionPaid:false,datePaid:null},
  {id:"sc-5",date:"2026-09-03",client:"Mountain Nutrition",product:"Silica Gel Sachet",size:"10 g",qty:40000,totalSalesEGP:180000,grossProfitEGP:157432,moneyReceived:true,commissionPaid:true,datePaid:null},
  {id:"sc-6",date:"2026-09-03",client:"Mountain Nutrition",product:"Silica Gel Sachet",size:"5 g",qty:10000,totalSalesEGP:25000,grossProfitEGP:21740,moneyReceived:true,commissionPaid:true,datePaid:null},
];
function commissionRowCalc(row,settings){
  const taxRate=Number(settings.incomeTaxRate)||0,commRate=Number(settings.commissionRate)||0,termsDays=Number(settings.paymentTermsDays)||0;
  const grossProfit=Number(row.grossProfitEGP)||0,totalSales=Number(row.totalSalesEGP)||0;
  const incomeTax=grossProfit*taxRate;
  const netProfitAfterTax=grossProfit-incomeTax;
  const commissionDue=row.moneyReceived?netProfitAfterTax*commRate:0;
  const balanceOwed=row.moneyReceived?0:totalSales;
  let moneyExpectedOn=null;
  if(row.date){const d=new Date(row.date+"T00:00:00");d.setDate(d.getDate()+termsDays);moneyExpectedOn=d.toISOString().split("T")[0];}
  let paymentStatus;
  if(!row.date)paymentStatus="NEED SHIP DATE";
  else if(row.moneyReceived)paymentStatus="RECEIVED";
  else paymentStatus=(new Date().toISOString().split("T")[0])>moneyExpectedOn?"OVERDUE":"DUE LATER";
  return {incomeTax:incomeTax,netProfitAfterTax:netProfitAfterTax,commissionDue:commissionDue,balanceOwed:balanceOwed,moneyExpectedOn:moneyExpectedOn,paymentStatus:paymentStatus};
}
function commissionSummary(rows,settings){
  const calcs=rows.map(r=>Object.assign({},r,commissionRowCalc(r,settings)));
  const totalSales=calcs.reduce((s,r)=>s+(Number(r.totalSalesEGP)||0),0);
  const totalGrossProfit=calcs.reduce((s,r)=>s+(Number(r.grossProfitEGP)||0),0);
  const marginPct=totalSales>0?totalGrossProfit/totalSales:0;
  const receivedRows=calcs.filter(r=>r.moneyReceived);
  const netProfitReceived=receivedRows.reduce((s,r)=>s+r.netProfitAfterTax,0);
  const commissionDueTotal=calcs.reduce((s,r)=>s+r.commissionDue,0);
  const commissionPaidTotal=calcs.filter(r=>r.commissionPaid).reduce((s,r)=>s+r.commissionDue,0);
  const commissionOutstanding=commissionDueTotal-commissionPaidTotal;
  const totalMoneyReceived=receivedRows.reduce((s,r)=>s+(Number(r.totalSalesEGP)||0),0);
  const receivables=calcs.reduce((s,r)=>s+r.balanceOwed,0);
  const overdue=calcs.filter(r=>r.paymentStatus==="OVERDUE").reduce((s,r)=>s+r.balanceOwed,0);
  const notYetDue=calcs.filter(r=>r.paymentStatus==="DUE LATER").reduce((s,r)=>s+r.balanceOwed,0);
  const pctCollected=totalSales>0?totalMoneyReceived/totalSales:0;
  const distributableProfit=netProfitReceived-commissionDueTotal;
  return {calcs:calcs,totalSales:totalSales,totalGrossProfit:totalGrossProfit,marginPct:marginPct,netProfitReceived:netProfitReceived,
    commissionDueTotal:commissionDueTotal,commissionPaidTotal:commissionPaidTotal,commissionOutstanding:commissionOutstanding,
    totalMoneyReceived:totalMoneyReceived,receivables:receivables,overdue:overdue,notYetDue:notYetDue,pctCollected:pctCollected,
    distributableProfit:distributableProfit};
}
function ownerSharesCalc(owners,distributableProfit,withdrawals){
  return owners.map(o=>{
    const shareEGP=distributableProfit*o.share;
    const withdrawn=(withdrawals||[]).filter(w=>w.owner===o.name).reduce((s,w)=>s+(Number(w.amountEGP)||0),0);
    return {name:o.name,share:o.share,shareEGP:shareEGP,withdrawn:withdrawn,balanceDue:shareEGP-withdrawn};
  });
}
function CommissionSettingsCard({settings,onSave}){
  const [editing,setEditing]=useState(false);
  const [tax,setTax]=useState(String((settings.incomeTaxRate||0)*100));
  const [comm,setComm]=useState(String((settings.commissionRate||0)*100));
  const [terms,setTerms]=useState(String(settings.paymentTermsDays||0));
  const save=()=>{onSave({incomeTaxRate:(Number(tax)||0)/100,commissionRate:(Number(comm)||0)/100,paymentTermsDays:Number(terms)||0});setEditing(false);};
  if(!editing)return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14,display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,gap:8,flexWrap:"wrap"}}>
    <div>Income Tax <strong>{((settings.incomeTaxRate||0)*100).toFixed(1)}%</strong> · Commission <strong>{((settings.commissionRate||0)*100).toFixed(1)}%</strong> · Terms <strong>{settings.paymentTermsDays} days</strong></div>
    <button type="button" onClick={()=>setEditing(true)} style={{background:"#F5F7FA",border:"none",borderRadius:7,padding:"6px 12px",cursor:"pointer",fontSize:12,fontWeight:600}}>✏️ Edit</button></div>);
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid "+NAVY,padding:14,marginBottom:14}}>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:10}}>
      <Field label="Income Tax %" value={tax} onChange={setTax} type="number" ph="22"/>
      <Field label="Commission %" value={comm} onChange={setComm} type="number" ph="8"/>
      <Field label="Payment Terms (days)" value={terms} onChange={setTerms} type="number" ph="60"/></div>
    <div style={{display:"flex",gap:8}}>
      <button type="button" onClick={save} style={{flex:1,padding:10,background:NAVY,color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:13}}>💾 Save</button>
      <button type="button" onClick={()=>setEditing(false)} style={{padding:"10px 16px",border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:13}}>Cancel</button></div>
  </div>);
}
function CommissionSummaryCard({summary}){
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
    <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:10}}>📊 Summary</div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,fontSize:12}}>
      <div><div style={{color:"#888",fontSize:10,textTransform:"uppercase"}}>Total Sales</div><div style={{fontWeight:800,fontSize:15}}>{fmtN(summary.totalSales)} EGP</div></div>
      <div><div style={{color:"#888",fontSize:10,textTransform:"uppercase"}}>Total Gross Profit</div><div style={{fontWeight:800,fontSize:15}}>{fmtN(summary.totalGrossProfit)} EGP</div><div style={{color:"#999",fontSize:10}}>{(summary.marginPct*100).toFixed(1)}% margin</div></div>
      <div><div style={{color:"#888",fontSize:10,textTransform:"uppercase"}}>Money Received</div><div style={{fontWeight:800,fontSize:15,color:"#1A6B2A"}}>{fmtN(summary.totalMoneyReceived)} EGP</div><div style={{color:"#999",fontSize:10}}>{(summary.pctCollected*100).toFixed(1)}% collected</div></div>
      <div><div style={{color:"#888",fontSize:10,textTransform:"uppercase"}}>Still Owed (Receivables)</div><div style={{fontWeight:800,fontSize:15,color:"#DC3545"}}>{fmtN(summary.receivables)} EGP</div><div style={{color:"#999",fontSize:10}}>{fmtN(summary.overdue)} overdue · {fmtN(summary.notYetDue)} not due yet</div></div>
      <div><div style={{color:"#888",fontSize:10,textTransform:"uppercase"}}>Net Profit After Tax (received)</div><div style={{fontWeight:800,fontSize:15}}>{fmtN(summary.netProfitReceived)} EGP</div></div>
      <div><div style={{color:"#888",fontSize:10,textTransform:"uppercase"}}>Commission Outstanding</div><div style={{fontWeight:800,fontSize:15,color:summary.commissionOutstanding>0?"#DC3545":"#1A6B2A"}}>{fmtN(summary.commissionOutstanding)} EGP</div><div style={{color:"#999",fontSize:10}}>Due {fmtN(summary.commissionDueTotal)} · Paid {fmtN(summary.commissionPaidTotal)}</div></div>
    </div></div>);
}
function OwnerSharesCard({owners,distributableProfit,withdrawals,onAddWithdrawal,onDeleteWithdrawal}){
  const shares=ownerSharesCalc(owners,distributableProfit,withdrawals);
  const [showAdd,setShowAdd]=useState(false);
  const [date,setDate]=useState(new Date().toISOString().split("T")[0]),[owner,setOwner]=useState(owners[0].name);
  const [amount,setAmount]=useState(""),[method,setMethod]=useState(""),[notes,setNotes]=useState(""),[err,setErr]=useState("");
  const add=()=>{
    const amt=Number(amount)||0;
    if(amt<=0){setErr("Enter an amount.");return;}
    onAddWithdrawal({id:genId(),date:date,owner:owner,amountEGP:amt,method:method.trim(),notes:notes.trim()});
    setAmount("");setMethod("");setNotes("");setShowAdd(false);setErr("");
  };
  const sortedW=(withdrawals||[]).slice().sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:14}}>
    <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:4}}>👥 Owner Shares</div>
    <div style={{fontSize:11,color:"#888",marginBottom:10}}>Distributable Profit (received net profit − commission) = <strong>{fmtN(distributableProfit)} EGP</strong></div>
    {shares.map(s=>(<div key={s.name} style={{display:"flex",justifyContent:"space-between",alignItems:"center",padding:"8px 0",borderBottom:"1px solid #F5F5F5",fontSize:12}}>
      <div><strong>{s.name}</strong> <span style={{color:"#999"}}>({(s.share*100).toFixed(1)}%)</span></div>
      <div style={{textAlign:"right"}}>
        <div>Share: <strong>{fmtN(s.shareEGP)}</strong> · Taken: <strong>{fmtN(s.withdrawn)}</strong></div>
        <div style={{color:s.balanceDue<=0?"#1A6B2A":"#DC3545",fontWeight:700}}>{s.balanceDue<=0?"✅ Fully Paid":fmtN(s.balanceDue)+" EGP owed"}</div></div></div>))}
    {!showAdd&&<button type="button" onClick={()=>setShowAdd(true)} style={{width:"100%",padding:10,marginTop:10,background:NAVY,color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:12}}>+ Log Withdrawal</button>}
    {showAdd&&<div style={{marginTop:10,background:"#F7F9FC",borderRadius:10,padding:12}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:8,marginBottom:8}}>
        <div><label style={{display:"block",fontSize:10,fontWeight:700,color:"#666",marginBottom:3,textTransform:"uppercase"}}>Date</label>
          <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:6,padding:"7px 9px",fontSize:12,boxSizing:"border-box"}}/></div>
        <div><label style={{display:"block",fontSize:10,fontWeight:700,color:"#666",marginBottom:3,textTransform:"uppercase"}}>Owner</label>
          <select value={owner} onChange={e=>setOwner(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:6,padding:"7px 9px",fontSize:12,background:"#fff"}}>
            {owners.map(o=><option key={o.name}>{o.name}</option>)}</select></div></div>
      <div style={{marginBottom:8}}><Field label="Amount Taken (EGP)" value={amount} onChange={v=>{setAmount(v);setErr("");}} type="number" ph="e.g. 10000"/></div>
      <div style={{marginBottom:8}}><Field label="Method (optional)" value={method} onChange={setMethod} ph="e.g. Bank transfer"/></div>
      <div style={{marginBottom:8}}><Field label="Notes (optional)" value={notes} onChange={setNotes}/></div>
      {err&&<div style={{color:"#DC3545",fontSize:11,fontWeight:600,marginBottom:8}}>{err}</div>}
      <div style={{display:"flex",gap:8}}>
        <button type="button" onClick={add} style={{flex:1,padding:9,background:NAVY,color:"#fff",border:"none",borderRadius:7,fontWeight:700,cursor:"pointer",fontSize:12}}>💾 Save</button>
        <button type="button" onClick={()=>setShowAdd(false)} style={{padding:"9px 14px",border:"1.5px solid #E2E8F0",borderRadius:7,background:"#fff",cursor:"pointer",fontSize:12}}>Cancel</button></div></div>}
    {sortedW.length>0&&<div style={{marginTop:14,paddingTop:10,borderTop:"1px solid #E2E8F0"}}>
      <div style={{fontSize:11,fontWeight:700,color:"#888",textTransform:"uppercase",marginBottom:8}}>Withdrawal Log</div>
      {sortedW.map(w=>(<div key={w.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,padding:"6px 0",borderBottom:"1px solid #F5F5F5"}}>
        <div><strong>{w.owner}</strong> <span style={{color:"#999"}}>{w.date}{w.method?" · "+w.method:""}</span>{w.notes&&<div style={{fontSize:11,color:"#999"}}>{w.notes}</div>}</div>
        <div style={{display:"flex",alignItems:"center",gap:8}}><strong>{fmtN(w.amountEGP)} EGP</strong>
          <button type="button" onClick={()=>onDeleteWithdrawal(w.id)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:14,padding:0}}>✕</button></div></div>))}
    </div>}
  </div>);
}
function PaymentStatusBadge({status}){
  const cfg={"RECEIVED":["#C6EFCE","#1A6B2A"],"OVERDUE":["#FDDEDE","#8B1A1A"],"DUE LATER":["#FFF3CD","#856404"],"NEED SHIP DATE":["#EEE","#666"]}[status]||["#EEE","#666"];
  return <span style={{background:cfg[0],color:cfg[1],borderRadius:20,padding:"2px 9px",fontSize:10,fontWeight:700,whiteSpace:"nowrap"}}>{status}</span>;
}
function SilicaCommissionRowEdit({row,onSave,onCancel,onDelete}){
  const e=row||{};
  const [date,setDate]=useState(e.date||""),[client,setClient]=useState(e.client||""),[product,setProduct]=useState(e.product||"Silica Gel Sachet");
  const [size,setSize]=useState(e.size||""),[qty,setQty]=useState(e.qty!=null?String(e.qty):""),[sales,setSales]=useState(e.totalSalesEGP!=null?String(e.totalSalesEGP):""),[profit,setProfit]=useState(e.grossProfitEGP!=null?String(e.grossProfitEGP):"");
  const [moneyReceived,setMoneyReceived]=useState(!!e.moneyReceived),[commissionPaid,setCommissionPaid]=useState(!!e.commissionPaid),[datePaid,setDatePaid]=useState(e.datePaid||"");
  const [confDel,setConfDel]=useState(false),[err,setErr]=useState("");
  const save=()=>{
    if(!client.trim()){setErr("Enter a client.");return;}
    onSave(Object.assign({},e,{id:e.id||genId(),date:date,client:client.trim(),product:product,size:size,qty:Number(qty)||0,
      totalSalesEGP:Number(sales)||0,grossProfitEGP:Number(profit)||0,moneyReceived:moneyReceived,commissionPaid:commissionPaid,datePaid:datePaid||null}));
  };
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid "+NAVY,padding:14,marginBottom:8}}>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date Shipped</label>
        <input type="date" value={date} onChange={ev=>setDate(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
      <Field label="Client" value={client} onChange={v=>{setClient(v);setErr("");}} ph="e.g. Adwia"/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
      <Field label="Product" value={product} onChange={setProduct}/>
      <Field label="Size" value={size} onChange={setSize} ph="e.g. 0.5 or 10 g"/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:10}}>
      <Field label="Qty (pcs)" value={qty} onChange={setQty} type="number"/>
      <Field label="Total Sales (EGP)" value={sales} onChange={setSales} type="number"/>
      <Field label="Gross Profit (EGP)" value={profit} onChange={setProfit} type="number"/></div>
    <div style={{display:"flex",gap:16,marginBottom:10}}>
      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer"}}><input type="checkbox" checked={moneyReceived} onChange={ev=>setMoneyReceived(ev.target.checked)}/> Money Received</label>
      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer"}}><input type="checkbox" checked={commissionPaid} onChange={ev=>setCommissionPaid(ev.target.checked)}/> Commission Paid</label></div>
    {commissionPaid&&<div style={{marginBottom:10}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date Paid</label>
      <input type="date" value={datePaid} onChange={ev=>setDatePaid(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>}
    {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
    <div style={{display:"flex",gap:8,marginBottom:10}}>
      <button type="button" onClick={save} style={{flex:1,padding:11,background:NAVY,color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:13}}>💾 Save</button>
      <button type="button" onClick={onCancel} style={{padding:"11px 16px",border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    {onDelete&&(confDel?(<div style={{display:"flex",gap:8}}>
      <button type="button" onClick={()=>onDelete()} style={{padding:"8px 14px",background:"#DC3545",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>Yes, delete</button>
      <button type="button" onClick={()=>setConfDel(false)} style={{padding:"8px 14px",border:"1.5px solid #E2E8F0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:12}}>Cancel</button></div>)
    :(<button type="button" onClick={()=>setConfDel(true)} style={{padding:"8px 14px",border:"1.5px solid #F1948A",color:"#DC3545",background:"#FFF0F0",borderRadius:6,cursor:"pointer",fontSize:12}}>Delete entry</button>))}
  </div>);
}
function SilicaCommissionRow({row,settings,onSave,onDelete}){
  const [editing,setEditing]=useState(false);
  const calc=commissionRowCalc(row,settings);
  if(editing)return <SilicaCommissionRowEdit row={row} onSave={u=>{onSave(u);setEditing(false);}} onCancel={()=>setEditing(false)} onDelete={onDelete}/>;
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:"12px 14px",marginBottom:8}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:6}}>
      <div><strong>{row.client}</strong> <span style={{color:"#999",fontSize:11}}>{row.product}{row.size?" · "+row.size:""}</span>
        <div style={{fontSize:11,color:"#999"}}>{row.date||"— no ship date —"} · {fmtN(row.qty)} pcs</div></div>
      <PaymentStatusBadge status={calc.paymentStatus}/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:11,marginBottom:8}}>
      <div>Sales<div style={{fontWeight:700,fontSize:13}}>{fmtN(row.totalSalesEGP)}</div></div>
      <div>Gross Profit<div style={{fontWeight:700,fontSize:13}}>{fmtN(row.grossProfitEGP)}</div></div>
      <div>Commission Due<div style={{fontWeight:700,fontSize:13,color:calc.commissionDue>0?"#1A6B2A":"#999"}}>{fmtN(calc.commissionDue)}</div></div></div>
    <div style={{display:"flex",gap:14,fontSize:11,color:"#666",marginBottom:8}}>
      <span>{row.moneyReceived?"✅ Received":"⏳ Not received"}</span>
      <span>{row.commissionPaid?"✅ Commission paid":"⏳ Commission unpaid"}</span></div>
    <button type="button" onClick={()=>setEditing(true)} style={{background:"#F5F7FA",border:"none",borderRadius:7,padding:"6px 12px",cursor:"pointer",fontSize:12,fontWeight:600}}>✏️ Edit</button></div>);
}
// Each shipment/invoice is a real production Batch, not an Order — an Order can span several
// batches shipped (and invoiced, and paid) separately over time, so the batch is the right unit
// for a commission row. dateShipped/moneyReceived/commissionPaid/datePaidCommission live
// directly on the batch record (added here, alongside the batch's existing sellPricePerPc); the
// Sales/Gross Profit figures come straight from buildBatchCost(), the same real cost/revenue
// calc Finance already uses per batch — not a separately typed estimate.
function commissionRowsFromBatches(batches,data,laborRates,forSilica){
  return (batches||[]).filter(b=>!b.isSubBatch&&isSilicaProduct(b.product)===forSilica&&b.status!=="Rejected").map(b=>{
    const fin=buildBatchCost(b,batches,data,laborRates);
    return {id:"batch-"+b.id,date:b.dateShipped||null,totalSalesEGP:fin.revenueEGP,grossProfitEGP:fin.profitEGP,
      moneyReceived:!!b.moneyReceived,commissionPaid:!!b.commissionPaid};
  });
}
function BatchCommissionRow({batch,batches,data,laborRates,settings,onSave}){
  const [editing,setEditing]=useState(false);
  const fin=buildBatchCost(batch,batches,data,laborRates);
  const row={date:batch.dateShipped,totalSalesEGP:fin.revenueEGP,grossProfitEGP:fin.profitEGP,moneyReceived:!!batch.moneyReceived};
  const calc=commissionRowCalc(row,settings);
  const [date,setDate]=useState(batch.dateShipped||""),[moneyReceived,setMoneyReceived]=useState(!!batch.moneyReceived);
  const [commissionPaid,setCommissionPaid]=useState(!!batch.commissionPaid),[datePaid,setDatePaid]=useState(batch.datePaidCommission||"");
  const save=()=>{onSave(Object.assign({},batch,{dateShipped:date,moneyReceived:moneyReceived,commissionPaid:commissionPaid,datePaidCommission:datePaid||null}));setEditing(false);};
  if(!editing)return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:"12px 14px",marginBottom:8}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",gap:8,marginBottom:6}}>
      <div><strong>{batch.client||"—"}</strong> <span style={{color:"#999",fontSize:11}}>{batch.batchNo} · {batch.product}{batch.color?" · "+batch.color:""}</span>
        <div style={{fontSize:11,color:"#999"}}>{batch.dateShipped||"— no ship date —"} · {fmtN(batch.totalPcs)} pcs</div></div>
      <PaymentStatusBadge status={calc.paymentStatus}/></div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:8,fontSize:11,marginBottom:8}}>
      <div>Sales<div style={{fontWeight:700,fontSize:13}}>{fmtN(fin.revenueEGP)}</div></div>
      <div>Gross Profit<div style={{fontWeight:700,fontSize:13}}>{fmtN(fin.profitEGP)}</div></div>
      <div>Commission Due<div style={{fontWeight:700,fontSize:13,color:calc.commissionDue>0?"#1A6B2A":"#999"}}>{fmtN(calc.commissionDue)}</div></div></div>
    <div style={{display:"flex",gap:14,fontSize:11,color:"#666",marginBottom:8}}>
      <span>{batch.moneyReceived?"✅ Received":"⏳ Not received"}</span>
      <span>{batch.commissionPaid?"✅ Commission paid":"⏳ Commission unpaid"}</span></div>
    <button type="button" onClick={()=>setEditing(true)} style={{background:"#F5F7FA",border:"none",borderRadius:7,padding:"6px 12px",cursor:"pointer",fontSize:12,fontWeight:600}}>✏️ Edit</button></div>);
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid "+NAVY,padding:14,marginBottom:8}}>
    <div style={{fontSize:12,color:"#888",marginBottom:8}}>{batch.batchNo} · {batch.client} — Sales/Profit pull live from the batch&apos;s own production cost; edit sell price on the batch itself, not here.</div>
    <div style={{marginBottom:10}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date Shipped (invoiced)</label>
      <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
    <div style={{display:"flex",gap:16,marginBottom:10}}>
      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer"}}><input type="checkbox" checked={moneyReceived} onChange={e=>setMoneyReceived(e.target.checked)}/> Money Received</label>
      <label style={{display:"flex",alignItems:"center",gap:6,fontSize:12,cursor:"pointer"}}><input type="checkbox" checked={commissionPaid} onChange={e=>setCommissionPaid(e.target.checked)}/> Commission Paid</label></div>
    {commissionPaid&&<div style={{marginBottom:10}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date Paid</label>
      <input type="date" value={datePaid} onChange={e=>setDatePaid(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>}
    <div style={{display:"flex",gap:8}}>
      <button type="button" onClick={save} style={{flex:1,padding:11,background:NAVY,color:"#fff",border:"none",borderRadius:8,fontWeight:700,cursor:"pointer",fontSize:13}}>💾 Save</button>
      <button type="button" onClick={()=>setEditing(false)} style={{padding:"11px 16px",border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",cursor:"pointer",fontSize:13}}>Cancel</button></div>
  </div>);
}
// Silica keeps its historical manually-typed rows (receipts that don't match batch records) as
// the permanent record of what was already sold — but every Silica batch shipped from now on
// shows up automatically here too, same mechanism as Flip-Off, so nothing new needs typing in.
function SilicaCommissionTracker({entries,settings,withdrawals,batches,data,laborRates,onSaveEntry,onDeleteEntry,onSaveSettings,onAddWithdrawal,onDeleteWithdrawal,onSaveBatch}){
  const [showAdd,setShowAdd]=useState(false);
  const batchRows=commissionRowsFromBatches(batches,data,laborRates,true);
  const summary=commissionSummary(entries.concat(batchRows),settings);
  const sortedEntries=entries.slice().sort((a,b)=>(b.date||"").localeCompare(a.date||""));
  const silicaBatches=(batches||[]).filter(b=>!b.isSubBatch&&isSilicaProduct(b.product)&&b.status!=="Rejected").sort((a,b)=>(b.dateShipped||"").localeCompare(a.dateShipped||""));
  return(<div>
    <CommissionSettingsCard settings={settings} onSave={onSaveSettings}/>
    <CommissionSummaryCard summary={summary}/>
    <OwnerSharesCard owners={COMMISSION_OWNERS_SILICA} distributableProfit={summary.distributableProfit} withdrawals={withdrawals} onAddWithdrawal={onAddWithdrawal} onDeleteWithdrawal={onDeleteWithdrawal}/>
    <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:10}}>🧾 Sales (typed in — historical receipts)</div>
    {!showAdd&&<button type="button" onClick={()=>setShowAdd(true)} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:14,cursor:"pointer",marginBottom:14}}>+ Add Sale</button>}
    {showAdd&&<SilicaCommissionRowEdit row={{}} onSave={r=>{onSaveEntry(r);setShowAdd(false);}} onCancel={()=>setShowAdd(false)}/>}
    {sortedEntries.map(r=><SilicaCommissionRow key={r.id} row={r} settings={settings} onSave={onSaveEntry} onDelete={()=>onDeleteEntry(r.id)}/>)}
    {entries.length===0&&<div style={{textAlign:"center",padding:20,color:"#888",fontSize:13}}>No typed-in sales.</div>}
    <div style={{fontWeight:800,fontSize:13,color:NAVY,marginTop:18,marginBottom:10}}>📦 Batches (auto, from Production)</div>
    {silicaBatches.map(b=><BatchCommissionRow key={b.id} batch={b} batches={batches} data={data} laborRates={laborRates} settings={settings} onSave={onSaveBatch}/>)}
    {silicaBatches.length===0&&<div style={{textAlign:"center",padding:20,color:"#888",fontSize:13}}>No Silica Gel batches yet — create one under Production.</div>}
  </div>);
}
function FlipOffCommissionTracker({batches,data,laborRates,settings,withdrawals,onSaveBatch,onSaveSettings,onAddWithdrawal,onDeleteWithdrawal}){
  const rows=commissionRowsFromBatches(batches,data,laborRates,false);
  const summary=commissionSummary(rows,settings);
  const sorted=(batches||[]).filter(b=>!b.isSubBatch&&!isSilicaProduct(b.product)&&b.status!=="Rejected").sort((a,b)=>(b.dateShipped||"").localeCompare(a.dateShipped||""));
  return(<div>
    <CommissionSettingsCard settings={settings} onSave={onSaveSettings}/>
    <CommissionSummaryCard summary={summary}/>
    <OwnerSharesCard owners={COMMISSION_OWNERS_FLIPOFF} distributableProfit={summary.distributableProfit} withdrawals={withdrawals} onAddWithdrawal={onAddWithdrawal} onDeleteWithdrawal={onDeleteWithdrawal}/>
    <div style={{fontWeight:800,fontSize:13,color:NAVY,marginBottom:10}}>🧾 Batches</div>
    {sorted.map(b=><BatchCommissionRow key={b.id} batch={b} batches={batches} data={data} laborRates={laborRates} settings={settings} onSave={onSaveBatch}/>)}
    {sorted.length===0&&<div style={{textAlign:"center",padding:30,color:"#888",fontSize:13}}>No Flip-Off batches yet — create one under Production.</div>}
  </div>);
}
function CommissionsView({batches,data,laborRates,silicaEntries,silicaSettings,silicaWithdrawals,flipOffSettings,flipOffWithdrawals,
  onSaveSilicaEntry,onDeleteSilicaEntry,onSaveSilicaSettings,onAddSilicaWithdrawal,onDeleteSilicaWithdrawal,
  onSaveBatch,onSaveFlipOffSettings,onAddFlipOffWithdrawal,onDeleteFlipOffWithdrawal}){
  const [line,setLine]=useState("silica");
  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:14}}>
      {[["silica","🟡 Silica Gel"],["flipoff","🔘 Flip-Off"]].map(x=>(
        <button type="button" key={x[0]} onClick={()=>setLine(x[0])}
          style={{flex:1,padding:9,borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",border:"1.5px solid "+(line===x[0]?NAVY:"#E2E8F0"),background:line===x[0]?NAVY:"#fff",color:line===x[0]?"#fff":"#666"}}>{x[1]}</button>))}
    </div>
    {line==="silica"&&<SilicaCommissionTracker entries={silicaEntries} settings={silicaSettings} withdrawals={silicaWithdrawals} batches={batches} data={data} laborRates={laborRates}
      onSaveEntry={onSaveSilicaEntry} onDeleteEntry={onDeleteSilicaEntry} onSaveSettings={onSaveSilicaSettings}
      onAddWithdrawal={onAddSilicaWithdrawal} onDeleteWithdrawal={onDeleteSilicaWithdrawal} onSaveBatch={onSaveBatch}/>}
    {line==="flipoff"&&<FlipOffCommissionTracker batches={batches} data={data} laborRates={laborRates} settings={flipOffSettings} withdrawals={flipOffWithdrawals}
      onSaveBatch={onSaveBatch} onSaveSettings={onSaveFlipOffSettings} onAddWithdrawal={onAddFlipOffWithdrawal} onDeleteWithdrawal={onDeleteFlipOffWithdrawal}/>}
  </div>);
}

const MATERIAL_META={
  "Aluminum Coils":{color:"#1A3C5E",accent:"#2D6A9F",light:"#D6E8FA",emoji:"🪙",trackCoils:true},
  "Aluminum Caps":{color:"#37474F",accent:"#607D8B",light:"#ECEFF1",emoji:"🔘"},
  "Aluminum Scrap":{color:"#8B5A2B",accent:"#B8860B",light:"#FDF3E0",emoji:"♻️"},
  "Plastic Material":{color:"#4A1A6E",accent:"#7B3FB5",light:"#EDE0FF",emoji:"🧴"},
  "Sachets Paper":{color:"#6B3010",accent:"#B85C1A",light:"#FEE8D0",emoji:"📄"},
  "Silica Gel":{color:"#0E4A2A",accent:"#1A7A45",light:"#D0F0E0",emoji:"🟡"},
  "WIP Inventory":{color:"#6B4F9E",accent:"#8B6FC7",light:"#EFEAFB",emoji:"🗂️"},
  "Cartons":{color:"#7A5230",accent:"#B8865C",light:"#F5E8D8",emoji:"📦"},
};
const STATUS_CONFIG={
  "In Stock":{bg:"#C6EFCE",text:"#1A6B2A",dot:"#22A03A"},
  "Low Stock":{bg:"#FFF3CD",text:"#856404",dot:"#E6A817"},
  "Out of Stock":{bg:"#FDDEDE",text:"#8B1A1A",dot:"#DC3545"},
  "Quarantined":{bg:"#FFE4CC",text:"#7A3300",dot:"#E87722"},
  "Pending Delivery":{bg:"#D1ECF1",text:"#0C5460",dot:"#17A2B8"},
};
const BST={
  Production:{bg:"#FFF3CD",text:"#856404",dot:"#E6A817"},
  "QC Hold":{bg:"#FDDEDE",text:"#8B1A1A",dot:"#DC3545"},
  Released:{bg:"#C6EFCE",text:"#1A6B2A",dot:"#22A03A"},
  Shipped:{bg:"#D1ECF1",text:"#0C5460",dot:"#17A2B8"},
  Rejected:{bg:"#FDDEDE",text:"#8B1A1A",dot:"#DC3545"},
};
const BSTATUSES=["Production","QC Hold","Released","Shipped","Rejected"];
const STAGES=["Injection","Plastic Sorting","Assembly","Final Sorting","Complete"];
const stageColor={"Injection":"#856404","Plastic Sorting":"#0C5460","Assembly":"#4A1A6E","Final Sorting":"#B8860B","Complete":"#1A6B2A"};
const stageBg={"Injection":"#FFF3CD","Plastic Sorting":"#D1ECF1","Assembly":"#EDE0FF","Final Sorting":"#FFF8DC","Complete":"#C6EFCE"};
const INITIAL_COILS={"Aluminum Coils":[]};

// Matches raw Silica Gel material lots (bought/stocked in 25 KG bags) so they display as
// "bags" — but NOT finished Silica Gel Sachets product saved to WIP Inventory, which is
// counted in plain pcs, not 25 KG bags of raw beads.
const isSilica=l=>{const d=(l.description||"").toLowerCase();return d.includes("silica gel")&&!d.includes("sachet");};
const BLANK_LOT={lotNumber:"",plNo:"",date:"",supplier:"",description:"",qtyReceived:"",unit:"KG",qtyRemaining:"",unitCost:"",unitCostCurrency:"EGP",status:"In Stock",notes:"",image:null,usageLog:[],totalCoils:"",coilsUsed:0};
function genId(){return Date.now().toString(36)+Math.random().toString(36).slice(2,6);}
function fmt(n){if(n===""||n==null||isNaN(Number(n)))return"—";return Number(n).toLocaleString("en-US",{minimumFractionDigits:2,maximumFractionDigits:2});}
function fmtN(n){if(n==null||isNaN(Number(n)))return"—";const v=Number(n);return v>=1000?v.toLocaleString("en-US"):v.toLocaleString("en-US",{minimumFractionDigits:0,maximumFractionDigits:2});}
function today(){return new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}).replace(/ /g,"-");}
// Adds whole years to an ISO date string (YYYY-MM-DD, the <input type="date"> format) —
// used for Silica Gel Sachets' fixed 3-year shelf life, computed from mfg date rather than
// entered by hand.
function addYears(isoDate,years){
  if(!isoDate)return "";
  const d=new Date(isoDate+"T00:00:00");
  if(isNaN(d.getTime()))return "";
  d.setFullYear(d.getFullYear()+years);
  return d.toISOString().split("T")[0];
}
function pad(n,l){return String(n).padStart(l,"0");}
function chunk(arr,n){const out=[];for(let i=0;i<arr.length;i+=n)out.push(arr.slice(i,i+n));return out;}
function getYr(){return new Date().getFullYear()%100;}
function coilWt(od,id,w){od=Number(od);id=Number(id);w=Number(w);if(!od||!id||!w||od<=id)return null;return((Math.PI/4)*(od*od-id*id)*w)*ALU_DEN;}
const kgToPcs=(kg,wt)=>Math.round(Number(kg)*1000/wt);
const pcsToKg=(pcs,wt)=>(Number(pcs)*wt/1000);
const diffPct=(a,b)=>b===0?0:Math.abs((a-b)/b*100);
const makeBags=(bn,cnt,dq,qu,ov)=>{ov=ov||{};return Array.from({length:cnt},(_,i)=>{const n=pad(i+1,2);return{id:"B"+n,label:bn+"-B"+n,qty:ov["B"+n]!==undefined?ov["B"+n]:dq,qtyUnit:qu,used:false,usedDate:null};});};
// Marks the first n bags of a freshly-made bag array as used (recovered historical usage — exact original bag order is unknown, so this is an approximation that keeps quantities exact).
const markUsed=(bags,n,date)=>bags.map((b,i)=>i<n?Object.assign({},b,{used:true,usedDate:date||null}):b);
function nextBatchNo(bs,code){const p="EPS-"+code+"-"+pad(getYr(),2);const ns=bs.filter(b=>b.batchNo.indexOf(p)===0&&!b.isSubBatch).map(b=>parseInt(b.batchNo.slice(p.length))||0);return p+pad(ns.length?Math.max.apply(null,ns)+1:1,4);}
function nextAlLotNo(lots){const p="EPS-AL-"+pad(getYr(),2);const ns=lots.filter(l=>(l.lotNumber||"").indexOf(p)===0).map(l=>parseInt((l.lotNumber||"").slice(p.length))||0);return p+pad(ns.length?Math.max.apply(null,ns)+1:1,4);}
// Credits scrapKg into the running Aluminum Scrap pool lot, creating it on first use.
function creditScrap(scrapLots,scrapKg,reason){
  if(scrapKg<=0)return scrapLots;
  let pool=scrapLots.filter(l=>l.id==="scrap-pool")[0];
  if(!pool){pool={id:"scrap-pool",lotNumber:"SCRAP-POOL",plNo:"",date:today(),supplier:"In-house (byproduct)",description:"Aluminum scrap collected from coil stamping",qtyReceived:0,unit:"KG",qtyRemaining:0,unitCost:"",unitCostCurrency:"EGP",status:"In Stock",notes:"Running total — sell down via Sell Scrap",image:null,usageLog:[]};}
  const newTotal=(Number(pool.qtyRemaining)||0)+scrapKg;
  const updatedPool=Object.assign({},pool,{qtyReceived:(Number(pool.qtyReceived)||0)+scrapKg,qtyRemaining:newTotal,status:"In Stock",
    usageLog:(pool.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:-scrapKg,reason:reason,remainingAfter:newTotal}])});
  return scrapLots.filter(l=>l.id!=="scrap-pool").concat([updatedPool]);
}

// ══ REPORTS — pure computation helpers ═══════════════════════════════════
// Lot/usageLog dates are stored as "DD-Mon-YYYY" (from today()); batch dates are ISO
// "YYYY-MM-DD" (from <input type="date">). Both need to resolve to the same month key.
function parseAnyDate(s){
  if(!s)return null;
  if(/^\d{4}-\d{2}-\d{2}/.test(s)){const d=new Date(s+"T00:00:00");return isNaN(d)?null:d;}
  const m=/^(\d{1,2})-([A-Za-z]{3})-(\d{4})$/.exec(s);
  if(m){const mo={Jan:0,Feb:1,Mar:2,Apr:3,May:4,Jun:5,Jul:6,Aug:7,Sep:8,Oct:9,Nov:10,Dec:11}[m[2]];
    if(mo!=null)return new Date(Number(m[3]),mo,Number(m[1]));}
  const d=new Date(s);return isNaN(d)?null:d;
}
function monthKeyOf(s){const d=parseAnyDate(s);return d?d.getFullYear()+"-"+pad(d.getMonth()+1,2):null;}
const MONTH_NAMES=["January","February","March","April","May","June","July","August","September","October","November","December"];
function fmtMonthKey(k){if(!k)return"";const p=k.split("-");return MONTH_NAMES[Number(p[1])-1]+" "+p[0];}
// Aggregates operator performance across shifts, split by stage — the "who is more
// efficient" view the board wants. Rate = good output ÷ what came into that stage.
function computeWorkerStats(shifts){
  const rows={};
  const bump=(stage,op,pcsIn,pcsOut)=>{
    const name=op&&op.trim()?op.trim():"Unspecified";
    const k=stage+"|"+name;
    if(!rows[k])rows[k]={stage:stage,operator:name,shifts:0,pcsIn:0,pcsOut:0};
    rows[k].shifts+=1;rows[k].pcsIn+=pcsIn||0;rows[k].pcsOut+=pcsOut||0;
  };
  shifts.forEach(s=>{
    if(s.injections)bump("Injection",s.operator,s.theoreticalPcs,s.acceptedPcs);
    if(s.assembledPcs!=null)bump("Assembly",s.assemblyOperator,s.acceptedPcs,s.assembledPcs);
    if(s.finalAcceptedKg!=null)bump("Final Sorting",s.finalSortOperator,s.assembledPcs,s.finalAcceptedPcs);
  });
  return Object.values(rows).map(r=>Object.assign({},r,{rate:r.pcsIn>0?Math.min(100,r.pcsOut/r.pcsIn*100):null}))
    .sort((a,b)=>a.stage!==b.stage?a.stage.localeCompare(b.stage):(b.rate||0)-(a.rate||0));
}
// Sums each material's usageLog movement (positive qtyUsed = used, negative = received) within one
// month. Bagged materials (Aluminum Caps) are consumed by toggling bags in Assembly, which never
// writes a usageLog entry — so those are counted separately from bag.used/usedDate instead, in pcs.
function materialUsageInMonth(data,monthKey){
  const out=[];
  Object.keys(data).forEach(matName=>{
    let used=0,added=0,unit="",bagPcsUsed=0,hasBags=false;
    (data[matName].lots||[]).forEach(lot=>{
      unit=lot.unit||unit;
      (lot.usageLog||[]).forEach(e=>{
        if(monthKeyOf(e.date)!==monthKey)return;
        if(Number(e.qtyUsed)>=0)used+=Number(e.qtyUsed);else added+=-Number(e.qtyUsed);
      });
      (lot.bags||[]).forEach(b=>{
        if(!b.used||monthKeyOf(b.usedDate)!==monthKey)return;
        hasBags=true;
        bagPcsUsed+=b.qtyUnit==="Pcs"?(Number(b.qty)||0):kgToPcs(b.qty,0.405);
      });
    });
    if(hasBags){if(bagPcsUsed>0)out.push({material:matName,used:bagPcsUsed,added:added,unit:"Pcs"});}
    else if(used>0||added>0)out.push({material:matName,used:used,added:added,unit:unit});
  });
  return out;
}
function computeWaste(shifts){
  let injLossKg=0,plasticRejKg=0,asmLossPcs=0,finalRejKg=0,totalPlasticInKg=0;
  shifts.forEach(s=>{
    if(s.totalPlasticKg){totalPlasticInKg+=s.totalPlasticKg;if(s.weightBeforeSorting)injLossKg+=Math.max(0,s.totalPlasticKg-s.weightBeforeSorting);}
    if(s.rejectedWeightKg)plasticRejKg+=s.rejectedWeightKg;
    if(s.acceptedPcs!=null&&s.assembledPcs!=null)asmLossPcs+=Math.max(0,s.acceptedPcs-s.assembledPcs);
    if(s.finalRejectedKg)finalRejKg+=s.finalRejectedKg;
  });
  return {injLossKg:injLossKg,plasticRejKg:plasticRejKg,asmLossPcs:asmLossPcs,finalRejKg:finalRejKg,totalPlasticInKg:totalPlasticInKg};
}
function computeShiftMaterials(shifts){
  let virginBags=0,regrindKg=0,totalPlasticKg=0,alPcs=0;const alLots={};
  shifts.forEach(s=>{
    virginBags+=s.virginBags||0;regrindKg+=s.regrindKg||0;totalPlasticKg+=s.totalPlasticKg||0;
    alPcs+=s.aluminumPcsIn||0;
    (s.aluminumSelections||[]).forEach(sel=>{alLots[sel.lotNo]=(alLots[sel.lotNo]||0)+(sel.pcs||0);});
  });
  return {virginBags:virginBags,regrindKg:regrindKg,totalPlasticKg:totalPlasticKg,alPcs:alPcs,alLots:alLots};
}
function computeProduction(topBatch,shifts){
  const goodPcs=shifts.reduce((s,x)=>s+(x.goodPcs||0),0);
  const target=topBatch.totalPcs||0;
  return {goodPcs:goodPcs,target:target,pct:target?Math.min(100,Math.round(goodPcs/target*100)):null,shiftCount:shifts.length,cartons:topBatch.cartons,status:topBatch.status};
}
function buildBatchReport(topBatch,allBatches){
  const shifts=allBatches.filter(b=>b.isSubBatch&&b.parentBatchNo===topBatch.batchNo);
  return {batch:topBatch,shifts:shifts,production:computeProduction(topBatch,shifts),materials:computeShiftMaterials(shifts),
    waste:computeWaste(shifts),workers:computeWorkerStats(shifts),carryovers:shifts.filter(s=>s.isCarryover)};
}
function buildOrderReport(order,allBatches){
  const linked=allBatches.filter(b=>!b.isSubBatch&&b.orderNo===order.orderNo);
  const batchReports=linked.map(b=>buildBatchReport(b,allBatches));
  const allShifts=[].concat(...batchReports.map(r=>r.shifts));
  const goodPcs=batchReports.reduce((s,r)=>s+r.production.goodPcs,0);
  return {order:order,batches:batchReports,
    production:{goodPcs:goodPcs,target:order.targetQty||0,pct:order.targetQty?Math.min(100,Math.round(goodPcs/order.targetQty*100)):null,batchCount:linked.length},
    materials:computeShiftMaterials(allShifts),waste:computeWaste(allShifts),workers:computeWorkerStats(allShifts)};
}
function buildMonthlyReport(data,batches,orders,monthKey){
  const inMonth=d=>monthKeyOf(d)===monthKey;
  const mainBatches=batches.filter(b=>!b.isSubBatch&&inMonth(b.mfgDate));
  const shiftsInMonth=batches.filter(b=>b.isSubBatch&&inMonth(b.mfgDate));
  const byProduct={};
  mainBatches.forEach(b=>{byProduct[b.product]=(byProduct[b.product]||0)+(b.totalPcs||0);});
  return {monthKey:monthKey,batches:mainBatches,byProduct:byProduct,
    goodPcs:shiftsInMonth.reduce((s,x)=>s+(x.goodPcs||0),0),
    materials:materialUsageInMonth(data,monthKey),waste:computeWaste(shiftsInMonth),workers:computeWorkerStats(shiftsInMonth),
    orders:orders.filter(o=>batches.some(b=>!b.isSubBatch&&b.orderNo===o.orderNo&&inMonth(b.mfgDate)))};
}

// ══ FINANCE — pure computation helpers ═══════════════════════════════════
// Pieces a caps lot actually holds, regardless of how it's tracked (Pcs/Bags/KG) — needed to
// turn a lot-level cost into a per-piece rate for aluminumSelections (always in pcs).
function capsLotTotalPcs(lot){
  if(lot.bags&&lot.bags.length)return lot.bags.reduce((s,b)=>s+(b.qtyUnit==="Pcs"?Number(b.qty)||0:kgToPcs(Number(b.qty)||0,0.405)),0);
  if(lot.unit==="KG")return kgToPcs(Number(lot.qtyReceived)||0,0.405);
  return Number(lot.qtyReceived)||0;
}
// Same as capsLotTotalPcs but for what's still in stock (unused bags / qtyRemaining), not the
// lot's original total — used to show current aluminum caps availability.
function capsLotRemainingPcs(lot){
  if(lot.bags&&lot.bags.length)return lot.bags.filter(b=>!b.used).reduce((s,b)=>s+(b.qtyUnit==="Pcs"?Number(b.qty)||0:kgToPcs(Number(b.qty)||0,ALCAP_WT_KG)),0);
  if(lot.unit==="KG")return kgToPcs(Number(lot.qtyRemaining)||0,ALCAP_WT_KG);
  return Number(lot.qtyRemaining)||0;
}
// Combined aluminum availability: caps already made and sitting in stock, plus how many more
// could still be made from remaining Aluminum Coils weight — so it's clear when coil stock is
// running low relative to what's actually needed, in the same pcs unit as everything else.
function buildAluminumAvailability(data){
  const capsLots=(data["Aluminum Caps"]&&data["Aluminum Caps"].lots)||[];
  const coilLots=(data["Aluminum Coils"]&&data["Aluminum Coils"].lots)||[];
  const madeCapsPcs=capsLots.reduce((s,l)=>s+capsLotRemainingPcs(l),0);
  const coilKgRemaining=coilLots.reduce((s,l)=>s+(Number(l.qtyRemaining)||0),0);
  const makeableCapsPcs=coilKgRemaining*COIL_KG_TO_CAPS;
  return {madeCapsPcs:madeCapsPcs,coilKgRemaining:coilKgRemaining,makeableCapsPcs:makeableCapsPcs,
    totalAvailablePcs:madeCapsPcs+makeableCapsPcs};
}
// Cost per piece for an Aluminum Caps lot. Lots made after costPerPc was introduced already
// carry it; older lots don't, but the coil they came from is still traceable via its usageLog
// ("Stamped into <lotNumber>", recorded when the caps lot was created) — so derive it the same
// way, on the fly, rather than leaving every pre-existing lot uncosted.
function deriveCapsCost(lot,coilLots){
  if(lot.costPerPc){
    const srcCoil=lot.sourceCoilLotNo?coilLots.filter(c=>c.lotNumber===lot.sourceCoilLotNo)[0]:null;
    return {costPerPc:Number(lot.costPerPc),currency:lot.unitCostCurrency||"USD",scrapKg:Number(lot.scrapKg)||0,
      usdToEgpRate:srcCoil&&srcCoil.usdToEgpRate?Number(srcCoil.usdToEgpRate):null};
  }
  for(let i=0;i<coilLots.length;i++){
    const coil=coilLots[i];
    const entry=(coil.usageLog||[]).filter(e=>(e.reason||"").indexOf("Stamped into "+lot.lotNumber)===0)[0];
    if(entry&&coil.unitCost){
      const weightTaken=Math.abs(Number(entry.qtyUsed))||0;
      const totalPcs=capsLotTotalPcs(lot);
      if(totalPcs<=0)return null;
      return {costPerPc:(weightTaken*Number(coil.unitCost))/totalPcs,currency:coil.unitCostCurrency||"USD",scrapKg:weightTaken*0.274,
        usdToEgpRate:coil.usdToEgpRate?Number(coil.usdToEgpRate):null};
    }
  }
  return null;
}
// Material cost for one batch. Flip-Off Caps and Silica Gel Sachets are entirely different
// materials, priced completely separately — Flip-Off from Plastic Material + Aluminum Caps
// (via the coil each lot was stamped from); Silica Gel Sachets from the Silica Gel + Sachets
// Paper (rolls) lots each shift actually drew from. Costs are kept split by currency rather
// than guessing an exchange rate.
function buildBatchCost(batch,batches,data,laborRates){
  const rates=Object.assign({},DEFAULT_LABOR_RATES,laborRates);
  const shifts=batches.filter(b=>b.isSubBatch&&b.parentBatchNo===batch.batchNo);
  const isSilica=batch.product==="Silica Gel Sachets";
  const plasticLots=(data["Plastic Material"]&&data["Plastic Material"].lots)||[];
  const capsLots=(data["Aluminum Caps"]&&data["Aluminum Caps"].lots)||[];
  const coilLots=(data["Aluminum Coils"]&&data["Aluminum Coils"].lots)||[];
  const scrapLots=(data["Aluminum Scrap"]&&data["Aluminum Scrap"].lots)||[];
  const silicaGelLots=(data["Silica Gel"]&&data["Silica Gel"].lots)||[];
  const rollsLots=(data["Sachets Paper"]&&data["Sachets Paper"].lots)||[];
  const cartonsLots=(data["Cartons"]&&data["Cartons"].lots)||[];

  const plasticCost={};let plasticBagsCosted=0,plasticBagsUncosted=0,regrindKgTotal=0;
  const alCost={};let alPcsCosted=0,alPcsUncosted=0,scrapKgForBatch=0;
  let alCostEGP=0,alPcsRealRate=0,alPcsFallbackRate=0,alPcsNoRate=0,avgAlRateEGP=0,alPcsAssumed=0;
  const silicaCost={};let silicaKgCosted=0,silicaKgUncosted=0;
  const rollsCost={};let rollsCosted=0,rollsUncosted=0;
  const cartonsCost={};let cartonsCosted=0,cartonsUncosted=0,cartonsCostEGP=0;
  let silicaCostEGP=0,rollsCostEGP=0;
  // USD-priced material converts to EGP the same way everywhere: the lot's own purchase-time
  // rate when set, otherwise Finance's fallback rate. Cartons apply to both products, so this
  // is shared rather than declared inside the isSilica/Flip-Off branches below.
  const fallbackRate=Number(rates.usdToEgpFallbackRate)||0;

  if(isSilica){
    shifts.forEach(s=>{
      const kg=s.silicaKg||0;
      if(kg>0){
        const lot=s.silicaLotId?silicaGelLots.filter(l=>l.id===s.silicaLotId)[0]:null;
        if(lot&&lot.unitCost){
          const cur=lot.unitCostCurrency||"EGP";
          const lineCost=kg*Number(lot.unitCost);
          silicaCost[cur]=(silicaCost[cur]||0)+lineCost;
          silicaKgCosted+=kg;
          if(cur==="EGP")silicaCostEGP+=lineCost;
          else if(lot.usdToEgpRate)silicaCostEGP+=lineCost*Number(lot.usdToEgpRate);
          else if(fallbackRate>0)silicaCostEGP+=lineCost*fallbackRate;
        }else silicaKgUncosted+=kg;
      }
      const rolls=s.rollsUsed||0;
      if(rolls>0){
        const lot=s.rollsLotId?rollsLots.filter(l=>l.id===s.rollsLotId)[0]:null;
        if(lot&&lot.unitCost){
          const cur=lot.unitCostCurrency||"EGP";
          const lineCost=rolls*Number(lot.unitCost);
          rollsCost[cur]=(rollsCost[cur]||0)+lineCost;
          rollsCosted+=rolls;
          if(cur==="EGP")rollsCostEGP+=lineCost;
          else if(lot.usdToEgpRate)rollsCostEGP+=lineCost*Number(lot.usdToEgpRate);
          else if(fallbackRate>0)rollsCostEGP+=lineCost*fallbackRate;
        }else rollsUncosted+=rolls;
      }
    });
  }else{
    shifts.forEach(s=>{
      regrindKgTotal+=s.regrindKg||0;
      const bags=s.virginBags||0;if(bags<=0)return;
      const lot=s.plasticLotId?plasticLots.filter(l=>l.id===s.plasticLotId)[0]:null;
      if(lot&&lot.unitCost){
        const cur=lot.unitCostCurrency||"EGP";
        plasticCost[cur]=(plasticCost[cur]||0)+bags*Number(lot.unitCost);
        plasticBagsCosted+=bags;
      }else plasticBagsUncosted+=bags;
    });

    // alCostEGP converts non-EGP aluminum cost using each coil's own purchase-time rate when
    // set, falling back to Finance's fallback rate otherwise — tracked separately so it's clear
    // which pcs got a real rate vs the fallback, rather than blending them silently.
    shifts.forEach(s=>{
      (s.aluminumSelections||[]).forEach(sel=>{
        const lot=capsLots.filter(l=>l.lotNumber===sel.lotNo)[0];
        const pcs=sel.pcs||0;
        const derived=lot?deriveCapsCost(lot,coilLots):null;
        if(derived){
          const cur=derived.currency;
          const lineCost=pcs*derived.costPerPc;
          alCost[cur]=(alCost[cur]||0)+lineCost;
          alPcsCosted+=pcs;
          if(derived.scrapKg){
            const lotPcs=capsLotTotalPcs(lot);
            if(lotPcs>0)scrapKgForBatch+=derived.scrapKg*(pcs/lotPcs);
          }
          if(cur==="EGP"){alCostEGP+=lineCost;alPcsRealRate+=pcs;}
          else if(derived.usdToEgpRate){alCostEGP+=lineCost*derived.usdToEgpRate;alPcsRealRate+=pcs;}
          else if(fallbackRate>0){alCostEGP+=lineCost*fallbackRate;alPcsFallbackRate+=pcs;}
          else alPcsNoRate+=pcs;
        }else alPcsUncosted+=pcs;
      });
    });
    // Pcs with no traceable cost (e.g. caps made before costing was tracked) get priced at this
    // batch's own average rate for the pcs that WERE costed, instead of silently contributing
    // nothing to the total — closer to the real cost than treating them as free.
    avgAlRateEGP=alPcsCosted>0?alCostEGP/alPcsCosted:0;
    alPcsAssumed=alPcsUncosted>0&&avgAlRateEGP>0?alPcsUncosted:0;
    if(alPcsAssumed>0)alCostEGP+=alPcsAssumed*avgAlRateEGP;
  }

  // Cartons — packaging, priced the same way as Plastic/Aluminum/Silica/Rolls above. Applies
  // to both products (Flip-Off draws them at Final Sorting, Silica on the shift itself), so
  // this runs once here instead of being duplicated inside the isSilica/Flip-Off branches.
  shifts.forEach(s=>{
    const ct=s.cartonsUsed||0;if(ct<=0)return;
    const lot=s.cartonsLotId?cartonsLots.filter(l=>l.id===s.cartonsLotId)[0]:null;
    if(lot&&lot.unitCost){
      const cur=lot.unitCostCurrency||"EGP";
      const lineCost=ct*Number(lot.unitCost);
      cartonsCost[cur]=(cartonsCost[cur]||0)+lineCost;
      cartonsCosted+=ct;
      if(cur==="EGP")cartonsCostEGP+=lineCost;
      else if(lot.usdToEgpRate)cartonsCostEGP+=lineCost*Number(lot.usdToEgpRate);
      else if(fallbackRate>0)cartonsCostEGP+=lineCost*fallbackRate;
    }else cartonsUncosted+=ct;
  });

  // Rejected pcs (Plastic Sorting + Final Sorting rejects) already consumed real plastic/
  // aluminum/labor before being rejected — that spend doesn't come back, so it's already fully
  // counted in the material/labor totals above (material and labor are costed at time of use,
  // not reduced for a later reject outcome). This is just surfacing how much of that sunk cost
  // is attributable to rejects, for visibility.
  const rejectedPcsTotal=isSilica?0:shifts.reduce((s,x)=>s+(x.rejectedPcs||0)+(x.finalRejectedPcs||0),0);

  let scrapQtySold=0,scrapRevenue=0;
  scrapLots.forEach(lot=>(lot.usageLog||[]).forEach(e=>{
    if(e.qtyUsed>0&&e.saleRevenue!=null){scrapQtySold+=Number(e.qtyUsed);scrapRevenue+=Number(e.saleRevenue);}
  }));
  // Fall back to a stated assumed rate when there's no real sale history yet, so the credit
  // isn't just blank — clearly flagged so it isn't mistaken for a measured figure. Scrap is an
  // aluminum-only concept, so it never applies to Silica Gel Sachets batches.
  const scrapRateIsAssumed=scrapQtySold<=0;
  const avgScrapRateEGP=scrapRateIsAssumed?DEFAULT_SCRAP_RATE_EGP:scrapRevenue/scrapQtySold;
  const estScrapCreditEGP=isSilica?0:scrapKgForBatch*avgScrapRateEGP;

  // Labor — Flip-Off Caps splits into 4 real stages (Injection/Sorting/Press/Assembly), each
  // its own machine or person; Silica Gel Sachets is just one person tending the machine, paid
  // a flat rate per shift regardless of pcs, so it's a single line instead.
  let injectionShifts=0,sortingPcs=0,assemblyPcs=0,pressPcs=0;
  let laborInjectionEGP=0,laborSortingEGP=0,laborAssemblyEGP=0,laborPressEGP=0,laborSilicaEGP=0;
  // Carryovers (leftover finished sachets from another batch) never had a machine shift here —
  // that labor was already counted wherever they were actually produced, so counting it again
  // would double-charge the same labor across two batches.
  const silicaShiftsCount=isSilica?shifts.filter(s=>!s.isCarryover).length:0;
  if(isSilica){
    laborSilicaEGP=silicaShiftsCount*(Number(rates.silicaLaborCostPerShift)||0);
  }else{
    // Injection by how many shifts this batch ran; Plastic Sorting and Assembly by how many
    // pcs actually went through that stage (sorting handles both accepted and rejected pcs);
    // Press by how many pcs of aluminum caps this batch actually consumed (Press stamps the
    // coil into caps — a different machine/person than Assembly). Carryovers (from another
    // batch, or from WIP Inventory stock) are excluded from sorting/assembly — that material
    // already had its own labor counted wherever it was actually produced, so counting it
    // again here would double-charge the same labor across two batches.
    injectionShifts=shifts.filter(s=>s.injections).length;
    sortingPcs=shifts.reduce((s,x)=>x.isCarryover?s:s+(x.acceptedPcs!=null?(x.acceptedPcs||0)+(x.rejectedPcs||0):0),0);
    assemblyPcs=shifts.reduce((s,x)=>x.isCarryover?s:s+(x.assembledPcs||0),0);
    pressPcs=alPcsCosted+alPcsUncosted;
    laborInjectionEGP=injectionShifts*(Number(rates.injectionCostPerShift)||0);
    laborSortingEGP=sortingPcs*(Number(rates.sortingCostPerPc)||0);
    // Real wages when Assembly workers were actually picked on a shift; the flat
    // assemblyDefaultShiftEGP when the picker was used but nobody was picked (unrecorded free
    // double duty); the old flat per-pc estimate only for shifts saved before this was tracked
    // at all (assemblyWorkers still undefined) — see the DEFAULT_LABOR_RATES comment above.
    laborAssemblyEGP=shifts.reduce((s,x)=>{
      if(x.isCarryover)return s;
      if(x.assemblyWorkers==null)return s+(x.assembledPcs||0)*(Number(rates.assemblyCostPerPc)||0);
      if(x.assemblyWorkers.length===0)return s+(Number(rates.assemblyDefaultShiftEGP)||0);
      return s+x.assemblyWorkers.reduce((ws,w)=>ws+(Number(w.wage)||0),0);
    },0);
    laborPressEGP=pressPcs*(Number(rates.pressCostPerPc)||0);
  }
  const laborTotalEGP=laborInjectionEGP+laborSortingEGP+laborAssemblyEGP+laborPressEGP+laborSilicaEGP;

  const netEGP=(plasticCost.EGP||0)+silicaCostEGP+rollsCostEGP+cartonsCostEGP+laborTotalEGP+alCostEGP-estScrapCreditEGP;

  // Revenue/profit — priced by the batch's own set quantity (totalPcs), not by however
  // many pcs actually came out of production. sellPricePerPc is set manually per batch.
  // Cost defaults to the auto-computed netEGP above, but can be overridden per batch with
  // a manual estimate (estCostEGP) — useful when material/labor tracking is incomplete.
  const goodPcsTotal=shifts.reduce((s,x)=>s+(x.goodPcs||0),0);
  const revenuePcs=Number(batch.totalPcs)||0;
  const sellPricePerPc=Number(batch.sellPricePerPc)||0;
  // A Rejected batch is never going to be sold — the material/labor cost already happened and
  // won't come back, but there's no revenue to offset it, so it's a full loss (not priced as if
  // it were a normal sale even if a sell price had been set for it).
  const isRejected=batch.status==="Rejected";
  const revenueEGP=isRejected?0:sellPricePerPc*revenuePcs;
  const estCostEGP=Number(batch.estCostEGP)||0;
  const costEGP=estCostEGP>0?estCostEGP:netEGP;
  const profitEGP=revenueEGP-costEGP;
  const marginPct=revenueEGP>0?profitEGP/revenueEGP*100:null;

  return {batch:batch,isSilica:isSilica,plasticCost:plasticCost,plasticBagsCosted:plasticBagsCosted,plasticBagsUncosted:plasticBagsUncosted,
    regrindKgTotal:regrindKgTotal,alCost:alCost,alPcsCosted:alPcsCosted,alPcsUncosted:alPcsUncosted,
    alCostEGP:alCostEGP,alPcsRealRate:alPcsRealRate,alPcsFallbackRate:alPcsFallbackRate,alPcsNoRate:alPcsNoRate,
    alPcsAssumed:alPcsAssumed,avgAlRateEGP:avgAlRateEGP,
    silicaCost:silicaCost,silicaKgCosted:silicaKgCosted,silicaKgUncosted:silicaKgUncosted,silicaCostEGP:silicaCostEGP,
    rollsCost:rollsCost,rollsCosted:rollsCosted,rollsUncosted:rollsUncosted,rollsCostEGP:rollsCostEGP,
    cartonsCost:cartonsCost,cartonsCosted:cartonsCosted,cartonsUncosted:cartonsUncosted,cartonsCostEGP:cartonsCostEGP,
    scrapKgForBatch:scrapKgForBatch,avgScrapRateEGP:avgScrapRateEGP,scrapRateIsAssumed:scrapRateIsAssumed,estScrapCreditEGP:estScrapCreditEGP,
    rejectedPcsTotal:rejectedPcsTotal,
    injectionShifts:injectionShifts,sortingPcs:sortingPcs,assemblyPcs:assemblyPcs,pressPcs:pressPcs,silicaShiftsCount:silicaShiftsCount,
    laborInjectionEGP:laborInjectionEGP,laborSortingEGP:laborSortingEGP,laborAssemblyEGP:laborAssemblyEGP,laborPressEGP:laborPressEGP,laborSilicaEGP:laborSilicaEGP,laborTotalEGP:laborTotalEGP,
    netEGP:netEGP,goodPcsTotal:goodPcsTotal,revenuePcs:revenuePcs,
    sellPricePerPc:sellPricePerPc,revenueEGP:revenueEGP,estCostEGP:estCostEGP,costEGP:costEGP,profitEGP:profitEGP,marginPct:marginPct,isRejected:isRejected};
}

const PRODUCT_META={
  "Flip-Off Caps 20mm":{code:"FO",variantLabel:"Cap Colour",sizes:null,lines:null},
  "Silica Gel Capsules":{code:"SC",variantLabel:"Size",sizes:["0.3g","0.5g","1g"],lines:["Line 1","Line 2","Line 3"]},
  "Silica Gel Sachets":{code:"SS",variantLabel:"Size",sizes:["0.5g","1g","5g","10g"],lines:["Line 1","Line 2"]},
};
const PRODUCTS=Object.keys(PRODUCT_META);
// Known Pcs-per-Bag packaging convention per Silica Gel Sachets size — pre-fills Pcs per Bag
// on Create Batch when that size is picked, still editable per batch.
const SACHET_PCS_PER_BAG={"0.5g":2000};
function nextOrdNo(os){const p="EPS-ORD-"+pad(getYr(),2);const ns=os.filter(o=>o.orderNo.indexOf(p)===0).map(o=>parseInt(o.orderNo.slice(p.length))||0);return p+pad(ns.length?Math.max.apply(null,ns)+1:1,4);}

function CheckBadge({actual,expected}){
  if(!actual||!expected)return null;
  const pct=diffPct(actual,expected),ok=pct<5,warn=pct<10;
  return <span style={{background:ok?"#C6EFCE":warn?"#FFF3CD":"#FDDEDE",color:ok?"#1A6B2A":warn?"#856404":"#8B1A1A",borderRadius:20,padding:"2px 8px",fontSize:10,fontWeight:700,marginLeft:6}}>{ok?"✓":warn?"⚠️":"✗"} {pct.toFixed(1)}%</span>;
}

const INITIAL_LOTS={
  "Aluminum Coils":[1,2,3,4,5,6,7].map((n,i)=>({id:"al-"+n,lotNumber:"4115332662025120016",plNo:"25INC61201",date:"17-Dec-2025",supplier:"Shijiazhuang Yinhe Aluminum Products Co., Ltd",description:"Al Coil – Alloy 8011, H14 – 183×0.20 MM – Both Sides Clear Lacquered",qtyReceived:[899.00,762.40,880.60,880.90,712.00,578.10,213.40][i],unit:"KG",qtyRemaining:[0,762.40,880.60,0,0,578.10,0][i],unitCost:4.2526,unitCostCurrency:"USD",status:[0,762.40,880.60,0,0,578.10,0][i]>0?"In Stock":"Out of Stock",notes:"Package "+n+"/7",image:null,usageLog:[],totalCoils:n===4?5:"",coilsUsed:0})),
  "Aluminum Caps":[
    {id:"ac-0",lotNumber:"EPS-AL-260001",plNo:"EPS-AL-260001",date:"08-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | First run",qtyReceived:73000,unit:"Pcs",qtyRemaining:73000,unitCost:"",status:"In Stock",notes:"73,000 pcs | Operator: Yasser Shoukry",image:null,usageLog:[]},
    {id:"ac-1",lotNumber:"EPS-AL-260002",plNo:"EPS-AL-260002",date:"19-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 4",qtyReceived:25,unit:"Bags",qtyRemaining:15,unitCost:"",status:"In Stock",notes:"124.05 KG total | Yasser Shoukry",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260002",25,5.00,"KG",{"B24":3.84,"B25":5.21}),10,"19-Jul-2026")},
    {id:"ac-2",lotNumber:"EPS-AL-260003",plNo:"EPS-AL-260003",date:"16-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 4",qtyReceived:16,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"336,000 pcs total",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260003",16,21000,"Pcs"),16,"16-Jul-2026")},
    {id:"ac-3",lotNumber:"EPS-AL-260004",plNo:"EPS-AL-260004",date:"19-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 4",qtyReceived:21,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"316,074 pcs | 7 coils",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260004",21,15000,"Pcs",{"B21":16074}),21,"19-Jul-2026")},
    {id:"ac-4",lotNumber:"EPS-AL-260005",plNo:"EPS-AL-260005",date:"21-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 4",qtyReceived:21,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"317,316 pcs | Coil 4",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260005",21,15000,"Pcs",{"B21":17316}),21,"21-Jul-2026")},
    {id:"ac-5",lotNumber:"EPS-AL-260006",plNo:"EPS-AL-260006",date:"22-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 7",qtyReceived:15,unit:"Bags",qtyRemaining:14,unitCost:"",status:"In Stock",notes:"216,780 pcs | Coil 31",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260006",15,15000,"Pcs",{"B15":6780}),1,"22-Jul-2026")},
    {id:"ac-6",lotNumber:"EPS-AL-260007",plNo:"EPS-AL-260007",date:"27-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 7",qtyReceived:12,unit:"Bags",qtyRemaining:12,unitCost:"",status:"In Stock",notes:"179,100 pcs | Coil 32",image:null,usageLog:[],bags:makeBags("EPS-AL-260007",12,15000,"Pcs",{"B12":14100})},
    {id:"ac-7",lotNumber:"EPS-AL-260008",plNo:"EPS-AL-260008",date:"27-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 1",qtyReceived:21,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"315,000 pcs | Coil 5",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260008",21,15000,"Pcs"),21,"27-Jul-2026")},
    {id:"ac-8",lotNumber:"EPS-AL-260009",plNo:"EPS-AL-260009",date:"28-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 1",qtyReceived:23,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"338,910 pcs | Coil 4",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260009",23,15000,"Pcs",{"B23":8910}),23,"28-Jul-2026")},
    {id:"ac-9",lotNumber:"EPS-AL-260010",plNo:"EPS-AL-260010",date:"30-Jul-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 1",qtyReceived:23,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"340,200 pcs | Coil 3",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260010",23,15000,"Pcs",{"B23":10200}),23,"30-Jul-2026")},
    {id:"ac-10",lotNumber:"EPS-AL-260011",plNo:"EPS-AL-260011",date:"03-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 1",qtyReceived:21,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"312,420 pcs | Coil 1",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260011",21,15000,"Pcs",{"B21":12420}),21,"03-Aug-2026")},
    {id:"ac-11",lotNumber:"EPS-AL-260012",plNo:"EPS-AL-260012",date:"04-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171 | Box 1",qtyReceived:21,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"312,720 pcs | Coil 1",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260012",21,15000,"Pcs",{"B21":12720}),21,"04-Aug-2026")},
    {id:"ac-12",lotNumber:"EPS-AL-260013",plNo:"EPS-AL-260013",date:"05-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171",qtyReceived:15,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"215,550 pcs | Coil 24",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260013",15,15000,"Pcs",{"B15":5550}),15,"05-Aug-2026")},
    {id:"ac-13",lotNumber:"EPS-AL-260014",plNo:"EPS-AL-260014",date:"05-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171",qtyReceived:15,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"215,550 pcs | Coil 25",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260014",15,15000,"Pcs",{"B15":5550}),15,"05-Aug-2026")},
    {id:"ac-14",lotNumber:"EPS-AL-260015",plNo:"EPS-AL-260015",date:"10-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171",qtyReceived:20,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"297,480 pcs | Coil 23",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260015",20,15000,"Pcs",{"B19":13740,"B20":13740}),20,"10-Aug-2026")},
    {id:"ac-15",lotNumber:"EPS-AL-260016",plNo:"EPS-AL-260016",date:"11-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171",qtyReceived:19,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"284,460 pcs | Coil 22",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260016",19,15000,"Pcs",{"B19":14460}),19,"11-Aug-2026")},
    {id:"ac-16",lotNumber:"EPS-AL-260017",plNo:"EPS-AL-260017",date:"12-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171",qtyReceived:19,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"283,800 pcs | Coil 21",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260017",19,15000,"Pcs",{"B19":13800}),19,"12-Aug-2026")},
    {id:"ac-17",lotNumber:"EPS-AL-260018",plNo:"EPS-AL-260018",date:"13-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171",qtyReceived:19,unit:"Bags",qtyRemaining:13,unitCost:"",status:"In Stock",notes:"283,800 pcs | Coil 9",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260018",19,15000,"Pcs",{"B19":13800}),6,"13-Aug-2026")},
    {id:"ac-18",lotNumber:"EPS-AL-260019",plNo:"EPS-AL-260019",date:"17-Aug-2026",supplier:"In-house production",description:"20mm Flip-Off Aluminum Caps – Coil lot 2512171",qtyReceived:19,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"288,600 pcs",image:null,usageLog:[],bags:markUsed(makeBags("EPS-AL-260019",19,15000,"Pcs",{"B19":18600}),19,"17-Aug-2026")},
  ],
  "Aluminum Scrap":[
    {id:"scrap-pool",lotNumber:"SCRAP-POOL",plNo:"",date:"21-Aug-2026",supplier:"In-house (byproduct)",description:"Aluminum scrap collected from coil stamping",qtyReceived:741.26,unit:"KG",qtyRemaining:741.26,unitCost:"",unitCostCurrency:"EGP",status:"In Stock",notes:"Backfilled — coils used before scrap tracking existed. Running total — sell down via Sell Scrap",image:null,usageLog:[
      {id:"scrap-hist-al1",date:"21-Aug-2026",qtyUsed:-246.33,reason:"Coil al-1 (899.00 KG used) — backfilled, pre-tracking",remainingAfter:246.33},
      {id:"scrap-hist-al4",date:"21-Aug-2026",qtyUsed:-241.37,reason:"Coil al-4 (880.90 KG used) — backfilled, pre-tracking",remainingAfter:487.70},
      {id:"scrap-hist-al5",date:"21-Aug-2026",qtyUsed:-195.09,reason:"Coil al-5 (712.00 KG used) — backfilled, pre-tracking",remainingAfter:682.79},
      {id:"scrap-hist-al7",date:"21-Aug-2026",qtyUsed:-58.47,reason:"Coil al-7 (213.40 KG used) — backfilled, pre-tracking",remainingAfter:741.26},
    ]},
  ],
  "Plastic Material":[
    {id:"pm-1",lotNumber:"56647874",plNo:"",date:"",supplier:"",description:"Virgin Plastic Material",qtyReceived:0,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"Recovered from prior data — receipt details incomplete",image:null,usageLog:[]},
    {id:"pm-2",lotNumber:"56647874",plNo:"",date:"",supplier:"",description:"Virgin Plastic Material",qtyReceived:0,unit:"Bags",qtyRemaining:0,unitCost:"",status:"Out of Stock",notes:"Recovered from prior data — receipt details incomplete",image:null,usageLog:[]},
    {id:"pm-3",lotNumber:"56647874",plNo:"",date:"",supplier:"",description:"Virgin Plastic Material",qtyReceived:57,unit:"Bags",qtyRemaining:57,unitCost:1725,unitCostCurrency:"EGP",status:"In Stock",notes:"Recovered from prior data — receipt details incomplete",image:null,usageLog:[]},
    {id:"pm-4",lotNumber:"EPS-PM-260001",plNo:"",date:"06-Sep-2026",supplier:"",description:"Virgin Plastic Material",qtyReceived:80,unit:"Bags",qtyRemaining:80,unitCost:1725,unitCostCurrency:"EGP",status:"In Stock",notes:"New shipment — 2 tons (80 bags × 25 KG)",image:null,usageLog:[]},
  ],
  "Sachets Paper":[
    {id:"sp-1",lotNumber:"126020237",plNo:"WE26031002",date:"10-Mar-2026",supplier:"Jia Xing Lucky Moon Packaging Material Co., Ltd",description:"TNK30//PE25 1G – 50MM×1000M",qtyReceived:547,unit:"Rolls",qtyRemaining:547,unitCost:11.00,unitCostCurrency:"USD",status:"In Stock",notes:"Pallet 1/2 | 27,000 m²",image:null,usageLog:[]},
    {id:"sp-2",lotNumber:"126020237",plNo:"WE26031002",date:"10-Mar-2026",supplier:"Jia Xing Lucky Moon Packaging Material Co., Ltd",description:"TNK30//PE25 1G – 50MM×1000M",qtyReceived:51,unit:"Rolls",qtyRemaining:48,unitCost:11.00,unitCostCurrency:"USD",status:"In Stock",notes:"Pallet 2/2 (partial)",image:null,usageLog:[{id:"sp-2-hist1",date:"19-Aug-2026",qtyUsed:3,reason:"Recovered usage",remainingAfter:48}]},
    {id:"sp-3",lotNumber:"126020236",plNo:"WE26031002",date:"10-Mar-2026",supplier:"Jia Xing Lucky Moon Packaging Material Co., Ltd",description:"TNK30//PE25 0.5G – 44MM×1000M",qtyReceived:226,unit:"Rolls",qtyRemaining:185,unitCost:9.68,unitCostCurrency:"USD",status:"In Stock",notes:"1 Pallet | 9,944 m²",image:null,usageLog:[{id:"sp-3-hist1",date:"19-Aug-2026",qtyUsed:41,reason:"Recovered usage",remainingAfter:185}]},
    {id:"sp-4",lotNumber:"126020236",plNo:"WE26031002",date:"10-Mar-2026",supplier:"Jia Xing Lucky Moon Packaging Material Co., Ltd",description:"TNK30//PE25 10G – 90MM×1000M",qtyReceived:9,unit:"Rolls",qtyRemaining:9,unitCost:19.80,unitCostCurrency:"USD",status:"In Stock",notes:"810 m²",image:null,usageLog:[]},
  ],
  "Silica Gel":[
    {id:"sg-1",lotNumber:"YM0120260120",plNo:"YM012026012C",date:"20-Jan-2026",supplier:"Dongying Yiming New Materials Co., Ltd",description:"Silica Gel Beaded Type A – 25 KG/bag",qtyReceived:16000,unit:"KG",qtyRemaining:15350,unitCost:0.95,unitCostCurrency:"USD",status:"In Stock",notes:"640 packages × 25 KG",image:null,usageLog:[{id:"sg-1-hist1",date:"19-Aug-2026",qtyUsed:650,reason:"Recovered usage",remainingAfter:15350}]},
  ],
  "WIP Inventory":[
    {id:"wip-ss-05g-1",lotNumber:"WIP-SS-0.5G-001",plNo:"",date:"03-Sep-2026",supplier:"",description:"Silica Gel Sachets — Finished — 0.5g",qtyReceived:48000,unit:"Pcs",qtyRemaining:48000,unitCost:"",status:"In Stock",notes:"Existing inventory — added directly",image:null,usageLog:[]},
  ],
  "Cartons":[
    {id:"ctn-1",lotNumber:"EPS-CTN-260001",plNo:"",date:"01-Sep-2026",supplier:"",description:"Corrugated Carton – 30×38×58 cm",qtyReceived:1000,unit:"Cartons",qtyRemaining:1000,unitCost:32.5,unitCostCurrency:"EGP",status:"In Stock",notes:"",image:null,usageLog:[]},
  ],
};

const mkB=(id,no,st,col,c,bpc,ppb,mfg,cl,ord,notes,prod)=>({id:id,batchNo:no,isSubBatch:false,parentBatchNo:null,product:prod||"Flip-Off Caps 20mm",status:st,color:col,cartons:c,bagsPerCarton:bpc,pcsPerBag:ppb,partialCartonBags:0,totalPcs:c*bpc*ppb,mfgDate:mfg,client:cl,orderNo:ord,notes:notes||"",createdAt:mfg});
// Recovered shift (sub-batch) — weights not directly captured in the old artifact's summary
// view are back-derived from the piece counts using the app's own conversion constants, so
// everything stays internally consistent even though it's an approximation of what was typed in.
const mkShift=(id,letter,date,shift,inj,vBags,regrindKg,sortedPcs,alLots,asmPcs,packedPcs)=>{
  const theoPcs=inj*PCS_INJ,theoKg=pcsToKg(theoPcs,CAP_WT);
  const vKg=vBags*PLASTIC_BAG_KG,totalPlastic=vKg+regrindKg;
  return{id:id,batchNo:"EPS-FO-260013-"+letter,isSubBatch:true,parentBatchNo:"EPS-FO-260013",product:"Flip-Off Caps 20mm",status:"Complete",stage:"Complete",color:"Blue",client:"Pharco",orderNo:"EPS-ORD-260012",cartons:0,bagsPerCarton:0,pcsPerBag:0,partialCartonBags:0,totalPcs:packedPcs,mfgDate:date,shift:shift,operator:"",injections:inj,theoreticalPcs:theoPcs,theoreticalKg:theoKg,plasticLotId:null,plasticLotNo:null,virginBags:vBags,virginKg:vKg,regrindKg:regrindKg,totalPlasticKg:totalPlastic,regrindPct:totalPlastic>0?(regrindKg/totalPlastic*100):0,weightBeforeSorting:theoKg,notes:"Recovered from prior data — operator and exact weights approximated",createdAt:date,acceptedWeightKg:pcsToKg(sortedPcs,CAP_WT),rejectedWeightKg:0,acceptedPcs:sortedPcs,rejectedPcs:0,sortingDate:date,aluminumSelections:[],aluminumLotNo:alLots||null,aluminumPcsIn:null,assembledWeightKg:pcsToKg(asmPcs,ASM_WT),assembledPcs:asmPcs,assemblyDate:date,finalSortDate:date,finalSortOperator:"",finalAcceptedKg:pcsToKg(packedPcs,ASM_WT),finalRejectedKg:0,finalAcceptedPcs:packedPcs,finalRejectedPcs:0,goodPcs:packedPcs};
};
const SHIFTS_260013=[
  mkShift("fo13-a","A","2026-08-12","Night",2633,5,37.5,125625,null,122785,123827),
  mkShift("fo13-b","B","2026-08-13","Morning",2665,1,125.0,150963,"EPS-AL-260016",149208,149208),
  mkShift("fo13-c","C","2026-08-13","Night",2368,5,0.0,111021,"EPS-AL-260019, EPS-AL-260016",107367,108073),
  mkShift("fo13-d","D","2026-08-14","Morning",2400,7,0.0,139075,"EPS-AL-260019, EPS-AL-260017",138010,138010),
  mkShift("fo13-e","E","2026-08-14","Night",2609,6,0.0,138954,"EPS-AL-260017",137194,136875),
  mkShift("fo13-f","F","2026-08-15","Morning",2537,1,125.0,122982,"EPS-AL-260017, EPS-AL-260019",112069,110742),
  mkShift("fo13-g","G","2026-08-15","Night",2306,3,75.0,94182,"EPS-AL-260019",91997,92705),
];
const INITIAL_BATCHES=[
  mkB("fo-1","EPS-FO-260001","Shipped","",1,2,1000,"2026-04-19","Sedico","EPS-ORD-260008","Samples"),
  mkB("fo-2","EPS-FO-260002","Shipped","",1,1,1000,"2026-04-22","MEVAC","EPS-ORD-260007","Samples"),
  mkB("fo-3","EPS-FO-260003","Shipped","Blue",5,2,5000,"2026-06-10","MEVAC","EPS-ORD-260006",""),
  mkB("fo-4","EPS-FO-260004","Shipped","Brown",5,2,5000,"2026-06-10","","EPS-ORD-260005",""),
  mkB("fo-5","EPS-FO-260005","Shipped","Green",1,1,2000,"2026-06-21","Global Napi","EPS-ORD-260004",""),
  mkB("fo-6","EPS-FO-260006","Shipped","Pink",1,1,100,"2026-06-24","MEVAC","EPS-ORD-260003",""),
  mkB("fo-7","EPS-FO-260007","Shipped","Green",2,6,2000,"2026-07-05","Global Napi","EPS-ORD-260010",""),
  mkB("fo-8","EPS-FO-260008","Shipped","Blue",20,2,5000,"2026-07-11","Pharco","EPS-ORD-260012",""),
  mkB("fo-9","EPS-FO-260009","Shipped","Blue",15,2,5000,"2026-07-22","Pharco","EPS-ORD-260012",""),
  mkB("fo-10","EPS-FO-260010","Shipped","Light Blue",100,2,5000,"2026-07-23","Rameda",null,""),
  mkB("fo-11","EPS-FO-260011","Shipped","Blue",35,2,5000,"2026-08-02","Pharco","EPS-ORD-260012",""),
  mkB("fo-12","EPS-FO-260012","Shipped","Blue",110,2,5000,"2026-08-06","Pharco","EPS-ORD-260012",""),
  mkB("fo-13","EPS-FO-260013","Production","Blue",110,2,5000,"2026-08-12","Pharco","EPS-ORD-260012",""),
  mkB("ss-0","EPS-SS-S260001","Shipped","",1,8,1000,"2026-07-18","","EPS-ORD-260020","Sample","Silica Gel Sachets"),
  mkB("ss-1","EPS-SS-260002","Shipped","",3,20,2000,"2026-07-02","Adwia","EPS-ORD-260009","","Silica Gel Sachets"),
  mkB("ss-2","EPS-SS-260003","Shipped","",3,20,2000,"2026-07-02","Adwia","EPS-ORD-260009","","Silica Gel Sachets"),
  mkB("ss-3","EPS-SS-260004","Shipped","",4,20,2000,"2026-07-05","Adwia","EPS-ORD-260009","","Silica Gel Sachets"),
  mkB("ss-4","EPS-SS-260005","Shipped","",3,20,2000,"2026-07-05","Adwia","EPS-ORD-260009","","Silica Gel Sachets"),
  mkB("ss-5","EPS-SS-260006","Shipped","",6,20,2000,"2026-07-09","Adwia","EPS-ORD-260009","","Silica Gel Sachets"),
  mkB("ss-6","EPS-SS-260007","Shipped","",6,20,2000,"2026-07-09","Adwia","EPS-ORD-260009","","Silica Gel Sachets"),
  mkB("ss-7","EPS-SS-260008","Released","",3,25,2000,"2026-08-10","Organix EG",null,"","Silica Gel Sachets"),
  mkB("ss-8","EPS-SS-260009","Released","",2,25,1000,"2026-08-11","EVA",null,"","Silica Gel Sachets"),
].concat(SHIFTS_260013);
const mkO=(id,no,cl,col,tq,st,notes)=>({id:id,orderNo:no,client:cl,product:"Flip-Off Caps 20mm",color:col,targetQty:tq,deliveryDate:"",status:st,notes:notes||"",createdAt:today()});
const INITIAL_ORDERS=[
  mkO("ord-3","EPS-ORD-260003","MEVAC","Pink",100,"Shipped",""),
  mkO("ord-4","EPS-ORD-260004","Global Napi","Green",2000,"Shipped",""),
  mkO("ord-5","EPS-ORD-260005","","Brown",50000,"Shipped",""),
  mkO("ord-6","EPS-ORD-260006","MEVAC","Blue",50000,"Shipped",""),
  mkO("ord-7","EPS-ORD-260007","MEVAC","",1000,"Shipped","Samples"),
  mkO("ord-8","EPS-ORD-260008","Sedico","",2000,"Shipped","Samples"),
  mkO("ord-9","EPS-ORD-260009","Adwia","",1000000,"Shipped",""),
  mkO("ord-10","EPS-ORD-260010","Global Napi","Green",24000,"Shipped",""),
  mkO("ord-12","EPS-ORD-260012","Pharco","Blue",2000000,"Production","Large Pharco order"),
  mkO("ord-17","EPS-ORD-260017","Rameda","",0,"Production",""),
];

// ══ UI PRIMITIVES ═════════════════════════════════════════════════════════
function SBadge({status,cfg}){
  const map=cfg||STATUS_CONFIG,c=map[status]||map["In Stock"]||{bg:"#eee",text:"#333",dot:"#999"};
  return <span style={{display:"inline-flex",alignItems:"center",gap:5,background:c.bg,color:c.text,borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}><span style={{width:7,height:7,borderRadius:"50%",background:c.dot,flexShrink:0}}/>{status}</span>;
}
function Field({label,value,onChange,type,ph,accent,error}){
  return(<div><label style={{display:"block",fontSize:11,fontWeight:700,color:error?"#DC3545":"#666",marginBottom:4,textTransform:"uppercase",letterSpacing:"0.05em"}}>{label}</label>
    <input type={type||"text"} value={value} onChange={e=>onChange(type==="number"?e.target.value.replace(/,/g,""):e.target.value)} placeholder={ph||""} min="0" step="any" style={{width:"100%",border:"1.5px solid "+(error?"#F1948A":"#E2E8F0"),borderRadius:8,padding:"9px 12px",fontSize:13,outline:"none",boxSizing:"border-box",fontFamily:"inherit"}} onFocus={e=>e.target.style.borderColor=accent||ACCENT} onBlur={e=>e.target.style.borderColor=error?"#F1948A":"#E2E8F0"}/></div>);
}
function ImgUpload({value,onChange,accent}){
  const ref=useRef();
  const handle=e=>{const f=e.target.files[0];if(!f)return;const r=new FileReader();
    r.onload=ev=>{const img=new Image();img.onload=()=>{const max=900;let w=img.width,h=img.height;
      if(w>h&&w>max){h=Math.round(h*max/w);w=max;}else if(h>max){w=Math.round(w*max/h);h=max;}
      const c=document.createElement("canvas");c.width=w;c.height=h;c.getContext("2d").drawImage(img,0,0,w,h);onChange(c.toDataURL("image/jpeg",0.6));};img.src=ev.target.result;};
    r.readAsDataURL(f);};
  return(<div>
    <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:6,textTransform:"uppercase"}}>Packing List Image</label>
    {value?(<div style={{position:"relative",borderRadius:10,overflow:"hidden",border:"1.5px solid #E2E8F0"}}>
      <img src={value} alt="lot" style={{width:"100%",maxHeight:180,objectFit:"cover",display:"block"}}/>
      <button type="button" onClick={()=>onChange(null)} style={{position:"absolute",top:8,right:8,background:"rgba(0,0,0,0.6)",color:"#fff",border:"none",borderRadius:6,padding:"4px 10px",cursor:"pointer",fontSize:12}}>Remove</button></div>)
    :(<div onClick={()=>ref.current.click()} style={{border:"2px dashed #E2E8F0",borderRadius:10,padding:"22px 16px",textAlign:"center",cursor:"pointer",background:"#FAFBFC"}}>
      <div style={{fontSize:26,marginBottom:5}}>📷</div><div style={{fontWeight:700,fontSize:13,color:"#444"}}>Tap to upload</div></div>)}
    <input ref={ref} type="file" accept="image/*" onChange={handle} style={{display:"none"}}/></div>);
}
function BagGrid({bags,matConfig,onToggle,selMode,selected,onSelect}){
  const sel=selected||[];
  if(selMode){
    const avail=bags.filter(b=>!b.used);
    return(<div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
        <div style={{fontSize:12,color:"#555",fontWeight:600}}>{sel.length} of {avail.length} bags selected</div>
        <div style={{display:"flex",gap:6}}>
          <button type="button" onClick={()=>onSelect(avail.map(b=>b.id))} style={{fontSize:11,padding:"3px 9px",borderRadius:6,border:"1px solid #E2E8F0",background:"#fff",cursor:"pointer"}}>All</button>
          <button type="button" onClick={()=>onSelect([])} style={{fontSize:11,padding:"3px 9px",borderRadius:6,border:"1px solid #E2E8F0",background:"#fff",cursor:"pointer"}}>Clear</button></div>
      </div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(95px,1fr))",gap:6,maxHeight:200,overflowY:"auto"}}>
        {avail.map(bag=>{const on=sel.indexOf(bag.id)>=0;
          return(<div key={bag.id} onClick={()=>onSelect(on?sel.filter(x=>x!==bag.id):sel.concat([bag.id]))} style={{background:on?NAVY:"#fff",border:"1.5px solid "+(on?NAVY:"#E2E8F0"),borderRadius:8,padding:"7px 9px",cursor:"pointer"}}>
            <div style={{fontSize:11,fontWeight:700,color:on?"#fff":NAVY}}>{bag.id}</div>
            <div style={{fontSize:11,color:on?"rgba(255,255,255,0.7)":"#888"}}>{fmtN(bag.qty)} {bag.qtyUnit}</div></div>);})}
      </div></div>);
  }
  const rem=bags.filter(b=>!b.used).length;
  return(<div style={{margin:"0 20px 16px"}}>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
      <div style={{fontSize:11,fontWeight:800,color:"#888",textTransform:"uppercase"}}>Bags — tap to toggle</div>
      <div style={{fontSize:12,fontWeight:700,color:rem===0?"#DC3545":matConfig.accent}}>{rem} remaining · {bags.length-rem} used</div></div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(110px,1fr))",gap:8}}>
      {bags.map(bag=>(<div key={bag.id} onClick={()=>onToggle(bag.id)} style={{background:bag.used?"#F5F7FA":matConfig.light,borderRadius:10,padding:"10px",cursor:"pointer",border:"1.5px solid "+(bag.used?"#E2E8F0":matConfig.accent),opacity:bag.used?0.6:1,position:"relative"}}>
        <div style={{position:"absolute",top:5,right:6,fontSize:10,fontWeight:900,color:bag.used?"#DC3545":"#22A03A"}}>{bag.used?"✗":"✓"}</div>
        <div style={{fontSize:11,fontWeight:800,color:bag.used?"#aaa":matConfig.color,textDecoration:bag.used?"line-through":"none"}}>{bag.id}</div>
        <div style={{fontSize:13,fontWeight:900,color:bag.used?"#bbb":matConfig.accent,marginTop:3}}>{fmtN(bag.qty)}</div>
        <div style={{fontSize:10,color:"#888"}}>{bag.qtyUnit}</div>
        {bag.used&&bag.usedDate&&<div style={{fontSize:9,color:"#ccc",marginTop:3}}>{bag.usedDate}</div>}</div>))}
    </div></div>);
}

// ══ INVENTORY MODALS ══════════════════════════════════════════════════════
function UseStockModal({lot,matConfig,onSave,onClose}){
  const bags=isSilica(lot);
  const [qty,setQty]=useState(""),[reason,setReason]=useState(""),[error,setError]=useState("");
  const remKg=Number(lot.qtyRemaining)||0,remBags=remKg/BAG_KG,qtyNum=Number(qty)||0;
  const usedKg=bags?qtyNum*BAG_KG:qtyNum,newRem=Math.max(0,remKg-usedKg);
  const save=()=>{
    if(!qty||qtyNum<=0){setError("Enter a valid quantity.");return;}
    // Tolerate float drift from repeated deductions (e.g. stored 0.0999997 displayed as 0.10),
    // so using exactly what's shown as remaining isn't wrongly rejected as "too much".
    if(bags&&qtyNum>remBags+0.01){setError("Max "+remBags.toLocaleString()+" bags.");return;}
    if(!bags&&usedKg>remKg+0.01){setError("Max "+fmt(remKg)+" "+lot.unit);return;}
    const ns=newRem<=0?"Out of Stock":newRem<=remKg*0.15?"Low Stock":lot.status==="Out of Stock"?"In Stock":lot.status;
    onSave(Object.assign({},lot,{qtyRemaining:newRem,status:ns,usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:usedKg,bagsUsed:bags?qtyNum:null,reason:reason||"Production use",remainingAfter:newRem}])}));
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:420,overflow:"hidden"}}>
      <div style={{background:matConfig.color,padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>Register Stock Usage</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>Lot: {lot.lotNumber}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{background:matConfig.light,borderRadius:10,padding:"12px 16px",marginBottom:18}}>
          <div style={{fontSize:11,color:matConfig.color,fontWeight:700,marginBottom:4}}>Current Stock</div>
          <span style={{fontSize:22,fontWeight:900,color:matConfig.color}}>{bags?remBags.toLocaleString()+" bags":fmt(remKg)+" "+lot.unit}</span></div>
        <div style={{marginBottom:14}}><Field label={bags?"Bags Used":"Qty Used ("+lot.unit+")"} value={qty} onChange={v=>{setQty(v);setError("");}} type="number" accent={matConfig.accent}/>
          {error&&<div style={{color:"#DC3545",fontSize:11,marginTop:4,fontWeight:600}}>{error}</div>}</div>
        <div style={{marginBottom:18}}><Field label="Reason / Batch Ref" value={reason} onChange={setReason} ph="e.g. Batch EPS-FO-260013" accent={matConfig.accent}/></div>
        <div style={{display:"flex",gap:10}}>
          <button type="button" onClick={onClose} style={{flex:1,padding:11,border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",fontWeight:600,cursor:"pointer",fontSize:13}}>Cancel</button>
          <button type="button" onClick={save} style={{flex:2,padding:11,border:"none",borderRadius:8,background:matConfig.accent,color:"#fff",fontWeight:800,cursor:"pointer",fontSize:14}}>Deduct Stock</button></div>
      </div></div></div>);
}
// Sells down scrap and records what it actually sold for — separate from Use Stock, since
// scrap leaves as a sale (with a price to remember for finance later), not production usage.
function SellScrapModal({lot,matConfig,onSave,onClose}){
  const [qty,setQty]=useState(""),[price,setPrice]=useState(""),[buyer,setBuyer]=useState(""),[error,setError]=useState("");
  const remKg=Number(lot.qtyRemaining)||0,qtyNum=Number(qty)||0,priceNum=Number(price)||0;
  const newRem=remKg-qtyNum,rate=qtyNum>0?priceNum/qtyNum:0;
  const save=()=>{
    if(!qty||qtyNum<=0){setError("Enter how much you sold.");return;}
    if(qtyNum>remKg+0.01){setError("Max "+fmt(remKg)+" "+lot.unit+" available.");return;}
    if(!price||priceNum<=0){setError("Enter the price you sold it for.");return;}
    const ns=newRem<=0?"Out of Stock":lot.status;
    // saleRevenue/saleCurrency are structured (for finance calcs to sum directly) alongside
    // the human-readable reason text — the two are always kept in sync here.
    onSave(Object.assign({},lot,{qtyRemaining:Math.max(0,newRem),status:ns,usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:qtyNum,reason:"Sold"+(buyer?" to "+buyer:"")+" — "+fmt(priceNum)+" EGP ("+fmt(rate)+" EGP/KG)",remainingAfter:Math.max(0,newRem),saleRevenue:priceNum,saleCurrency:"EGP",buyer:buyer||null}])}));
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:420,overflow:"hidden"}}>
      <div style={{background:matConfig.color,padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>💰 Sell Scrap</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>Lot: {lot.lotNumber}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{background:matConfig.light,borderRadius:10,padding:"12px 16px",marginBottom:18}}>
          <div style={{fontSize:11,color:matConfig.color,fontWeight:700,marginBottom:4}}>Current Stock</div>
          <span style={{fontSize:22,fontWeight:900,color:matConfig.color}}>{fmt(remKg)} {lot.unit}</span></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label={"Qty Sold ("+lot.unit+")"} value={qty} onChange={v=>{setQty(v);setError("");}} type="number" accent={matConfig.accent}/>
          <Field label="Sale Price (EGP)" value={price} onChange={v=>{setPrice(v);setError("");}} type="number" ph="Total, not per-KG" accent={matConfig.accent}/></div>
        {qtyNum>0&&priceNum>0&&<div style={{fontSize:12,color:matConfig.color,marginBottom:14}}>≈ {fmt(rate)} EGP/KG</div>}
        <div style={{marginBottom:18}}><Field label="Buyer (optional)" value={buyer} onChange={setBuyer} ph="e.g. Scrap dealer name" accent={matConfig.accent}/></div>
        {error&&<div style={{color:"#DC3545",fontSize:11,marginBottom:14,fontWeight:600}}>{error}</div>}
        <div style={{display:"flex",gap:10}}>
          <button type="button" onClick={onClose} style={{flex:1,padding:11,border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",fontWeight:600,cursor:"pointer",fontSize:13}}>Cancel</button>
          <button type="button" onClick={save} style={{flex:2,padding:11,border:"none",borderRadius:8,background:matConfig.accent,color:"#fff",fontWeight:800,cursor:"pointer",fontSize:14}}>Record Sale</button></div>
      </div></div></div>);
}
function LotModal({matName,matConfig,lot,onSave,onClose}){
  const [form,setForm]=useState(lot?Object.assign({},lot):Object.assign({},BLANK_LOT));
  const set=(k,v)=>setForm(f=>Object.assign({},f,{[k]:v}));
  const fields=[["Lot Number","lotNumber","text"],["Packing List No.","plNo","text"],["Date Received","date","text"],["Supplier","supplier","text"],["Description","description","text"],["Qty Received","qtyReceived","number"],["Unit","unit","text"],["Qty Remaining","qtyRemaining","number"],["Notes","notes","text"]];
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:560,maxHeight:"92vh",overflowY:"auto"}}>
      <div style={{background:matConfig.color,borderRadius:"16px 16px 0 0",padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:10}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>{lot?"Edit Lot":"Add New Lot"}</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{matConfig.emoji} {matName}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24,display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
        {fields.map(f=>(<div key={f[1]} style={{gridColumn:["description","notes","supplier"].indexOf(f[1])>=0?"1/-1":"auto"}}>
          <Field label={f[0]} value={form[f[1]]==null?"":form[f[1]]} onChange={v=>set(f[1],v)} type={f[2]} accent={matConfig.accent}/></div>))}
        <div><Field label="Unit Cost" value={form.unitCost==null?"":form.unitCost} onChange={v=>set("unitCost",v)} type="number" accent={matConfig.accent}/></div>
        <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Currency</label>
          <select value={form.unitCostCurrency||"EGP"} onChange={e=>set("unitCostCurrency",e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option>EGP</option><option>USD</option></select></div>
        {form.unitCostCurrency==="USD"&&<div style={{gridColumn:"1/-1"}}><Field label="USD → EGP Rate (on the day you bought this)" value={form.usdToEgpRate==null?"":form.usdToEgpRate} onChange={v=>set("usdToEgpRate",v)} type="number" ph="e.g. 50" accent={matConfig.accent}/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>Locks this lot&apos;s EGP cost to what you actually paid — leave blank to use Finance&apos;s fallback rate instead.</div></div>}
        <div style={{gridColumn:"1/-1"}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:6,textTransform:"uppercase"}}>Status</label>
          <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{Object.keys(STATUS_CONFIG).map(s=>(
            <button type="button" key={s} onClick={()=>set("status",s)} style={{padding:"7px 14px",borderRadius:20,border:"2px solid "+(form.status===s?STATUS_CONFIG[s].dot:"#E2E8F0"),background:form.status===s?STATUS_CONFIG[s].bg:"#fff",color:form.status===s?STATUS_CONFIG[s].text:"#666",fontWeight:700,fontSize:12,cursor:"pointer"}}>{s}</button>))}</div></div>
        {matConfig.trackCoils&&<div style={{gridColumn:"1/-1"}}><Field label="Total Coils In Box" value={form.totalCoils==null?"":form.totalCoils} onChange={v=>set("totalCoils",v)} type="number" ph="e.g. 5" accent={matConfig.accent}/></div>}
        <div style={{gridColumn:"1/-1"}}><ImgUpload value={form.image} onChange={v=>set("image",v)} accent={matConfig.accent}/></div></div>
      <div style={{padding:"16px 24px",borderTop:"1px solid #F0F0F0",display:"flex",justifyContent:"flex-end",gap:10,position:"sticky",bottom:0,background:"#fff"}}>
        <button type="button" onClick={onClose} style={{padding:"10px 20px",borderRadius:8,border:"1.5px solid #E2E8F0",background:"#fff",color:"#444",fontWeight:600,cursor:"pointer",fontSize:13}}>Cancel</button>
        <button type="button" onClick={()=>onSave(form)} style={{padding:"10px 24px",borderRadius:8,border:"none",background:matConfig.accent,color:"#fff",fontWeight:700,cursor:"pointer",fontSize:13}}>{lot?"Save Changes":"Add Lot"}</button></div>
    </div></div>);
}
// Creates a new Aluminum Caps lot (this batch's output) while deducting the coil weight
// it was stamped from out of the matching Aluminum Coils lot — the link the old Notion
// tool didn't have between the two materials.
function AluminumBatchForm({capsLots,coilLots,matConfig,employees,onSave,onClose}){
  const preview=nextAlLotNo(capsLots);
  const [coilLotId,setCoilLotId]=useState(""),[coilNumber,setCoilNumber]=useState("");
  const [weightTaken,setWeightTaken]=useState(""),[qty,setQty]=useState(""),[unit,setUnit]=useState("Pcs");
  const [scrapPct,setScrapPct]=useState("27.4");
  const [dateStarted,setDateStarted]=useState(""),[dateFinished,setDateFinished]=useState(new Date().toISOString().split("T")[0]);
  const [bagQty,setBagQty]=useState(""),[bagUnit,setBagUnit]=useState("Pcs"),[bagCount,setBagCount]=useState("1"),[bagsList,setBagsList]=useState([]);
  const [operatorId,setOperatorId]=useState(""),[notes,setNotes]=useState(""),[err,setErr]=useState("");
  const pressEmployees=(employees||[]).filter(x=>x.active!==false&&(x.stations||[]).indexOf("Press")>=0);
  const operatorEmp=operatorId?pressEmployees.filter(x=>x.id===operatorId)[0]:null;
  const coil=coilLotId?coilLots.filter(l=>l.id===coilLotId)[0]:null;
  const wt=Number(weightTaken)||0,availKg=coil?Number(coil.qtyRemaining)||0:0;
  const scrapKg=wt*(Number(scrapPct)||0)/100;
  const isBags=unit==="Bags";
  const bagPcsEq=b=>b.unit==="Stamps"?b.qty*6:b.unit==="KG"?kgToPcs(b.qty,0.405):b.qty;
  const bagsTotalPcs=bagsList.reduce((s,b)=>s+bagPcsEq(b),0);
  const addBag=()=>{if(!bagQty||Number(bagQty)<=0){setErr("Enter a quantity for the bag.");return;}
    const n=Math.max(1,Number(bagCount)||1);
    setBagsList(bagsList.concat(Array.from({length:n},()=>({qty:Number(bagQty),unit:bagUnit}))));
    setBagQty("");setBagCount("1");setErr("");};
  const dispDate=d=>d?new Date(d+"T00:00:00").toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}).replace(/ /g,"-"):null;
  const save=()=>{
    if(!coilLotId){setErr("Select which coil lot this was stamped from.");return;}
    if(wt<=0){setErr("Enter the weight taken from the coil.");return;}
    // Tolerate float drift from repeated deductions across many batches, so using exactly
    // what's shown as remaining isn't wrongly rejected as "too much".
    if(wt>availKg+0.01){setErr("Only "+fmt(availKg)+" KG remaining on that coil lot.");return;}
    if(isBags){if(bagsList.length===0){setErr("Add at least one bag.");return;}}
    else if(!qty||Number(qty)<=0){setErr("Enter the quantity produced.");return;}
    // Two cost figures, both derived from the coil this lot was stamped from — coils are the
    // only place aluminum has a real purchase price. unitCost matches whatever `unit` this lot
    // is tracked in (for inventory valuation, like every other material); costPerPc is always
    // per piece regardless of unit, since Assembly consumption (aluminumSelections) is in pcs.
    const qtyReceivedVal=isBags?bagsList.length:Number(qty)||0;
    const totalPcsProduced=isBags?bagsTotalPcs:(unit==="KG"?kgToPcs(Number(qty)||0,0.405):Number(qty)||0);
    const capUnitCost=(coil.unitCost&&qtyReceivedVal>0)?(wt*Number(coil.unitCost))/qtyReceivedVal:"";
    const capCostPerPc=(coil.unitCost&&totalPcsProduced>0)?(wt*Number(coil.unitCost))/totalPcsProduced:"";
    // Ashraf's (or whoever's) wage for the day is split across however many Aluminum Cap lots
    // he's logged on that same date — including this new one — so making 2 coils in one shift
    // doesn't charge each coil a full day's wage.
    const sameDayLots=operatorEmp?capsLots.filter(l=>l.operatorId===operatorEmp.id&&l.dateISO===dateFinished).length+1:0;
    const laborCostEGP=operatorEmp?effectiveDailyRate(operatorEmp)/sameDayLots:0;
    const newLot={id:genId(),lotNumber:preview,plNo:preview,date:dispDate(dateFinished),dateStarted:dispDate(dateStarted),dateISO:dateFinished,supplier:"In-house production",
      description:"20mm Flip-Off Aluminum Caps – Coil lot "+coil.lotNumber+(coilNumber?" | Coil "+coilNumber:""),
      qtyReceived:isBags?bagsList.length:Number(qty),unit:unit,qtyRemaining:isBags?bagsList.length:Number(qty),
      unitCost:capUnitCost,unitCostCurrency:coil.unitCostCurrency||"USD",costPerPc:capCostPerPc,
      operatorId:operatorEmp?operatorEmp.id:null,laborCostEGP:laborCostEGP,laborCostPerPc:totalPcsProduced>0?laborCostEGP/totalPcsProduced:0,
      sourceCoilLotNo:coil.lotNumber,scrapKg:scrapKg,status:"In Stock",
      notes:(operatorEmp?"Operator: "+operatorEmp.name:"")+(coil.notes?" | Source: "+coil.notes:""),image:null,usageLog:[]};
    if(isBags)newLot.bags=bagsList.map((b,i)=>{const n=pad(i+1,2);const isSt=b.unit==="Stamps";
      return{id:"B"+n,label:preview+"-B"+n,qty:isSt?b.qty*6:b.qty,qtyUnit:isSt?"Pcs":b.unit,used:false,usedDate:null};});
    onSave(newLot,{coilLotId:coilLotId,weightTaken:wt,coilNumber:coilNumber,scrapKg:scrapKg});
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:560,maxHeight:"92vh",overflowY:"auto"}}>
      <div style={{background:matConfig.color,borderRadius:"16px 16px 0 0",padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center",position:"sticky",top:0,zIndex:10}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>New Aluminum Batch</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12,fontFamily:"monospace"}}>{preview}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{background:matConfig.light,borderRadius:10,padding:14,marginBottom:16}}>
          <div style={{fontWeight:700,fontSize:13,color:matConfig.color,marginBottom:10}}>Coil consumed</div>
          <div style={{marginBottom:10}}>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Coil Lot</label>
            <select value={coilLotId} onChange={e=>{setCoilLotId(e.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
              <option value="">— select coil lot —</option>
              {coilLots.filter(l=>Number(l.qtyRemaining)>0).map(l=><option key={l.id} value={l.id}>{l.notes||l.lotNumber} · {fmt(l.qtyRemaining)} KG left</option>)}</select>
            {coilLots.filter(l=>Number(l.qtyRemaining)>0).length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No aluminum coil lots with stock remaining.</div>}</div>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
            <Field label="Coil Number" value={coilNumber} onChange={setCoilNumber} ph="e.g. Coil 24" accent={matConfig.accent}/>
            <Field label="Weight Taken (KG) *" value={weightTaken} onChange={v=>{setWeightTaken(v);setErr("");}} type="number" ph="0.00" accent={matConfig.accent}/></div>
          {coil&&<div style={{fontSize:11,color:matConfig.color,marginTop:8}}>{fmt(availKg)} KG available on this lot right now</div>}
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginTop:10}}>
            <Field label="Scrap %" value={scrapPct} onChange={setScrapPct} type="number" ph="27.4" accent={matConfig.accent}/>
            <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>♻️ Scrap Generated</label>
              <div style={{padding:"9px 12px",background:"#FDF3E0",borderRadius:8,fontSize:13,color:"#8B5A2B",fontWeight:700}}>{wt>0?fmt(scrapKg)+" KG":"—"}</div></div></div></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Unit</label>
            <select value={unit} onChange={e=>{setUnit(e.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
              <option>Pcs</option><option>Bags</option><option>KG</option></select></div>
          {!isBags&&<Field label="Qty Produced *" value={qty} onChange={v=>{setQty(v);setErr("");}} type="number" ph="e.g. 15000" accent={matConfig.accent}/>}
          <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date Started</label>
            <input type="date" value={dateStarted} onChange={e=>setDateStarted(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
          <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date Finished</label>
            <input type="date" value={dateFinished} onChange={e=>setDateFinished(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
          <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Operator</label>
            <select value={operatorId} onChange={e=>setOperatorId(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
              <option value="">— not specified —</option>
              {pressEmployees.map(x=><option key={x.id} value={x.id}>{x.name}</option>)}</select></div></div>
        {isBags&&<div style={{background:"#F7F9FC",borderRadius:10,padding:14,marginBottom:14}}>
          <div style={{fontWeight:700,fontSize:13,color:matConfig.color,marginBottom:2}}>Bags Produced</div>
          <div style={{fontSize:11,color:"#888",marginBottom:10}}>Add several identical bags at once, then add the odd one out separately — Pcs, KG, or Stamps (1 stamp = 6 pcs)</div>
          {bagsList.length>0&&<div style={{marginBottom:10,display:"flex",flexDirection:"column",gap:6}}>
            {(()=>{const groups=[];bagsList.forEach((b,i)=>{const last=groups[groups.length-1];
              if(last&&last.qty===b.qty&&last.unit===b.unit&&last.end===i-1)last.end=i;else groups.push({start:i,end:i,qty:b.qty,unit:b.unit});});
              return groups.map((g,gi)=>{const count=g.end-g.start+1;
                return(<div key={gi} style={{background:"#fff",borderRadius:8,padding:"7px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #E2E8F0"}}>
                  <div style={{fontSize:12}}><strong style={{fontFamily:"monospace",color:matConfig.color}}>{preview}-B{pad(g.start+1,2)}{count>1?"–B"+pad(g.end+1,2):""}</strong>
                    <span style={{color:"#888",marginLeft:8}}>{count>1?count+" bags × ":""}{fmtN(g.qty)} {g.unit}{g.unit==="Stamps"?" ("+fmtN(g.qty*6)+" pcs each)":""}</span></div>
                  <button type="button" onClick={()=>setBagsList(bagsList.filter((_,idx)=>idx<g.start||idx>g.end))} style={{background:"#FFF0F0",border:"none",borderRadius:6,padding:"4px 9px",cursor:"pointer",fontSize:12,color:"#DC3545"}}>🗑</button></div>);});})()}
            <div style={{background:matConfig.light,borderRadius:8,padding:"7px 12px",fontSize:12,fontWeight:700,color:matConfig.color}}>Total: {bagsList.length} bags · {fmtN(bagsTotalPcs)} pcs</div></div>}
          <div style={{display:"flex",gap:8,alignItems:"flex-end"}}>
            <div style={{width:90}}><Field label="How Many" value={bagCount} onChange={setBagCount} type="number" ph="1" accent={matConfig.accent}/></div>
            <div style={{flex:1}}><Field label="Quantity Each" value={bagQty} onChange={v=>{setBagQty(v);setErr("");}} type="number" ph="e.g. 25" accent={matConfig.accent}/></div>
            <div style={{flex:1}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Unit</label>
              <select value={bagUnit} onChange={e=>setBagUnit(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
                <option>Pcs</option><option>KG</option><option>Stamps</option></select></div>
            <button type="button" onClick={addBag} style={{padding:"9px 16px",background:matConfig.accent,color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"}}>+ Add</button></div></div>}
        <div style={{marginBottom:18}}><Field label="Notes" value={notes} onChange={setNotes} accent={matConfig.accent}/></div>
        {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
        {coil&&wt>0&&!err&&<div style={{background:"#E8F5E9",border:"1px solid #A5D6A7",borderRadius:8,padding:"9px 12px",marginBottom:14,fontSize:12,color:"#1A6B2A",fontWeight:600}}>
          On save: <strong>{fmt(wt)} KG</strong> deducted from <strong>{coil.lotNumber}</strong> → {fmt(Math.max(0,availKg-wt))} KG left</div>}
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:matConfig.accent,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save Aluminum Batch</button>
      </div></div></div>);
}
function LotDetail({lot,matConfig,isScrap,onClose,onEdit,onUseStock,onSellScrap,onDeleteUsage,onToggleBag}){
  const rem=Number(lot.qtyRemaining)||0,rec=Number(lot.qtyReceived)||0;
  const pct=rec?Math.min(100,(rem/rec)*100):0;
  const bar=pct<=15?"#DC3545":pct<=40?"#F59E0B":matConfig.accent;
  const silica=isSilica(lot),hasBags=lot.bags&&lot.bags.length>0;
  const [confDel,setConfDel]=useState(null);
  const del=entry=>{const nr=rem+Number(entry.qtyUsed);const ns=nr<=0?"Out of Stock":nr<=rec*0.15?"Low Stock":"In Stock";
    onDeleteUsage(Object.assign({},lot,{qtyRemaining:nr,status:ns,usageLog:lot.usageLog.filter(e=>e.id!==entry.id)}));setConfDel(null);};
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:900,display:"flex",alignItems:"flex-end",justifyContent:"center"}}>
    <div style={{background:"#fff",borderRadius:"16px 16px 0 0",width:"100%",maxWidth:600,maxHeight:"90vh",overflowY:"auto"}}>
      <div style={{padding:"12px 0 4px",display:"flex",justifyContent:"center"}}><div style={{width:40,height:4,background:"#E2E8F0",borderRadius:2}}/></div>
      <div style={{padding:"4px 20px 14px",display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
        <div><div style={{fontWeight:900,fontSize:16}}>{lot.lotNumber}</div><div style={{color:"#888",fontSize:12,marginTop:2}}>PL: {lot.plNo} · {lot.date}</div></div>
        <button type="button" onClick={onClose} style={{background:"#F5F7FA",border:"none",borderRadius:8,padding:"6px 12px",cursor:"pointer",color:"#666",fontSize:14}}>✕</button></div>
      {lot.image&&<div style={{margin:"0 20px 14px",borderRadius:12,overflow:"hidden",border:"1.5px solid #E2E8F0"}}><img src={lot.image} alt="lot" style={{width:"100%",maxHeight:200,objectFit:"cover",display:"block"}}/></div>}
      <div style={{margin:"0 20px 14px"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:6}}>
          <div><span style={{fontSize:28,fontWeight:900,color:bar}}>{silica?(rem/BAG_KG).toLocaleString():hasBags?rem:fmt(rem)}</span>
            <span style={{fontSize:13,color:"#aaa",marginLeft:5}}>{silica||hasBags?"bags remaining":lot.unit+" remaining"}</span></div>
          <SBadge status={lot.status}/></div>
        <div style={{height:8,background:"#F0F0F0",borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:bar,borderRadius:4}}/></div></div>
      <div style={{margin:"0 20px 14px",borderRadius:12,border:"1.5px solid #EEF2F7",overflow:"hidden"}}>
        {[["Supplier",lot.supplier],["Description",lot.description],["Date Started",lot.dateStarted],["Date Finished",lot.dateStarted?lot.date:null],["Unit Cost",lot.unitCost?fmt(lot.unitCost)+" "+(lot.unitCostCurrency||"EGP")+" / "+lot.unit:null],["Est. Remaining Value",lot.unitCost?fmt(rem*Number(lot.unitCost))+" "+(lot.unitCostCurrency||"EGP"):null],["Notes",lot.notes],["Coils",lot.totalCoils?(lot.coilsUsed||0)+" of "+lot.totalCoils+" used":null]].filter(x=>x[1]).map((x,i)=>(
          <div key={i} style={{display:"flex",borderBottom:"1px solid #F5F7FA",padding:"9px 14px",gap:10}}>
            <div style={{fontSize:11,fontWeight:700,color:"#BBB",textTransform:"uppercase",minWidth:85}}>{x[0]}</div>
            <div style={{fontSize:12,color:"#2D3748",flex:1,lineHeight:1.5}}>{x[1]}</div></div>))}</div>
      {hasBags&&<BagGrid bags={lot.bags} matConfig={matConfig} onToggle={onToggleBag}/>}
      {!hasBags&&lot.usageLog&&lot.usageLog.length>0&&(<div style={{margin:"0 20px 14px"}}>
        <div style={{fontSize:11,fontWeight:800,color:"#888",textTransform:"uppercase",marginBottom:8}}>History</div>
        <div style={{display:"flex",flexDirection:"column",gap:6}}>
          {lot.usageLog.slice().reverse().map(entry=>{const isAddition=Number(entry.qtyUsed)<0;
          return(<div key={entry.id} style={{background:"#FAFBFC",borderRadius:8,padding:"9px 13px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #EEF2F7"}}>
            <div style={{flex:1}}><div style={{fontSize:13,fontWeight:700,color:isAddition?"#1A6B2A":"#DC3545"}}>{isAddition?"+ ":"− "}{fmt(Math.abs(entry.qtyUsed))} {lot.unit}</div><div style={{fontSize:11,color:"#888"}}>{entry.reason}</div></div>
            <div style={{display:"flex",alignItems:"center",gap:10}}>
              <div style={{textAlign:"right"}}><div style={{fontSize:10,color:"#aaa"}}>{entry.date}</div><div style={{fontSize:11,color:"#555",fontWeight:600}}>{fmt(entry.remainingAfter)} left</div></div>
              {confDel===entry.id?(<div style={{display:"flex",gap:5}}>
                <button type="button" onClick={()=>del(entry)} style={{background:"#DC3545",border:"none",borderRadius:6,padding:"4px 9px",cursor:"pointer",fontSize:11,color:"#fff",fontWeight:800}}>Yes</button>
                <button type="button" onClick={()=>setConfDel(null)} style={{background:"#E2E8F0",border:"none",borderRadius:6,padding:"4px 9px",cursor:"pointer",fontSize:11}}>No</button></div>)
              :(<button type="button" onClick={()=>setConfDel(entry.id)} style={{background:"#FFF0F0",border:"none",borderRadius:6,padding:"6px 9px",cursor:"pointer",fontSize:14,color:"#DC3545"}}>🗑</button>)}
            </div></div>);})}</div></div>)}
      <div style={{padding:"12px 20px 28px",display:"flex",gap:10}}>
        {!hasBags&&isScrap&&<button type="button" onClick={onSellScrap} style={{flex:2,padding:14,border:"none",borderRadius:10,background:matConfig.accent,color:"#fff",fontWeight:800,cursor:"pointer",fontSize:14}}>💰 Sell Scrap</button>}
        {!hasBags&&!isScrap&&<button type="button" onClick={onUseStock} style={{flex:2,padding:14,border:"none",borderRadius:10,background:matConfig.accent,color:"#fff",fontWeight:800,cursor:"pointer",fontSize:14}}>📦 Use Stock</button>}
        <button type="button" onClick={onEdit} style={{flex:1,padding:14,border:"1.5px solid "+matConfig.accent,borderRadius:10,background:"#fff",color:matConfig.accent,fontWeight:700,cursor:"pointer",fontSize:14}}>✏️ Edit</button></div>
    </div></div>);
}
function CoilModal({mode,coil,boxLots,matConfig,onSave,onClose}){
  const isStart=mode==="start";
  const [cd,setCd]=useState(isStart?"":(coil&&coil.coreDiameter)||"");
  const [wi,setWi]=useState(isStart?"183":(coil&&coil.width)||"183");
  const [od,setOd]=useState(""),[blId,setBlId]=useState(""),[note,setNote]=useState(""),[err,setErr]=useState("");
  const last=!isStart&&coil&&coil.weighIns&&coil.weighIns.length?coil.weighIns[coil.weighIns.length-1]:null;
  const effC=isStart?cd:(coil&&coil.coreDiameter),effW=isStart?wi:(coil&&coil.width);
  const prev=coilWt(od,effC,effW);
  const save=()=>{
    if(isStart&&(!cd||Number(cd)<=0)){setErr("Enter core diameter.");return;}
    if(!od||Number(od)<=0){setErr("Enter outer diameter.");return;}
    if(Number(od)<=Number(effC)){setErr("OD must be greater than core.");return;}
    const w=coilWt(od,effC,effW);if(!w){setErr("Check numbers.");return;}
    if(!isStart&&last&&w>last.weight){setErr("Last reading was "+fmt(last.weight)+" KG. Re-check.");return;}
    if(isStart)onSave({boxLotId:blId||null,coreDiameter:Number(cd),width:Number(wi),outerDiameter:Number(od),weight:w,note:note});
    else onSave({newWeight:w,outerDiameter:Number(od),note:note});
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:440,maxHeight:"92vh",overflowY:"auto"}}>
      <div style={{background:matConfig.color,padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>{isStart?"Start Tracking a Coil":"Measure Coil"}</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>Tape measure method</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        {!isStart&&last&&<div style={{background:matConfig.light,borderRadius:10,padding:"12px 16px",marginBottom:16}}>
          <div style={{fontSize:11,color:matConfig.color,fontWeight:700}}>Last Reading</div>
          <div style={{fontSize:22,fontWeight:900,color:matConfig.color}}>{fmt(last.weight)} KG</div></div>}
        {isStart&&boxLots&&boxLots.length>0&&<div style={{marginBottom:14}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:6,textTransform:"uppercase"}}>Which Box?</label>
          <select value={blId} onChange={e=>setBlId(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"10px 12px",fontSize:13,background:"#fff"}}>
            <option value="">Not specified</option>{boxLots.map(l=><option key={l.id} value={l.id}>{l.notes||l.lotNumber}</option>)}</select></div>}
        {isStart&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label="Core Ø (mm)" value={cd} onChange={v=>{setCd(v);setErr("");}} type="number" ph="e.g. 76" accent={matConfig.accent}/>
          <Field label="Width (mm)" value={wi} onChange={v=>{setWi(v);setErr("");}} type="number" ph="183" accent={matConfig.accent}/></div>}
        <div style={{marginBottom:14}}>
          <Field label="Outer Diameter (mm)" value={od} onChange={v=>{setOd(v);setErr("");}} type="number" ph="Circumference ÷ 3.14" accent={matConfig.accent}/>
          <div style={{fontSize:11,color:"#aaa",marginTop:4}}>Wrap tape around coil, divide by 3.14</div>
          {err&&<div style={{color:"#DC3545",fontSize:11,marginTop:4,fontWeight:600}}>{err}</div>}</div>
        <div style={{marginBottom:18}}><Field label="Note" value={note} onChange={setNote} accent={matConfig.accent}/></div>
        {prev!=null&&od!==""&&!err&&<div style={{background:"#F7F9FC",borderRadius:10,padding:"12px 16px",marginBottom:18}}>
          <div style={{fontSize:11,color:"#999",fontWeight:700}}>Calculated Weight</div>
          <div style={{fontSize:18,fontWeight:900,color:matConfig.color}}>{fmt(prev)} KG</div>
          {!isStart&&last&&<div style={{fontSize:12,color:"#DC3545",fontWeight:700,marginTop:4}}>− {fmt(last.weight-prev)} KG used</div>}</div>}
        <div style={{display:"flex",gap:10}}>
          <button type="button" onClick={onClose} style={{flex:1,padding:11,border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",fontWeight:600,cursor:"pointer",fontSize:13}}>Cancel</button>
          <button type="button" onClick={save} style={{flex:2,padding:11,border:"none",borderRadius:8,background:matConfig.accent,color:"#fff",fontWeight:800,cursor:"pointer",fontSize:14}}>{isStart?"Start Tracking":"Save Reading"}</button></div>
      </div></div></div>);
}
function ActiveCoilTracker({coils,boxLots,matConfig,onStart,onMeasure,onFinish}){
  const active=coils.filter(c=>c.status==="active")[0];
  const past=coils.filter(c=>c.status==="finished");
  const last=active&&active.weighIns?active.weighIns[active.weighIns.length-1]:null;
  const first=active&&active.weighIns?active.weighIns[0]:null;
  const totalUsed=active&&first&&last?first.weight-last.weight:0;
  return(<div style={{background:"#fff",borderRadius:14,border:"1.5px solid #EEF2F7",overflow:"hidden",marginBottom:16}}>
    <div style={{background:"linear-gradient(135deg,"+matConfig.color+","+matConfig.accent+")",padding:"14px 18px"}}>
      <div style={{color:"#fff",fontWeight:800,fontSize:14}}>🎯 Active Coil Tracker</div>
      <div style={{color:"rgba(255,255,255,0.65)",fontSize:11,marginTop:2}}>Tracked by outer-diameter — no weighing</div></div>
    <div style={{padding:18}}>
      {active?(<div>
        <div style={{fontWeight:800,fontSize:14,marginBottom:10}}>{active.label} <span style={{fontSize:11,color:"#999",fontWeight:400}}>Core {active.coreDiameter}mm · Width {active.width}mm</span></div>
        <div style={{background:matConfig.light,borderRadius:10,padding:"14px 16px",marginBottom:14}}>
          <div style={{fontSize:11,color:matConfig.color,fontWeight:700}}>Estimated Weight</div>
          <div style={{fontSize:26,fontWeight:900,color:matConfig.color}}>{fmt(last.weight)} KG</div>
          <div style={{fontSize:11,color:matConfig.color,opacity:0.7}}>OD: {last.outerDiameter}mm · Measured {last.date}</div>
          {totalUsed>0&&<div style={{fontSize:11,color:"#DC3545",fontWeight:700,marginTop:2}}>{fmt(totalUsed)} KG used total</div>}</div>
        <div style={{display:"flex",gap:10}}>
          <button type="button" onClick={onMeasure} style={{flex:2,padding:12,border:"none",borderRadius:10,background:matConfig.accent,color:"#fff",fontWeight:800,cursor:"pointer",fontSize:13}}>📏 Measure</button>
          <button type="button" onClick={onFinish} style={{flex:1,padding:12,border:"1.5px solid "+matConfig.accent,borderRadius:10,background:"#fff",color:matConfig.accent,fontWeight:700,cursor:"pointer",fontSize:13}}>✅ Finish</button></div>
      </div>):(<div style={{textAlign:"center",padding:"24px 10px"}}>
        <div style={{fontSize:28,marginBottom:8}}>📏</div>
        <div style={{fontWeight:700,fontSize:14,color:"#333"}}>No coil currently tracked</div>
        <div style={{color:"#888",fontSize:12,marginTop:4,marginBottom:16}}>Measure the mounted coil to set a baseline</div>
        <button type="button" onClick={onStart} style={{background:matConfig.accent,color:"#fff",border:"none",borderRadius:9,padding:"11px 22px",fontWeight:700,cursor:"pointer",fontSize:13}}>▶️ Start Tracking</button></div>)}
      {past.length>0&&<div style={{marginTop:16,borderTop:"1px solid #F0F0F0",paddingTop:12,fontSize:11,color:"#999"}}>{past.length} past coil{past.length!==1?"s":""} finished</div>}
    </div></div>);
}

// ══ MATERIAL VIEW ═════════════════════════════════════════════════════════
function MaterialView({matName,matConfig,lots,coils,coilLots,batches,employees,onUpdate,onDelete,onAdd,onBack,onStartCoil,onMeasureCoil,onFinishCoil,onToggleBag,onCreateAlBatch,onUseCoilStock}){
  const [editLot,setEditLot]=useState(null),[showAdd,setShowAdd]=useState(false),[detailId,setDetailId]=useState(null);
  const [useStock,setUseStock]=useState(null),[search,setSearch]=useState(""),[confirmDel,setConfirmDel]=useState(null),[coilModal,setCoilModal]=useState(null);
  const [showAlBatch,setShowAlBatch]=useState(false),[sellScrap,setSellScrap]=useState(null);
  const isAlCaps=matName==="Aluminum Caps";
  const isScrap=matName==="Aluminum Scrap";
  const filtered=lots.filter(l=>[l.lotNumber,l.plNo,l.description,l.supplier,l.status].some(v=>(v||"").toLowerCase().indexOf(search.toLowerCase())>=0));
  const totalQty=lots.reduce((s,l)=>s+(Number(l.qtyRemaining)||0),0);
  const unit=lots.length?lots[0].unit:"KG";
  const detail=detailId?lots.filter(l=>l.id===detailId)[0]:null;
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:matConfig.color,position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onBack} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div style={{flex:1,color:"#fff",fontWeight:800,fontSize:17}}>{matConfig.emoji} {matName}</div>
        <div style={{display:"flex",gap:6}}>
          {isAlCaps&&<button type="button" onClick={()=>setShowAlBatch(true)} style={{background:"rgba(255,255,255,0.15)",border:"1px solid rgba(255,255,255,0.3)",color:"#fff",borderRadius:9,padding:"9px 16px",fontWeight:800,fontSize:13,cursor:"pointer"}}>+ New Batch</button>}
          <button type="button" onClick={()=>setShowAdd(true)} style={{background:"#fff",border:"none",color:matConfig.color,borderRadius:9,padding:"9px 16px",fontWeight:800,fontSize:13,cursor:"pointer"}}>+ Add Lot</button></div></div>
      <div style={{background:matConfig.accent}}><div style={{maxWidth:700,margin:"0 auto",display:"flex"}}>
        {[["Lots",lots.length],["In Stock",lots.filter(l=>l.status==="In Stock").length],["Remaining",fmtN(totalQty)+" "+unit]].map((x,i)=>(
          <div key={i} style={{flex:1,padding:"8px 12px",borderRight:i<2?"1px solid rgba(255,255,255,0.15)":"none"}}>
            <div style={{color:"rgba(255,255,255,0.65)",fontSize:9,fontWeight:700,textTransform:"uppercase"}}>{x[0]}</div>
            <div style={{color:"#fff",fontWeight:800,fontSize:15}}>{x[1]}</div></div>))}</div></div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16}}>
      {matConfig.trackCoils&&<ActiveCoilTracker coils={coils} boxLots={lots} matConfig={matConfig} onStart={()=>setCoilModal("start")} onMeasure={()=>setCoilModal("measure")} onFinish={onFinishCoil}/>}
      <div style={{marginBottom:13}}><input placeholder="🔍 Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",border:"1.5px solid #E2E8F0",borderRadius:10,fontSize:13,outline:"none",background:"#fff"}}/></div>
      {filtered.length===0&&<div style={{textAlign:"center",padding:"50px 20px",background:"#fff",borderRadius:14,border:"2px dashed #E2E8F0"}}>
        <div style={{fontSize:36,marginBottom:10}}>📭</div><div style={{fontWeight:700,fontSize:15}}>{lots.length===0?"No stock yet":"No results"}</div>
        {lots.length===0&&<button type="button" onClick={()=>setShowAdd(true)} style={{marginTop:14,background:matConfig.accent,color:"#fff",border:"none",borderRadius:8,padding:"10px 20px",fontWeight:700,cursor:"pointer",fontSize:13}}>+ Add First Lot</button>}</div>}
      <div style={{display:"flex",flexDirection:"column",gap:10}}>
        {filtered.map(lot=>{
          const pct=lot.qtyReceived?Math.min(100,(Number(lot.qtyRemaining)/Number(lot.qtyReceived))*100):0;
          const bar=pct<=15?"#DC3545":pct<=40?"#F59E0B":matConfig.accent;
          const hasBags=lot.bags&&lot.bags.length>0;
          const usedBags=hasBags?lot.bags.filter(b=>b.used).length:0;
          const remD=isSilica(lot)?(Number(lot.qtyRemaining)/BAG_KG).toLocaleString()+" bags":hasBags?Number(lot.qtyRemaining)+" bags":fmt(lot.qtyRemaining)+" "+lot.unit;
          return(<div key={lot.id} style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",overflow:"hidden",cursor:"pointer"}} onClick={()=>setDetailId(lot.id)}>
            <div style={{height:4,background:"#F0F0F0"}}><div style={{height:"100%",width:pct+"%",background:bar}}/></div>
            <div style={{padding:"12px 14px"}}>
              <div style={{display:"flex",alignItems:"flex-start",gap:10,marginBottom:9}}>
                {lot.image?<img src={lot.image} alt="" style={{width:42,height:42,borderRadius:8,objectFit:"cover",flexShrink:0}}/>
                :<div style={{width:42,height:42,borderRadius:8,background:matConfig.light,flexShrink:0,display:"flex",alignItems:"center",justifyContent:"center",fontSize:18}}>{matConfig.emoji}</div>}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap"}}><span style={{fontWeight:700,fontSize:13}}>{lot.lotNumber||"—"}</span><SBadge status={lot.status}/></div>
                  <div style={{color:"#999",fontSize:11,marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{lot.description}</div></div>
                <div onClick={e=>{e.stopPropagation();setConfirmDel(lot.id);}} style={{padding:"4px 8px",borderRadius:6,background:"#FFF0F0",cursor:"pointer",fontSize:13}}>🗑</div></div>
              <div style={{display:"flex",gap:7}}>
                {[["Remaining",remD,bar],["PL No.",lot.plNo||"—","#444"]].map(x=>(
                  <div key={x[0]} style={{flex:1,background:"#F7F9FC",borderRadius:8,padding:"7px 9px"}}>
                    <div style={{fontSize:9,fontWeight:700,color:"#bbb",textTransform:"uppercase"}}>{x[0]}</div>
                    <div style={{fontSize:12,fontWeight:700,color:x[2],marginTop:2}}>{x[1]}</div></div>))}</div>
              {hasBags&&<div style={{marginTop:7,fontSize:10,color:matConfig.accent,fontWeight:700}}>🔘 {usedBags}/{lot.bags.length} bags used</div>}
            </div></div>);})}
      </div></div>
    {detail&&<LotDetail lot={detail} matConfig={matConfig} isScrap={isScrap} onClose={()=>setDetailId(null)}
      onEdit={()=>{setEditLot(detail);setDetailId(null);}} onUseStock={()=>{setUseStock(detail);setDetailId(null);}}
      onSellScrap={()=>{setSellScrap(detail);setDetailId(null);}}
      onDeleteUsage={u=>onUpdate(u)} onToggleBag={bid=>onToggleBag(detail.id,bid)}/>}
    {useStock&&<UseStockModal lot={useStock} matConfig={matConfig} onClose={()=>setUseStock(null)} onSave={u=>{if(matConfig.trackCoils&&onUseCoilStock)onUseCoilStock(useStock,u);else onUpdate(u);setUseStock(null);}}/>}
    {sellScrap&&<SellScrapModal lot={sellScrap} matConfig={matConfig} onClose={()=>setSellScrap(null)} onSave={u=>{onUpdate(u);setSellScrap(null);}}/>}
    {(showAdd||editLot)&&<LotModal matName={matName} matConfig={matConfig} lot={editLot} onClose={()=>{setShowAdd(false);setEditLot(null);}}
      onSave={form=>{if(editLot)onUpdate(Object.assign({},form,{id:editLot.id}));else onAdd(Object.assign({},form,{id:genId()}));setShowAdd(false);setEditLot(null);}}/>}
    {coilModal&&<CoilModal mode={coilModal} coil={coils.filter(c=>c.status==="active")[0]} boxLots={lots} matConfig={matConfig}
      onClose={()=>setCoilModal(null)} onSave={p=>{if(coilModal==="start")onStartCoil(p);else onMeasureCoil(p);setCoilModal(null);}}/>}
    {showAlBatch&&<AluminumBatchForm capsLots={lots} coilLots={coilLots||[]} matConfig={matConfig} batches={batches} employees={employees}
      onClose={()=>setShowAlBatch(false)} onSave={(newLot,consumption)=>{onCreateAlBatch(newLot,consumption);setShowAlBatch(false);}}/>}
    {confirmDel&&<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
      <div style={{background:"#fff",borderRadius:14,padding:26,maxWidth:300,width:"100%",textAlign:"center"}}>
        <div style={{fontSize:32,marginBottom:10}}>🗑</div><div style={{fontWeight:800,fontSize:15,marginBottom:6}}>Delete this lot?</div>
        <div style={{display:"flex",gap:10,marginTop:16}}>
          <button type="button" onClick={()=>setConfirmDel(null)} style={{flex:1,padding:10,border:"1.5px solid #E2E8F0",borderRadius:8,background:"#fff",fontWeight:600,cursor:"pointer"}}>Cancel</button>
          <button type="button" onClick={()=>{onDelete(confirmDel);setConfirmDel(null);}} style={{flex:1,padding:10,border:"none",borderRadius:8,background:"#DC3545",color:"#fff",fontWeight:700,cursor:"pointer"}}>Delete</button></div></div></div>}
  </div>);
}

// ══ SHIFT STAGE FORMS ═════════════════════════════════════════════════════
function InjectionForm({parentBatch,batches,data,employees,existing,onSave,onCancel}){
  const mySubs=batches.filter(b=>b.parentBatchNo===parentBatch.batchNo&&b.isSubBatch);
  const realShifts=mySubs.filter(b=>!b.isCarryover);
  const subNo=existing?existing.batchNo:parentBatch.batchNo+"-"+String.fromCharCode(65+realShifts.length);
  const e=existing||{};
  const [date,setDate]=useState(e.mfgDate||new Date().toISOString().split("T")[0]);
  const [shift,setShift]=useState(e.shift||"Morning");
  const [injectionWorkers,setInjectionWorkers]=useState(e.injectionWorkers||[]);
  const [injections,setInjections]=useState(e.injections||""),[plasticLotId,setPlasticLotId]=useState(e.plasticLotId||"");
  // Cavities per shot is usually 64, but sometimes one is closed off (e.g. 63) — editable per
  // shift rather than a fixed constant, since it can change shift to shift.
  const [cavities,setCavities]=useState(e.cavities!=null?String(e.cavities):String(PCS_INJ));
  const [virginBags,setVirginBags]=useState(e.virginBags||"");
  const [weightBefore,setWeightBefore]=useState(e.weightBeforeSorting||""),[notes,setNotes]=useState(e.notes||""),[err,setErr]=useState("");
  const plasticLots=((data&&data["Plastic Material"]&&data["Plastic Material"].lots)||[]).filter(l=>l.status!=="Out of Stock"||l.id===e.plasticLotId);
  const selPlastic=plasticLotId?plasticLots.filter(l=>l.id===plasticLotId)[0]:null;
  const capWt=parentBatch.capWt||CAP_WT,asmWt=parentBatch.asmWt||ASM_WT,wastePerInj=parentBatch.wastePerInj||WASTE_PER_INJ;
  const inj=Number(injections)||0,vBags=Number(virginBags)||0,vKg=vBags*PLASTIC_BAG_KG,wBef=Number(weightBefore)||0;
  const cav=Number(cavities)||PCS_INJ;
  const thPcs=inj*cav,thKg=pcsToKg(thPcs,capWt),totalPlastic=vKg;
  // Each shot uses more material than just the cap itself — sprue/runner waste per shot,
  // regardless of mold cavity count — so the material a shift SHOULD need is caps + that waste.
  const theoWasteKg=inj*wastePerInj/1000,theoMaterialKg=thKg+theoWasteKg;
  const actualLossKg=totalPlastic>0&&wBef>0?Math.max(0,totalPlastic-wBef):0;
  const availBags=selPlastic?Number(selPlastic.qtyRemaining):0;
  const save=()=>{
    if(inj<1){setErr("Enter number of injections.");return;}
    if(!vBags){setErr("Enter plastic material used.");return;}
    if(vBags>0&&!plasticLotId){setErr("Select which plastic lot the bags came from — otherwise inventory can't be deducted.");return;}
    if(selPlastic&&!existing&&vBags>availBags){setErr("Only "+availBags+" bags available.");return;}
    if(!wBef){setErr("Enter weight before sorting.");return;}
    const payload=Object.assign({},e,{id:e.id||genId(),batchNo:subNo,isSubBatch:true,parentBatchNo:parentBatch.batchNo,product:parentBatch.product,
      status:e.stage&&e.stage!=="Injection"?e.status:"Plastic Sorting",stage:e.stage&&e.stage!=="Injection"?e.stage:"Plastic Sorting",
      color:parentBatch.color,client:parentBatch.client,orderNo:parentBatch.orderNo,capWt:capWt,asmWt:asmWt,wastePerInj:wastePerInj,
      cartons:e.cartons||0,bagsPerCarton:e.bagsPerCarton||0,pcsPerBag:e.pcsPerBag||0,partialCartonBags:0,totalPcs:e.totalPcs||0,
      mfgDate:date,shift:shift,operator:injectionWorkers.map(w=>w.name).join(", "),injectionWorkers:injectionWorkers,injections:inj,cavities:cav,theoreticalPcs:thPcs,theoreticalKg:thKg,
      plasticLotId:plasticLotId||null,plasticLotNo:selPlastic?selPlastic.lotNumber:null,
      virginBags:vBags,virginKg:vKg,totalPlasticKg:totalPlastic,weightBeforeSorting:wBef,
      notes:notes,createdAt:e.createdAt||today()});
    if(!existing){payload.acceptedWeightKg=null;payload.rejectedWeightKg=null;payload.acceptedPcs=null;payload.aluminumSelections=[];payload.assembledPcs=null;payload.goodPcs=null;}
    onSave(payload,{plasticLotId:plasticLotId,plasticBags:vBags});
  };
  return(<div style={{maxWidth:660,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#856404",borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>💉 Injection — {subNo}</div><div style={{color:"rgba(255,255,255,0.65)",fontSize:12}}>{existing?"Editing saved data":"Stage 1 of 4"}</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
        <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date</label>
          <input type="date" value={date} onChange={ev=>setDate(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
        <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Shift</label>
          <select value={shift} onChange={ev=>setShift(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            {["Morning","Afternoon","Night"].map(s=><option key={s}>{s}</option>)}</select></div></div>
      <div style={{background:"#FFF3E0",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:"#856404",marginBottom:10}}>👷 Workers on this shift</div>
        <WorkerPicker employees={employees} station="Injection" value={injectionWorkers} onChange={setInjectionWorkers}/></div>
      <div style={{background:"#FFF9E6",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:"#856404",marginBottom:10}}>💉 Injection Output</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <Field label="No. of Injections" value={injections} onChange={v=>{setInjections(v);setErr("");}} type="number" ph="e.g. 200" accent="#856404"/>
          <Field label="Cavities (usually 64)" value={cavities} onChange={setCavities} type="number" ph="64" accent="#856404"/></div>
        {inj>0&&<div style={{marginTop:8,background:"#fff",borderRadius:8,padding:"10px 12px",fontSize:12,display:"flex",gap:20,flexWrap:"wrap"}}>
          <div>Theoretical: <strong>{thPcs.toLocaleString()} pcs</strong></div><div>Caps: <strong>{thKg.toFixed(2)} KG</strong></div><div style={{color:"#888"}}>@ {capWt} g/cap · × {cav} cavities</div></div>}
        {inj>0&&<div style={{marginTop:8,background:"#fff",borderRadius:8,padding:"10px 12px",fontSize:12,display:"flex",gap:20,flexWrap:"wrap"}}>
          <div>Expected waste (sprue): <strong>{theoWasteKg.toFixed(2)} KG</strong></div><div style={{color:"#888"}}>@ {wastePerInj} g/shot</div>
          <div>Total material needed: <strong>{theoMaterialKg.toFixed(2)} KG</strong></div></div>}</div>
      <div style={{background:"#F5EDFF",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:"#4A1A6E",marginBottom:10}}>🧴 Plastic Material Consumed</div>
        <div style={{marginBottom:10}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Draw From Lot</label>
          <select value={plasticLotId} onChange={ev=>setPlasticLotId(ev.target.value)} style={{width:"100%",border:"1.5px solid "+(plasticLots.length?"#E2E8F0":"#F1948A"),borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— not specified —</option>
            {plasticLots.map(l=><option key={l.id} value={l.id}>{l.lotNumber} · {fmtN(l.qtyRemaining)} bags available</option>)}</select>
          {plasticLots.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600,background:"#FFF0F0",padding:"7px 10px",borderRadius:6}}>⚠️ No plastic lots in inventory. Go to Inventory → Plastic Material → + Add Lot (set unit to &quot;Bags&quot;) before recording usage, or inventory won&apos;t be deducted.</div>}
          {selPlastic&&<div style={{fontSize:11,color:"#7B3FB5",marginTop:4}}>{availBags} bags available · 1 bag = {PLASTIC_BAG_KG} KG</div>}</div>
        <Field label="Virgin Plastic (BAGS)" value={virginBags} onChange={v=>{setVirginBags(v);setErr("");}} type="number" ph="e.g. 3" accent="#7B3FB5"/>
        {totalPlastic>0&&<div style={{marginTop:8,background:"#fff",borderRadius:8,padding:"10px 12px",fontSize:12,display:"flex",gap:20,flexWrap:"wrap"}}>
          <div>Virgin: <strong>{vBags} bags = {vKg.toFixed(0)} KG</strong></div></div>}</div>
      <div style={{background:"#F0F4F8",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:NAVY,marginBottom:10}}>⚖️ Weigh Output (before sorting)</div>
        <Field label="Actual Weight (KG)" value={weightBefore} onChange={v=>{setWeightBefore(v);setErr("");}} type="number" ph="0.00" accent={ACCENT}/>
        {wBef>0&&thKg>0&&<div style={{marginTop:8,background:"#fff",borderRadius:8,padding:"10px 12px",fontSize:12}}>
          <div style={{marginBottom:4}}>≈ <strong>{kgToPcs(wBef,capWt).toLocaleString()} pcs</strong> vs {thPcs.toLocaleString()} theoretical<CheckBadge actual={wBef} expected={thKg}/></div>
          {totalPlastic>0&&<div style={{borderTop:"1px solid #E2E8F0",paddingTop:5,color:"#555"}}>
            Loss at injection: <strong style={{color:(totalPlastic-wBef)>totalPlastic*0.05?"#DC3545":"#1A6B2A"}}>{(totalPlastic-wBef).toFixed(2)} KG</strong> (purge, sprue, spillage)
            {inj>0&&<span> vs <strong>{theoWasteKg.toFixed(2)} KG</strong> expected<CheckBadge actual={actualLossKg} expected={theoWasteKg}/></span>}</div>}</div>}</div>
      <div style={{marginBottom:14}}><Field label="Notes (optional)" value={notes} onChange={setNotes} accent="#856404"/></div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      {!existing&&vBags>0&&selPlastic&&<div style={{background:"#E8F5E9",border:"1px solid #A5D6A7",borderRadius:8,padding:"9px 12px",marginBottom:10,fontSize:12,color:"#1A6B2A",fontWeight:600}}>
        On save: <strong>{vBags} bags</strong> will be deducted from lot <strong>{selPlastic.lotNumber}</strong> → {Math.max(0,availBags-vBags)} bags left</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#856404",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>{existing?"💾 Save Changes":"Save Injection → Plastic Sorting"}</button>
    </div></div>);
}
function PlasticSortingForm({sub,employees,existing,onSave,onCancel}){
  const [accKg,setAccKg]=useState(sub.acceptedWeightKg||""),[rejKg,setRejKg]=useState(sub.rejectedWeightKg||""),[date,setDate]=useState(sub.sortingDate||today()),[err,setErr]=useState("");
  const [plasticSorters,setPlasticSorters]=useState(sub.plasticSorters||[]);
  const capWt=sub.capWt||CAP_WT;
  const acc=Number(accKg)||0,rej=Number(rejKg)||0,total=acc+rej,prev=sub.weightBeforeSorting||0;
  const accPcs=kgToPcs(acc,capWt),rejPcs=kgToPcs(rej,capWt);
  const save=()=>{if(acc<=0){setErr("Enter accepted weight.");return;}
    onSave(Object.assign({},sub,{stage:sub.stage==="Plastic Sorting"?"Assembly":sub.stage,status:sub.stage==="Plastic Sorting"?"Assembly":sub.status,
      acceptedWeightKg:acc,rejectedWeightKg:rej,acceptedPcs:accPcs,rejectedPcs:rejPcs,sortingDate:date,plasticSorters:plasticSorters}));};
  return(<div style={{maxWidth:640,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#0C5460",borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>🔍 Plastic Sorting — {sub.batchNo}</div><div style={{color:"rgba(255,255,255,0.65)",fontSize:12}}>{existing?"Editing saved data":"Stage 2 of 4"}</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{background:"#D1ECF1",borderRadius:10,padding:12,marginBottom:14,fontSize:12,color:"#0C5460"}}>
        <div style={{fontWeight:700,marginBottom:4}}>From Injection:</div>
        <div>Pre-sort weight: <strong>{prev.toFixed(2)} KG</strong> ≈ {kgToPcs(prev,capWt).toLocaleString()} pcs</div>
        <div>{sub.injections} injections × {sub.cavities||PCS_INJ} = <strong>{(sub.theoreticalPcs||0).toLocaleString()} pcs theoretical</strong></div></div>
      <div style={{marginBottom:12}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Sorting Date</label>
        <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <Field label="✅ Accepted Weight (KG)" value={accKg} onChange={v=>{setAccKg(v);setErr("");}} type="number" ph="0.00" accent="#0C5460"/>
        <Field label="✗ Rejected Weight (KG)" value={rejKg} onChange={v=>{setRejKg(v);setErr("");}} type="number" ph="0.00" accent="#0C5460"/></div>
      {(acc>0||rej>0)&&<div style={{background:"#F7F9FC",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,fontSize:12}}>
          <div><div style={{color:"#888",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Accepted</div><div style={{fontWeight:900,fontSize:16,color:"#1A6B2A"}}>{acc.toFixed(2)} KG</div><div style={{color:"#888"}}>{accPcs.toLocaleString()} pcs</div></div>
          <div><div style={{color:"#888",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Rejected</div><div style={{fontWeight:900,fontSize:16,color:"#DC3545"}}>{rej.toFixed(2)} KG</div><div style={{color:"#888"}}>{rejPcs.toLocaleString()} pcs</div></div>
          <div><div style={{color:"#888",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Total vs Pre-sort</div><div style={{fontWeight:900,fontSize:14,color:NAVY}}>{total.toFixed(2)} KG</div><CheckBadge actual={total} expected={prev}/></div></div></div>}
      <div style={{background:"#D1ECF1",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:13,color:"#0C5460",marginBottom:4}}>👷 Who sorted this shift</div>
        <div style={{fontSize:11,color:"#0C5460",opacity:0.8,marginBottom:10}}>Optional — add each sorter and what she personally sorted, for accurate wages and the productivity charts. Leave empty to skip.</div>
        <SorterPicker employees={employees} station="Plastic Sorting" value={plasticSorters} onChange={setPlasticSorters}/></div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#0C5460",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>{existing?"💾 Save Changes":"Save Sorting → Assembly"}</button>
    </div></div>);
}
function AssemblyForm({sub,data,employees,existing,onSave,onCancel}){
  const e=existing?sub:{};
  const [sels,setSels]=useState((sub.aluminumSelections&&sub.aluminumSelections.length)?sub.aluminumSelections:[]);
  const [pickLotId,setPickLotId]=useState(""),[pickBags,setPickBags]=useState([]);
  const [asmKg,setAsmKg]=useState(sub.assembledWeightKg||""),[date,setDate]=useState(sub.assemblyDate||today()),[err,setErr]=useState("");
  const [assemblyWorkers,setAssemblyWorkers]=useState(sub.assemblyWorkers||[]);
  const alLots=((data&&data["Aluminum Caps"]&&data["Aluminum Caps"].lots)||[]).filter(l=>(l.status==="In Stock"||l.status==="Low Stock")&&l.bags&&l.bags.length);
  const pickLot=pickLotId?alLots.filter(l=>l.id===pickLotId)[0]:null;
  const alreadyUsed={};sels.forEach(s=>{s.bagIds.forEach(b=>{alreadyUsed[s.lotId+"|"+b]=1;});});
  const availBags=pickLot?pickLot.bags.filter(b=>!b.used&&!alreadyUsed[pickLot.id+"|"+b.id]):[];
  const bagPcs=(lot,ids)=>lot.bags.filter(b=>ids.indexOf(b.id)>=0).reduce((s,b)=>s+(b.qtyUnit==="Pcs"?b.qty:kgToPcs(b.qty,0.405)),0);
  const alPcsIn=sels.reduce((s,x)=>s+(x.pcs||0),0);
  const accPcs=sub.acceptedPcs||0;
  const asmWt=sub.asmWt||ASM_WT;
  const asm=Number(asmKg)||0,asmPcs=kgToPcs(asm,asmWt);
  const addSel=()=>{
    if(!pickLotId||!pickBags.length){setErr("Pick a lot and at least one bag.");return;}
    const pcs=bagPcs(pickLot,pickBags);
    setSels(sels.concat([{lotId:pickLot.id,lotNo:pickLot.lotNumber,bagIds:pickBags,pcs:pcs}]));
    setPickLotId("");setPickBags([]);setErr("");
  };
  const save=()=>{if(asm<=0){setErr("Enter assembly output weight.");return;}
    onSave(Object.assign({},sub,{stage:sub.stage==="Assembly"?"Final Sorting":sub.stage,status:sub.stage==="Assembly"?"Final Sorting":sub.status,
      assemblyDate:date,assemblyOperator:assemblyWorkers.map(w=>w.name).join(", "),assemblyWorkers:assemblyWorkers,aluminumSelections:sels,aluminumLotNo:sels.map(s=>s.lotNo).join(", ")||null,aluminumPcsIn:alPcsIn||null,
      assembledWeightKg:asm,assembledPcs:asmPcs}),{selections:sels});};
  return(<div style={{maxWidth:680,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#4A1A6E",borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>⚙️ Assembly — {sub.batchNo}</div><div style={{color:"rgba(255,255,255,0.65)",fontSize:12}}>{existing?"Editing saved data":"Stage 3 of 4"}</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{background:"#EDE0FF",borderRadius:10,padding:12,marginBottom:14,fontSize:12,color:"#4A1A6E"}}>
        <div style={{fontWeight:700,marginBottom:4}}>From Plastic Sorting:</div>
        <div>Accepted plastic caps in: <strong>{accPcs.toLocaleString()} pcs</strong> ({(sub.acceptedWeightKg||0).toFixed(2)} KG)</div></div>
      <div style={{marginBottom:12}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Assembly Date</label>
        <input type="date" value={date} onChange={ev=>setDate(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
      <div style={{background:"#EDE0FF",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:13,color:"#4A1A6E",marginBottom:4}}>👷 Workers on this shift</div>
        <div style={{fontSize:11,color:"#7B3FB5",marginBottom:10}}>If a sorting girl covered this, add her here and set her wage to 0 if it&apos;s free double duty (or leave it if you&apos;re paying extra) — otherwise add whoever did it (e.g. Mohamed, Nagy) with their real wage. Leave empty only if you don&apos;t know/care who — that counts as a flat cost instead (set in Finance settings).</div>
        <WorkerPicker employees={employees} station={["Assembly","Plastic Sorting","Final Sorting"]} value={assemblyWorkers} onChange={setAssemblyWorkers}/></div>
      <div style={{background:"#F7F0FF",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:13,color:"#4A1A6E",marginBottom:4}}>🔘 Aluminum Caps Used</div>
        <div style={{fontSize:11,color:"#7B3FB5",marginBottom:10}}>Add from as many lots as you need — lots often run out mid-shift</div>
        {sels.length>0&&<div style={{marginBottom:10,display:"flex",flexDirection:"column",gap:6}}>
          {sels.map((s,i)=>(<div key={i} style={{background:"#fff",borderRadius:8,padding:"8px 12px",display:"flex",justifyContent:"space-between",alignItems:"center",border:"1px solid #E2E8F0"}}>
            <div style={{fontSize:12}}><strong style={{fontFamily:"monospace",color:"#4A1A6E"}}>{s.lotNo}</strong>
              <span style={{color:"#888",marginLeft:8}}>{s.bagIds.length} bags · {s.pcs.toLocaleString()} pcs</span>
              <div style={{fontSize:10,color:"#aaa",marginTop:2}}>{s.bagIds.join(", ")}</div></div>
            <button type="button" onClick={()=>setSels(sels.filter((_,j)=>j!==i))} style={{background:"#FFF0F0",border:"none",borderRadius:6,padding:"5px 9px",cursor:"pointer",fontSize:13,color:"#DC3545"}}>🗑</button></div>))}
          <div style={{background:"#EDE0FF",borderRadius:8,padding:"8px 12px",fontSize:12,fontWeight:700,color:"#4A1A6E"}}>Total: {alPcsIn.toLocaleString()} shells from {sels.length} lot{sels.length!==1?"s":""}</div></div>}
        <div style={{background:"#fff",borderRadius:8,padding:12,border:"1px dashed #C9A8E8"}}>
          <div style={{fontSize:11,fontWeight:700,color:"#7B3FB5",marginBottom:8,textTransform:"uppercase"}}>Add a lot</div>
          <select value={pickLotId} onChange={ev=>{setPickLotId(ev.target.value);setPickBags([]);}} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff",marginBottom:8}}>
            <option value="">— select aluminum lot —</option>
            {alLots.map(l=>{const av=l.bags.filter(b=>!b.used&&!alreadyUsed[l.id+"|"+b.id]).length;
              return av>0?<option key={l.id} value={l.id}>{l.lotNumber} · {av} bags available</option>:null;})}</select>
          {pickLot&&availBags.length>0&&<BagGrid bags={pickLot.bags.filter(b=>!alreadyUsed[pickLot.id+"|"+b.id])} matConfig={MATERIAL_META["Aluminum Caps"]} selMode selected={pickBags} onSelect={setPickBags} onToggle={()=>{}}/>}
          {pickBags.length>0&&<button type="button" onClick={addSel} style={{marginTop:10,width:"100%",padding:10,background:"#7B3FB5",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:13,cursor:"pointer"}}>+ Add {pickBags.length} bags from {pickLot.lotNumber}</button>}
        </div></div>
      <div style={{background:"#F0F4F8",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:13,color:NAVY,marginBottom:10}}>⚖️ Assembly Machine Output</div>
        <Field label="Total Output Weight (KG)" value={asmKg} onChange={v=>{setAsmKg(v);setErr("");}} type="number" ph="0.00" accent="#7B3FB5"/>
        <div style={{fontSize:11,color:"#888",marginTop:5}}>Everything out of the machine — sorted in the next stage</div></div>
      {asm>0&&<div style={{background:"#F7F9FC",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontSize:12,marginBottom:10}}>
          <div style={{color:"#888",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Assembled Output</div>
          <div style={{fontWeight:900,fontSize:20,color:"#4A1A6E"}}>{asmPcs.toLocaleString()} pcs</div>
          <div style={{color:"#888"}}>{asm.toFixed(2)} KG ÷ {asmWt} g/cap</div></div>
        <div style={{borderTop:"1px solid #E2E8F0",paddingTop:10,fontSize:12,display:"flex",flexDirection:"column",gap:5}}>
          <div style={{display:"flex",justifyContent:"space-between"}}><span>🧴 Plastic in {accPcs.toLocaleString()} → out {asmPcs.toLocaleString()}</span>
            <span style={{fontWeight:700,color:Math.abs(accPcs-asmPcs)>accPcs*0.05?"#DC3545":"#1A6B2A"}}>{(accPcs-asmPcs).toLocaleString()} lost<CheckBadge actual={asmPcs} expected={accPcs}/></span></div>
          {alPcsIn>0&&<div style={{display:"flex",justifyContent:"space-between"}}><span>🔘 Aluminum in {alPcsIn.toLocaleString()} → out {asmPcs.toLocaleString()}</span>
            <span style={{fontWeight:700,color:Math.abs(alPcsIn-asmPcs)>alPcsIn*0.05?"#DC3545":"#1A6B2A"}}>{(alPcsIn-asmPcs).toLocaleString()} unused<CheckBadge actual={asmPcs} expected={alPcsIn}/></span></div>}</div></div>}
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#4A1A6E",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>{existing?"💾 Save Changes":"Save Assembly → Final Sorting"}</button>
    </div></div>);
}
function FinalSortingForm({sub,parentBatch,data,employees,existing,onSave,onCancel}){
  const [accKg,setAccKg]=useState(sub.finalAcceptedKg||""),[rejKg,setRejKg]=useState(sub.finalRejectedKg||"");
  const [date,setDate]=useState(sub.finalSortDate||today()),[err,setErr]=useState("");
  const [finalSorters,setFinalSorters]=useState(sub.finalSorters||[]);
  const [packedCartons,setPackedCartons]=useState(sub.finalCartons||""),[packedBags,setPackedBags]=useState(sub.finalPartialBags||""),[packedKg,setPackedKg]=useState(sub.finalPartialKg||"");
  const [cartonsLotId,setCartonsLotId]=useState(sub.cartonsLotId||"");
  const cartonsLots=((data&&data["Cartons"]&&data["Cartons"].lots)||[]).filter(l=>l.status!=="Out of Stock"||l.id===sub.cartonsLotId);
  const selCartons=cartonsLotId?cartonsLots.filter(l=>l.id===cartonsLotId)[0]:null;
  const acc=Number(accKg)||0,rej=Number(rejKg)||0;
  const asmWt=sub.asmWt||ASM_WT;
  const accPcs=kgToPcs(acc,asmWt),rejPcs=kgToPcs(rej,asmWt);
  const asmIn=sub.assembledPcs||0;
  const bpc=Number(parentBatch&&parentBatch.bagsPerCarton)||0,ppb=Number(parentBatch&&parentBatch.pcsPerBag)||0;
  const fullBagKg=ppb>0?pcsToKg(ppb,asmWt):0;
  const canCheckPacked=bpc>0&&ppb>0&&(packedCartons!==""||packedBags!==""||packedKg!=="");
  const packedPcs=(Number(packedCartons)||0)*bpc*ppb+(Number(packedBags)||0)*ppb+kgToPcs(Number(packedKg)||0,asmWt);
  const packedShort=canCheckPacked?Math.max(0,accPcs-packedPcs):0;
  const cartonsUsed=Number(packedCartons)||0;
  const save=()=>{if(acc<=0){setErr("Enter accepted weight.");return;}
    if(cartonsUsed>0&&!cartonsLotId){setErr("Select which Cartons lot was used.");return;}
    if(selCartons&&!existing&&cartonsUsed>Number(selCartons.qtyRemaining)+0.01){setErr("Only "+fmtN(selCartons.qtyRemaining)+" cartons available in that lot.");return;}
    onSave(Object.assign({},sub,{stage:"Complete",status:"Complete",finalSortDate:date,finalSortOperator:finalSorters.map(w=>w.name).join(", "),finalSorters:finalSorters,
      finalAcceptedKg:acc,finalRejectedKg:rej,finalAcceptedPcs:accPcs,finalRejectedPcs:rejPcs,
      finalCartons:cartonsUsed,finalPartialBags:Number(packedBags)||0,finalPartialKg:Number(packedKg)||0,
      cartonsLotId:cartonsLotId||null,cartonsLotNo:selCartons?selCartons.lotNumber:null,cartonsUsed:cartonsUsed,
      goodPcs:accPcs,totalPcs:accPcs}),{cartonsLotId:cartonsLotId||null,cartonsUsed:cartonsUsed});};
  return(<div style={{maxWidth:680,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#B8860B",borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>📦 Final Sorting — {sub.batchNo}</div><div style={{color:"rgba(255,255,255,0.65)",fontSize:12}}>{existing?"Editing saved data":"Stage 4 of 4"}</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{background:"#FFF8DC",borderRadius:10,padding:12,marginBottom:14,fontSize:12,color:"#8B6914"}}>
        <div style={{fontWeight:700,marginBottom:4}}>From Assembly:</div>
        <div>Assembled caps in: <strong>{asmIn.toLocaleString()} pcs</strong> ({(sub.assembledWeightKg||0).toFixed(2)} KG)</div></div>
      <div style={{marginBottom:12}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date</label>
        <input type="date" value={date} onChange={e=>setDate(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
      <div style={{background:"#FFF8DC",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:13,color:"#8B6914",marginBottom:4}}>👷 Who sorted this shift</div>
        <div style={{fontSize:11,color:"#A08030",marginBottom:10}}>Optional — add each sorter and what she personally sorted, for accurate wages and the productivity charts. Leave empty to skip.</div>
        <SorterPicker employees={employees} station="Final Sorting" value={finalSorters} onChange={setFinalSorters}/></div>
      <div style={{background:"#FFFCF0",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:13,color:"#8B6914",marginBottom:10}}>⚖️ Final Sort Results</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
          <Field label="✅ Accepted (KG)" value={accKg} onChange={v=>{setAccKg(v);setErr("");}} type="number" ph="0.00" accent="#B8860B"/>
          <Field label="✗ Rejected (KG)" value={rejKg} onChange={v=>{setRejKg(v);setErr("");}} type="number" ph="0.00" accent="#B8860B"/></div>
        {acc>0&&<div style={{marginTop:10,background:"#fff",borderRadius:8,padding:"10px 12px",fontSize:12}}>
          <div style={{display:"flex",gap:20,marginBottom:5}}>
            <div>✅ <strong style={{color:"#1A6B2A",fontSize:15}}>{accPcs.toLocaleString()} pcs</strong></div>
            <div>✗ <strong style={{color:"#DC3545",fontSize:15}}>{rejPcs.toLocaleString()} pcs</strong></div></div>
          <div style={{borderTop:"1px solid #E2E8F0",paddingTop:5,display:"flex",justifyContent:"space-between"}}>
            <span>In {asmIn.toLocaleString()} → Out {(accPcs+rejPcs).toLocaleString()}</span><CheckBadge actual={accPcs+rejPcs} expected={asmIn}/></div></div>}</div>
      <div style={{background:"#FFFCF0",borderRadius:10,padding:14,marginBottom:12}}>
        <div style={{fontWeight:700,fontSize:13,color:"#8B6914",marginBottom:2}}>📦 Packed As</div>
        <div style={{fontSize:11,color:"#A08030",marginBottom:10}}>Whole cartons this shift, plus a leftover bag that is not full — write it as a decimal, e.g. a bag that is half full is 0.5 (or use +KG if you know its weight instead — a full bag weighs {fullBagKg>0?fmt(fullBagKg)+" KG":"pcs/bag × piece weight"}, so we work out the fraction for you)</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
          <Field label="Cartons" value={packedCartons} onChange={setPackedCartons} type="number" ph="e.g. 5" accent="#B8860B"/>
          <Field label="+ Bags (decimal OK)" value={packedBags} onChange={setPackedBags} type="number" ph="e.g. 0.5" accent="#B8860B"/>
          <Field label="+ KG (optional)" value={packedKg} onChange={setPackedKg} type="number" ph="e.g. 2" accent="#B8860B"/></div>
        {cartonsUsed>0&&<div style={{marginTop:10}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Cartons Used From Stock — Draw From Lot</label>
          <select value={cartonsLotId} onChange={e=>{setCartonsLotId(e.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid "+(cartonsLots.length?"#E2E8F0":"#F1948A"),borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— not specified —</option>
            {cartonsLots.map(l=><option key={l.id} value={l.id}>{l.lotNumber} · {fmtN(l.qtyRemaining)} cartons available</option>)}</select>
          {cartonsLots.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No Cartons lots in inventory — go to Inventory → Cartons first.</div>}
          {selCartons&&<div style={{fontSize:11,color:"#8B6914",marginTop:5}}>{fmtN(selCartons.qtyRemaining)} cartons available · using {cartonsUsed}</div>}</div>}
        {ppb>0&&Number(packedBags)>0&&<div style={{fontSize:11,color:"#8B6914",marginTop:6}}>{packedBags} bag{Number(packedBags)===1?"":"s"} ≈ {fmtN(Number(packedBags)*ppb)} pcs</div>}
        {fullBagKg>0&&Number(packedKg)>0&&<div style={{fontSize:11,color:"#8B6914",marginTop:2}}>{packedKg} KG ≈ {(Number(packedKg)/fullBagKg).toFixed(2)} of a full bag ({fmt(fullBagKg)} KG)</div>}
        {canCheckPacked&&<div style={{marginTop:10,background:"#fff",borderRadius:8,padding:"10px 12px",fontSize:12}}>
          <div style={{display:"flex",justifyContent:"space-between"}}>
            <span>Accepted {accPcs.toLocaleString()} → Packed {packedPcs.toLocaleString()}</span><CheckBadge actual={packedPcs} expected={accPcs}/></div>
          {packedShort>0&&<div style={{marginTop:6,color:"#DC3545",fontWeight:700}}>⚠️ {packedShort.toLocaleString()} accepted pcs not accounted for in cartons — check for wasted/lost sorted product.</div>}</div>}
        {bpc<=0||ppb<=0?<div style={{marginTop:8,fontSize:11,color:"#999"}}>Set Bags per Carton and Pcs per Bag on the batch to check packed quantity against accepted.</div>:null}</div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#B8860B",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>{existing?"💾 Save Changes":"✅ Complete Shift"}</button>
    </div></div>);
}

// ══ SHIFT MANAGER ═════════════════════════════════════════════════════════
// Logs leftover material from a different (usually earlier) batch of the same color as a
// shift on THIS batch, dropped in at whichever stage it's already reached — no fresh material
// draw, since it was already consumed under the original batch.
function CarryoverForm({parentBatch,batches,data,onSave,onCancel}){
  const mySubs=batches.filter(b=>b.parentBatchNo===parentBatch.batchNo&&b.isSubBatch);
  const priorCarryovers=mySubs.filter(b=>b.isCarryover).length;
  const subNo=parentBatch.batchNo+"-CO"+(priorCarryovers+1);
  const sourceOptions=batches.filter(b=>!b.isSubBatch&&b.batchNo!==parentBatch.batchNo);
  const wipLots=((data&&data["WIP Inventory"]&&data["WIP Inventory"].lots)||[]).filter(l=>l.status!=="Out of Stock"&&Number(l.qtyRemaining)>0);
  const [source,setSource]=useState("batch");   // "batch" | "wip"
  const [sourceBatchNo,setSourceBatchNo]=useState(""),[type,setType]=useState("plastic");
  const [wipLotId,setWipLotId]=useState(""),[wipPcs,setWipPcs]=useState("");
  const [qty,setQty]=useState(""),[cartons,setCartons]=useState(""),[notes,setNotes]=useState(""),[err,setErr]=useState("");
  const bpc=Number(parentBatch.bagsPerCarton)||0,ppb=Number(parentBatch.pcsPerBag)||0;
  const capWt=parentBatch.capWt||CAP_WT,asmWt=parentBatch.asmWt||ASM_WT;
  const TYPES=[["plastic","Sorted plastic — ready for Assembly"],["assembled","Assembled — ready for Final Sorting"],["finished","Finished goods — fully packed, ready to ship"]];
  // A WIP Inventory lot's description starts with its stage ("Unsorted/Sorted Plastic",
  // "Unsorted/Sorted Assembled", "Packed") — matched against the carryover type so only
  // stock that's actually at the right stage shows up as a source.
  const wipTypeMatch=l=>{
    const d=l.description||"";
    if(type==="plastic")return d.indexOf("Plastic")>=0&&d.indexOf("Assembled")<0;
    if(type==="assembled")return d.indexOf("Assembled")>=0;
    return d.indexOf("Packed")>=0;
  };
  const matchedWipLots=wipLots.filter(wipTypeMatch);
  const selWip=wipLotId?wipLots.filter(l=>l.id===wipLotId)[0]:null;
  const wipRemaining=selWip?Number(selWip.qtyRemaining):0;
  const cartonPcs=type==="finished"?Number(cartons)||0:0;
  const manualQty=cartonPcs>0?cartonPcs*bpc*ppb:Number(qty)||0;
  const wipQty=Number(wipPcs)||0;
  const effectiveQty=source==="wip"?wipQty:manualQty;
  const save=()=>{
    if(source==="batch"&&!sourceBatchNo){setErr("Select which batch this carried over from.");return;}
    if(source==="wip"&&!wipLotId){setErr("Select which WIP Inventory lot this came from.");return;}
    if(effectiveQty<=0){setErr("Enter a quantity.");return;}
    if(source==="wip"&&wipQty>wipRemaining+0.5){setErr("Only "+fmtN(wipRemaining)+" pcs left in that lot.");return;}
    const fromLabel=source==="wip"?selWip.lotNumber:sourceBatchNo;
    const base={id:genId(),batchNo:subNo,isSubBatch:true,parentBatchNo:parentBatch.batchNo,product:parentBatch.product,
      color:parentBatch.color,client:parentBatch.client,orderNo:parentBatch.orderNo,
      cartons:0,bagsPerCarton:0,pcsPerBag:0,partialCartonBags:0,
      mfgDate:parentBatch.mfgDate,shift:null,operator:"",
      isCarryover:true,carryoverFrom:fromLabel,capWt:capWt,asmWt:asmWt,
      wipLotId:source==="wip"?wipLotId:null,wipLotNo:source==="wip"?selWip.lotNumber:null,wipPcsUsed:source==="wip"?effectiveQty:0,
      notes:"Carried over from "+fromLabel+(notes?" — "+notes:""),createdAt:today()};
    let payload;
    if(type==="plastic")payload=Object.assign({},base,{stage:"Assembly",status:"Assembly",
      acceptedWeightKg:pcsToKg(effectiveQty,capWt),acceptedPcs:effectiveQty,rejectedWeightKg:0,rejectedPcs:0,sortingDate:today(),aluminumSelections:[]});
    else if(type==="assembled")payload=Object.assign({},base,{stage:"Final Sorting",status:"Final Sorting",
      assembledWeightKg:pcsToKg(effectiveQty,asmWt),assembledPcs:effectiveQty,assemblyDate:today()});
    else payload=Object.assign({},base,{stage:"Complete",status:"Complete",
      assembledWeightKg:pcsToKg(effectiveQty,asmWt),assembledPcs:effectiveQty,assemblyDate:today(),
      finalAcceptedKg:pcsToKg(effectiveQty,asmWt),finalRejectedKg:0,finalAcceptedPcs:effectiveQty,finalRejectedPcs:0,
      finalSortDate:today(),finalSortOperator:"",goodPcs:effectiveQty,totalPcs:effectiveQty});
    onSave(payload,source==="wip"?{wipLotId:wipLotId,wipPcsUsed:effectiveQty}:null);
  };
  return(<div style={{maxWidth:640,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#4A6741",borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>↩️ Log Carryover — {subNo}</div><div style={{color:"rgba(255,255,255,0.65)",fontSize:12}}>Leftover from a previous batch, or from saved WIP Inventory stock</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{marginBottom:14}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Where From?</label>
        <div style={{display:"flex",gap:8}}>
          {[["batch","Another Batch"],["wip","WIP Inventory Stock"]].map(([k,label])=>(
            <div key={k} onClick={()=>{setSource(k);setErr("");}} style={{flex:1,padding:"9px 12px",borderRadius:9,border:"2px solid "+(source===k?"#4A6741":"#E2E8F0"),background:source===k?"#EEF3EC":"#fff",cursor:"pointer",textAlign:"center",fontWeight:source===k?700:500,fontSize:13,color:source===k?"#4A6741":"#444"}}>{label}</div>))}</div></div>
      <div style={{marginBottom:14}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>What Stage Is It At?</label>
        <div style={{display:"flex",flexDirection:"column",gap:8}}>
          {TYPES.map(t=>(<div key={t[0]} onClick={()=>{setType(t[0]);setWipLotId("");setWipPcs("");setErr("");}} style={{padding:"10px 14px",borderRadius:9,border:"2px solid "+(type===t[0]?"#4A6741":"#E2E8F0"),background:type===t[0]?"#EEF3EC":"#fff",cursor:"pointer",fontSize:13,fontWeight:type===t[0]?700:500,color:type===t[0]?"#4A6741":"#444"}}>{t[1]}</div>))}</div></div>
      {source==="batch"?(<>
        <div style={{marginBottom:14}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Carried Over From Batch</label>
          <select value={sourceBatchNo} onChange={e=>{setSourceBatchNo(e.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— select batch —</option>
            {sourceOptions.map(b=><option key={b.id} value={b.batchNo}>{b.batchNo} · {b.color}{b.client?" · "+b.client:""}</option>)}</select></div>
        {type==="finished"?(<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label="Cartons" value={cartons} onChange={v=>{setCartons(v);setErr("");}} type="number" ph="e.g. 6" accent="#4A6741"/>
          <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>= Pcs</label>
            <div style={{padding:"9px 12px",background:"#F7F9FC",borderRadius:8,fontSize:13,color:"#555"}}>{bpc&&ppb?fmtN(cartonPcs*bpc*ppb):"set cartons/bags/pcs on "+parentBatch.batchNo+" first"}</div></div></div>)
        :(<div style={{marginBottom:14}}><Field label="Quantity (Pcs) *" value={qty} onChange={v=>{setQty(v);setErr("");}} type="number" ph="e.g. 15000" accent="#4A6741"/></div>)}
      </>):(<div style={{marginBottom:14}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>WIP Inventory Lot</label>
        <select value={wipLotId} onChange={e=>{setWipLotId(e.target.value);setWipPcs("");setErr("");}} style={{width:"100%",border:"1.5px solid "+(matchedWipLots.length?"#E2E8F0":"#F1948A"),borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
          <option value="">— select lot —</option>
          {matchedWipLots.map(l=><option key={l.id} value={l.id}>{l.lotNumber} · {fmtN(l.qtyRemaining)} pcs · {l.description}</option>)}</select>
        {matchedWipLots.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No WIP Inventory stock at this stage yet — change the stage above, or save leftover stock from a batch first.</div>}
        {selWip&&<div style={{marginTop:10}}>
          <Field label="Pcs to Use" value={wipPcs} onChange={v=>{setWipPcs(v);setErr("");}} type="number" ph={"up to "+fmtN(wipRemaining)} accent="#4A6741"/>
          <div style={{fontSize:11,color:"#4A6741",marginTop:4}}>{fmtN(wipRemaining)} pcs available <button type="button" onClick={()=>setWipPcs(String(wipRemaining))} style={{marginLeft:8,background:"none",border:"none",color:"#4A6741",textDecoration:"underline",cursor:"pointer",fontSize:11,padding:0}}>use all</button></div></div>}
      </div>)}
      <div style={{marginBottom:18}}><Field label="Notes (optional)" value={notes} onChange={setNotes} accent="#4A6741"/></div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#4A6741",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Log Carryover</button>
    </div></div>);
}
// Saves leftover WIP from this batch (unsorted/sorted plastic or assembled caps that never
// made it to Final Sorting) as its own inventory lot — client/color/mold tagged — so it's
// visible in stock the next time an order needs that combination, instead of getting lost.
function SaveLeftoverForm({parentBatch,onSave,onClose}){
  const mc=MATERIAL_META["WIP Inventory"];
  const [stage,setStage]=useState("Unsorted Plastic"),[mold,setMold]=useState("No Logo"),[color,setColor]=useState(parentBatch.color||""),[company,setCompany]=useState(parentBatch.client||"");
  const [weightKg,setWeightKg]=useState("");
  const [cartons,setCartons]=useState(""),[bags,setBags]=useState(""),[kg,setKg]=useState("");
  const [notes,setNotes]=useState(""),[err,setErr]=useState("");
  const STAGES_WIP=["Unsorted Plastic","Sorted Plastic","Unsorted Assembled","Sorted Assembled","Packed"];
  const isPacked=stage==="Packed";
  const bpc=Number(parentBatch.bagsPerCarton)||0,ppb=Number(parentBatch.pcsPerBag)||0;
  const canCheckPacked=bpc>0&&ppb>0;
  const pieceWt=stage.indexOf("Assembled")>=0?(parentBatch.asmWt||ASM_WT):(parentBatch.capWt||CAP_WT);
  const wt=Number(weightKg)||0;
  const ct=Number(cartons)||0,bg=Number(bags)||0,kgVal=Number(kg)||0;
  const packedPcs=canCheckPacked?ct*bpc*ppb+bg*ppb+kgToPcs(kgVal,parentBatch.asmWt||ASM_WT):0;
  const pcs=isPacked?packedPcs:kgToPcs(wt,pieceWt);
  const save=()=>{
    if(isPacked){
      if(!canCheckPacked){setErr("Set Bags/Carton and Pcs/Bag on "+parentBatch.batchNo+" first so cartons/bags can convert to pcs.");return;}
      if(ct<=0&&bg<=0&&kgVal<=0){setErr("Enter cartons, bags, or KG packed.");return;}
    }else if(wt<=0){setErr("Enter the leftover weight in KG.");return;}
    const qtyDesc=isPacked
      ?[ct?ct+" carton"+(ct===1?"":"s"):"",bg?bg+" bag"+(bg===1?"":"s"):"",kgVal?fmt(kgVal)+" KG":""].filter(Boolean).join(" + ")
      :fmt(wt)+" KG @ "+pieceWt+" g/pc";
    onSave({id:genId(),lotNumber:"WIP-"+parentBatch.batchNo+"-"+genId().slice(-4),plNo:"",date:today(),
      supplier:company.trim(),
      description:stage+" — "+(mold.trim()||"unspecified mold")+" — "+(color.trim()||"any color")+(company.trim()?" — "+company.trim():""),
      qtyReceived:pcs,unit:"Pcs",qtyRemaining:pcs,unitCost:"",status:"In Stock",
      notes:"From "+parentBatch.batchNo+" — "+qtyDesc+(notes?" — "+notes:""),image:null,usageLog:[]});
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:480,maxHeight:"92vh",overflowY:"auto"}}>
      <div style={{background:mc.color,borderRadius:"16px 16px 0 0",padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>{mc.emoji} Save Leftover to Stock</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{parentBatch.batchNo} · {parentBatch.color}{parentBatch.client?" · "+parentBatch.client:""}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{marginBottom:14}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>What Is It?</label>
          <div style={{display:"flex",flexDirection:"column",gap:8}}>
            {STAGES_WIP.map(s=>(<div key={s} onClick={()=>{setStage(s);setErr("");}} style={{padding:"10px 14px",borderRadius:9,border:"2px solid "+(stage===s?mc.color:"#E2E8F0"),background:stage===s?mc.light:"#fff",cursor:"pointer",fontSize:13,fontWeight:stage===s?700:500,color:stage===s?mc.color:"#444"}}>{s}</div>))}</div></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label="Mold / Logo" value={mold} onChange={setMold} ph="e.g. No Logo" accent={mc.accent}/>
          <Field label="Color" value={color} onChange={setColor} ph="e.g. Green" accent={mc.accent}/>
          <Field label="Company" value={company} onChange={setCompany} ph="e.g. Global Napi" accent={mc.accent}/>
          {!isPacked&&<Field label="Weight (KG) *" value={weightKg} onChange={v=>{setWeightKg(v);setErr("");}} type="number" ph="e.g. 56" accent={mc.accent}/>}</div>
        {isPacked&&<div style={{marginBottom:14}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Packed As</label>
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10}}>
            <Field label="Cartons" value={cartons} onChange={v=>{setCartons(v);setErr("");}} type="number" ph="e.g. 12" accent={mc.accent}/>
            <Field label="Bags" value={bags} onChange={v=>{setBags(v);setErr("");}} type="number" ph="e.g. 1" accent={mc.accent}/>
            <Field label="KG (partial)" value={kg} onChange={v=>{setKg(v);setErr("");}} type="number" ph="e.g. 3" accent={mc.accent}/></div>
          {!canCheckPacked&&<div style={{fontSize:11,color:"#DC3545",marginTop:6,fontWeight:600}}>⚠️ Set Bags/Carton and Pcs/Bag on {parentBatch.batchNo} first so cartons/bags convert to pcs.</div>}</div>}
        {(pcs>0)&&<div style={{background:mc.light,borderRadius:8,padding:"9px 12px",marginBottom:14,fontSize:12,color:mc.color}}>
          ≈ <strong>{fmtN(pcs)} pcs</strong>{isPacked?" packed":" at "+pieceWt+" g/pc ("+(stage.indexOf("Assembled")>=0?"assembled":"plastic")+" weight)"}</div>}
        <div style={{marginBottom:18}}><Field label="Notes (optional)" value={notes} onChange={setNotes} accent={mc.accent}/></div>
        {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:mc.accent,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save to WIP Inventory</button>
      </div></div></div>);
}
// Reassigns a full, already-recorded shift from one batch to another — for when Injection ran
// more plastic than a batch needed and the extra shift really belongs to a different order.
// Only offers batches with the same color/client (mold-logo), since a mismatched move would
// mislabel that shift's material and costing under the wrong cap design.
function MoveShiftModal({shift,parentBatch,batches,onMove,onCancel}){
  const candidates=batches.filter(b=>!b.isSubBatch&&b.batchNo!==parentBatch.batchNo&&b.color===parentBatch.color&&(b.client||"")===(parentBatch.client||""));
  const [targetNo,setTargetNo]=useState(""),[err,setErr]=useState("");
  const target=targetNo?candidates.filter(b=>b.batchNo===targetNo)[0]:null;
  const destSubs=target?batches.filter(b=>b.parentBatchNo===target.batchNo&&b.isSubBatch&&!b.isCarryover):[];
  const newLetter=String.fromCharCode(65+destSubs.length);
  const newBatchNo=target?target.batchNo+"-"+newLetter:"";
  const move=()=>{
    if(!target){setErr("Select which batch to move this shift to.");return;}
    onMove(Object.assign({},shift,{batchNo:newBatchNo,parentBatchNo:target.batchNo,product:target.product,
      color:target.color,client:target.client,orderNo:target.orderNo,movedFrom:shift.batchNo,
      notes:(shift.notes?shift.notes+" — ":"")+"Moved from "+parentBatch.batchNo}));
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:460,maxHeight:"92vh",overflowY:"auto"}}>
      <div style={{background:NAVY,borderRadius:"16px 16px 0 0",padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>↪️ Move Shift {shift.batchNo}</div>
          <div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{parentBatch.color}{parentBatch.client?" · "+parentBatch.client:""} — only same color &amp; logo batches shown</div></div>
        <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        {candidates.length===0?(
          <div style={{fontSize:13,color:"#888",background:"#F7F9FC",borderRadius:8,padding:14}}>No other batch with the same color &amp; logo ({parentBatch.color}{parentBatch.client?" · "+parentBatch.client:""}) exists yet. Create that batch first, then come back to move this shift into it.</div>
        ):(<>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Move To Batch</label>
          <select value={targetNo} onChange={e=>{setTargetNo(e.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff",marginBottom:14}}>
            <option value="">— select batch —</option>
            {candidates.map(b=><option key={b.id} value={b.batchNo}>{b.batchNo} · {b.status}</option>)}</select>
          {target&&<div style={{background:"#EBF1F8",borderRadius:8,padding:"10px 12px",marginBottom:14,fontSize:12,color:NAVY}}>
            Will become <strong>{newBatchNo}</strong> — {destSubs.length===0?"first shift on this batch":"shift #"+(destSubs.length+1)+" on this batch"}.</div>}
          {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
          <button type="button" onClick={move} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>↪️ Move Shift</button>
        </>)}
      </div></div></div>);
}
function ShiftManager({parentBatch,batches,data,employees,onClose,onCreateSub,onUpdateSub,onDeleteSub,onSaveLeftover}){
  const [form,setForm]=useState(null);      // {mode:"new"} | {mode:"carryover"} | {subId, stage, editing:bool}
  const [confDel,setConfDel]=useState(null);
  const [showLeftover,setShowLeftover]=useState(false);
  const [moveSub,setMoveSub]=useState(null);
  const mySubs=batches.filter(b=>b.parentBatchNo===parentBatch.batchNo&&b.isSubBatch).sort((a,b)=>a.batchNo.localeCompare(b.batchNo));
  const realShiftCount=mySubs.filter(b=>!b.isCarryover).length;
  const totalGood=mySubs.reduce((s,b)=>s+(b.goodPcs||0),0);
  const target=parentBatch.totalPcs||0;
  const pct=target?Math.min(100,Math.round(totalGood/target*100)):0;
  const wPlastic=mySubs.reduce((s,b)=>s+(b.totalPlasticKg||0),0);
  const wSort=mySubs.reduce((s,b)=>s+(b.rejectedWeightKg||0),0);
  const wFinal=mySubs.reduce((s,b)=>s+(b.finalRejectedKg||0),0);
  // Plastic made so far, independent of assembly/packing — sorted (accepted, ready for
  // Assembly) vs unsorted (injected but not yet through Plastic Sorting) — so it's clear
  // when enough plastic has been made for the batch and Injection can stop. A carryover
  // logged as already-assembled or fully-packed never goes through this batch's Plastic
  // Sorting at all, but it still counts as sorted plastic here — that pcs count is plastic
  // that doesn't need a fresh Injection run, so it should reduce how much more is needed.
  const sortedPlasticPcs=mySubs.reduce((s,b)=>{
    if(b.acceptedPcs!=null)return s+b.acceptedPcs;
    if(b.assembledPcs!=null)return s+b.assembledPcs;
    return s;
  },0);
  const unsortedPlasticPcs=mySubs.reduce((s,b)=>{
    if(b.acceptedPcs!=null||!b.weightBeforeSorting)return s;
    return s+kgToPcs(b.weightBeforeSorting,b.capWt||CAP_WT);
  },0);
  const totalPlasticPcs=sortedPlasticPcs+unsortedPlasticPcs;
  const plasticPct=target?Math.min(100,Math.round(totalPlasticPcs/target*100)):0;
  // Final product made so far — packed (fully through Final Sorting, already counted in
  // totalGood/goodPcs) vs unsorted (assembled and accepted, sitting past Plastic Sorting, but
  // not yet through Final Sorting at all). This is the downstream counterpart of the Plastic
  // Made split above — that one tracks Injection through Plastic Sorting, this one tracks
  // Assembly through Final Sorting/packing — and it's what makes assembled WIP visible instead
  // of silently missing from every count until the shift finally reaches Final Sorting.
  const packedFinalPcs=totalGood;
  const unsortedFinalPcs=mySubs.reduce((s,b)=>{
    if(b.finalAcceptedKg!=null||b.assembledPcs==null)return s;
    return s+b.assembledPcs;
  },0);
  const totalFinalPcs=packedFinalPcs+unsortedFinalPcs;
  const finalPct=target?Math.min(100,Math.round(totalFinalPcs/target*100)):0;
  // Aluminum/assembly-side loss, so it can be traced instead of only showing up as a
  // missing total: shrinkage during Assembly itself, and accepted product that Final
  // Sorting says is good but never actually made it into a counted carton.
  const bpc=Number(parentBatch.bagsPerCarton)||0,ppb=Number(parentBatch.pcsPerBag)||0;
  const asmShrinkagePcs=mySubs.reduce((s,b)=>(b.acceptedPcs!=null&&b.assembledPcs!=null)?s+Math.max(0,b.acceptedPcs-b.assembledPcs):s,0);
  const canCheckPacking=bpc>0&&ppb>0;
  const notPackedPcs=canCheckPacking?mySubs.reduce((s,b)=>{
    if(b.finalCartons==null||b.finalAcceptedPcs==null)return s;
    const packedPcs=(Number(b.finalCartons)||0)*bpc*ppb+(Number(b.finalPartialBags)||0)*ppb+kgToPcs(Number(b.finalPartialKg)||0,b.asmWt||ASM_WT);
    return s+Math.max(0,b.finalAcceptedPcs-packedPcs);
  },0):0;
  const cur=form&&form.subId?mySubs.filter(b=>b.id===form.subId)[0]:null;
  const close=()=>setForm(null);

  if(form&&form.mode==="new")return <InjectionForm parentBatch={parentBatch} batches={batches} data={data} employees={employees} onSave={(b,m)=>{onCreateSub(b,m);close();}} onCancel={close}/>;
  if(form&&form.mode==="carryover")return <CarryoverForm parentBatch={parentBatch} batches={batches} data={data} onSave={(b,m)=>{onCreateSub(b,m);close();}} onCancel={close}/>;
  if(cur&&form.stage==="Injection")return <InjectionForm parentBatch={parentBatch} batches={batches} data={data} employees={employees} existing={cur} onSave={(b,m)=>{onUpdateSub(b,m,cur);close();}} onCancel={close}/>;
  if(cur&&form.stage==="Plastic Sorting")return <PlasticSortingForm sub={cur} batches={batches} data={data} employees={employees} existing={form.editing} onSave={u=>{onUpdateSub(u,null,cur);close();}} onCancel={close}/>;
  if(cur&&form.stage==="Assembly")return <AssemblyForm sub={cur} data={data} batches={batches} employees={employees} existing={form.editing} onSave={(u,m)=>{onUpdateSub(u,m,cur);close();}} onCancel={close}/>;
  if(cur&&form.stage==="Final Sorting")return <FinalSortingForm sub={cur} parentBatch={parentBatch} data={data} batches={batches} employees={employees} existing={form.editing} onSave={(u,m)=>{onUpdateSub(u,m,cur);close();}} onCancel={close}/>;

  const doneStages=sub=>{
    const out=[];
    if(sub.injections)out.push("Injection");
    if(sub.acceptedWeightKg!=null)out.push("Plastic Sorting");
    if(sub.assembledWeightKg!=null)out.push("Assembly");
    if(sub.finalAcceptedKg!=null)out.push("Final Sorting");
    return out;
  };

  return(<div style={{fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:NAVY,padding:"14px 18px",borderRadius:"12px 12px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>Shifts — {parentBatch.batchNo}</div>
        <div style={{color:"rgba(255,255,255,0.6)",fontSize:12,marginTop:2}}>{parentBatch.client} · {parentBatch.color} · Target {target.toLocaleString()} pcs</div></div>
      <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 14px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:16}}>
      {target>0&&<div style={{background:"#EBF1F8",borderRadius:10,padding:12,marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}>
          <span style={{fontWeight:700,color:NAVY}}>{totalGood.toLocaleString()} good pcs</span>
          <span style={{color:"#888"}}>{pct}% · {Math.max(0,target-totalGood).toLocaleString()} remaining</span></div>
        <div style={{height:8,background:"#D6E4F4",borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:pct>=100?"#22A03A":ACCENT,borderRadius:4}}/></div></div>}
      {mySubs.length>0&&<div style={{background:"#F5EDFF",borderRadius:10,padding:12,marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:11}}>
          <span style={{fontWeight:800,color:"#4A1A6E",textTransform:"uppercase"}}>🧴 Plastic Made</span>
          <span style={{color:"#7B3FB5"}}>{fmtN(totalPlasticPcs)} of {fmtN(target)} pcs · {plasticPct}%</span></div>
        <div style={{height:8,background:"#E0CFFA",borderRadius:4,overflow:"hidden",marginBottom:8}}><div style={{height:"100%",width:plasticPct+"%",background:plasticPct>=100?"#22A03A":"#7B3FB5",borderRadius:4}}/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,fontSize:12}}>
          <div><div style={{color:"#7B3FB5",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Sorted</div><div style={{fontWeight:800,color:"#4A1A6E"}}>{fmtN(sortedPlasticPcs)} pcs</div></div>
          <div><div style={{color:"#7B3FB5",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Unsorted</div><div style={{fontWeight:800,color:"#4A1A6E"}}>{fmtN(unsortedPlasticPcs)} pcs</div></div></div>
        {plasticPct>=100&&<div style={{marginTop:8,fontSize:11,color:"#8B1A1A",fontWeight:700}}>✅ Enough plastic made for this batch — no need to run more Injection shifts.</div>}</div>}
      {mySubs.length>0&&<div style={{background:"#E8F5E9",borderRadius:10,padding:12,marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:11}}>
          <span style={{fontWeight:800,color:"#1A6B2A",textTransform:"uppercase"}}>📦 Final Product</span>
          <span style={{color:"#2E8B4A"}}>{fmtN(totalFinalPcs)} of {fmtN(target)} pcs · {finalPct}%</span></div>
        <div style={{height:8,background:"#C8E6C9",borderRadius:4,overflow:"hidden",marginBottom:8}}><div style={{height:"100%",width:finalPct+"%",background:finalPct>=100?"#22A03A":"#2E8B4A",borderRadius:4}}/></div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,fontSize:12}}>
          <div><div style={{color:"#2E8B4A",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Packed</div><div style={{fontWeight:800,color:"#1A6B2A"}}>{fmtN(packedFinalPcs)} pcs</div></div>
          <div><div style={{color:"#2E8B4A",fontSize:10,fontWeight:700,textTransform:"uppercase"}}>Unsorted</div><div style={{fontWeight:800,color:"#1A6B2A"}}>{fmtN(unsortedFinalPcs)} pcs</div></div></div>
        {finalPct>=100&&<div style={{marginTop:8,fontSize:11,color:"#8B1A1A",fontWeight:700}}>✅ All product for this batch has been packed.</div>}</div>}
      {mySubs.length>0&&<div style={{background:"#FFF5F5",borderRadius:10,padding:12,marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:800,color:"#8B1A1A",textTransform:"uppercase",marginBottom:8}}>♻️ Waste Summary</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(105px,1fr))",gap:10,fontSize:12,marginBottom:10}}>
          {[["Plastic in",wPlastic,NAVY],["Plastic sort reject",wSort,"#DC3545"],["Final sort reject",wFinal,"#DC3545"]].map(x=>(
            <div key={x[0]}><div style={{color:"#888",fontSize:10}}>{x[0]}</div><div style={{fontWeight:800,color:x[2]}}>{x[1].toFixed(1)} KG</div></div>))}</div>
        <div style={{borderTop:"1px solid #F1D4D4",paddingTop:10,display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(105px,1fr))",gap:10,fontSize:12}}>
          <div><div style={{color:"#888",fontSize:10}}>Assembly shrinkage</div><div style={{fontWeight:800,color:"#DC3545"}}>{fmtN(asmShrinkagePcs)} pcs</div></div>
          <div><div style={{color:"#888",fontSize:10}}>Not packed{canCheckPacking?"":" (set Bags/Pcs per carton)"}</div><div style={{fontWeight:800,color:"#DC3545"}}>{canCheckPacking?fmtN(notPackedPcs)+" pcs":"—"}</div></div></div></div>}
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
        {mySubs.length===0&&<div style={{textAlign:"center",padding:20,color:"#888",fontSize:13}}>No shifts yet — start the first one below</div>}
        {mySubs.map(sub=>{
          const sc=stageColor[sub.stage]||"#333",sbg=stageBg[sub.stage]||"#F5F5F5";
          const idx=STAGES.indexOf(sub.stage);
          const done=doneStages(sub);
          return(<div key={sub.id} style={{background:"#FAFBFC",borderRadius:10,border:"1.5px solid #EEF2F7",padding:"10px 14px"}}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
              <div><span style={{fontFamily:"monospace",fontWeight:800,fontSize:14,color:NAVY}}>{sub.batchNo}</span>
                <span style={{background:sbg,color:sc,borderRadius:20,padding:"2px 9px",fontSize:11,fontWeight:700,marginLeft:8}}>{sub.stage}</span>
                {sub.shift&&<span style={{fontSize:11,color:"#888",marginLeft:8}}>{sub.shift} · {sub.mfgDate}</span>}
                {sub.isCarryover&&<span style={{background:"#EEF3EC",color:"#4A6741",borderRadius:20,padding:"2px 9px",fontSize:11,fontWeight:700,marginLeft:8}}>↩️ from {sub.carryoverFrom}</span>}
                {sub.movedFrom&&<span style={{background:"#EBF1F8",color:NAVY,borderRadius:20,padding:"2px 9px",fontSize:11,fontWeight:700,marginLeft:8}}>↪️ moved from {sub.movedFrom}</span>}</div>
              {sub.stage!=="Complete"&&<button type="button" onClick={()=>setForm({subId:sub.id,stage:sub.stage,editing:false})} style={{background:sc,color:"#fff",border:"none",borderRadius:8,padding:"6px 14px",cursor:"pointer",fontSize:12,fontWeight:700}}>Enter {sub.stage} →</button>}</div>
            <div style={{display:"flex",gap:4,marginTop:8,marginBottom:8}}>
              {STAGES.slice(0,4).map((s,i)=><div key={s} style={{flex:1,height:4,borderRadius:2,background:sub.stage==="Complete"||i<idx?"#22A03A":i===idx?stageColor[s]:"#E2E8F0"}}/>)}</div>
            {done.length>0&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
              {done.map(s=><button type="button" key={s} onClick={()=>setForm({subId:sub.id,stage:s,editing:true})}
                style={{background:"#fff",border:"1px solid "+stageColor[s],color:stageColor[s],borderRadius:20,padding:"3px 10px",fontSize:10,fontWeight:700,cursor:"pointer"}}>✏️ {s}</button>)}</div>}
            <div style={{display:"flex",gap:14,fontSize:11,color:"#666",flexWrap:"wrap"}}>
              {sub.injections?<span>💉 {sub.injections} inj</span>:null}
              {sub.totalPlasticKg?<span>🧴 {sub.virginBags||0} bags{sub.regrindKg?" + "+sub.regrindKg.toFixed(1)+" KG regrind":""}</span>:null}
              {sub.acceptedPcs?<span>✅ {sub.acceptedPcs.toLocaleString()} sorted</span>:null}
              {sub.aluminumLotNo?<span>🔘 {sub.aluminumLotNo}</span>:null}
              {sub.assembledPcs?<span>⚙️ {sub.assembledPcs.toLocaleString()} asm</span>:null}
              {sub.goodPcs?<span style={{fontWeight:700,color:"#1A6B2A"}}>📦 {sub.goodPcs.toLocaleString()} packed</span>:null}
              {sub.finalCartons?<span>📦 {sub.finalCartons} ctn{(sub.finalPartialBags||sub.finalPartialKg)?" + "+(sub.finalPartialBags||0)+" bag"+(sub.finalPartialBags===1?"":"s")+(sub.finalPartialKg?" + "+fmt(sub.finalPartialKg)+" KG":""):""}</span>:null}</div>
            <div style={{marginTop:9,paddingTop:9,borderTop:"1px solid #F0F0F0"}}>
              {confDel===sub.id?(<div style={{display:"flex",gap:8,alignItems:"center"}}>
                <span style={{fontSize:11,color:"#8B1A1A",fontWeight:600,flex:1}}>Delete {sub.batchNo}{(sub.plasticLotId||(sub.aluminumSelections&&sub.aluminumSelections.length))?" — any material it drew will be returned to stock":""}?</span>
                <button type="button" onClick={()=>{onDeleteSub(sub);setConfDel(null);}} style={{background:"#DC3545",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:11,color:"#fff",fontWeight:800}}>Yes, delete</button>
                <button type="button" onClick={()=>setConfDel(null)} style={{background:"#E2E8F0",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:11}}>Cancel</button></div>)
              :(<div style={{display:"flex",gap:16,flexWrap:"wrap"}}>
                  <button type="button" onClick={()=>setConfDel(sub.id)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:11,fontWeight:600,padding:0}}>🗑 Delete this shift</button>
                  {!sub.isCarryover&&<button type="button" onClick={()=>setMoveSub(sub)} style={{background:"none",border:"none",color:NAVY,cursor:"pointer",fontSize:11,fontWeight:600,padding:0}}>↪️ Move to another batch</button>}
                </div>)}</div>
          </div>);})}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button type="button" onClick={()=>setForm({mode:"new"})} style={{flex:2,minWidth:150,padding:13,background:"linear-gradient(135deg,"+NAVY+","+ACCENT+")",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:14,cursor:"pointer"}}>+ New Shift ({String.fromCharCode(65+realShiftCount)})</button>
        <button type="button" onClick={()=>setForm({mode:"carryover"})} style={{flex:1,minWidth:120,padding:13,background:"#fff",color:"#4A6741",border:"1.5px solid #4A6741",borderRadius:10,fontWeight:800,fontSize:13,cursor:"pointer"}}>↩️ Carryover</button>
        <button type="button" onClick={()=>setShowLeftover(true)} style={{flex:1,minWidth:150,padding:13,background:"#fff",color:"#6B4F9E",border:"1.5px solid #6B4F9E",borderRadius:10,fontWeight:800,fontSize:13,cursor:"pointer"}}>🗂️ Save Leftover to Stock</button></div>
    </div>
    {showLeftover&&<SaveLeftoverForm parentBatch={parentBatch} onSave={lot=>{onSaveLeftover(lot);setShowLeftover(false);}} onClose={()=>setShowLeftover(false)}/>}
    {moveSub&&<MoveShiftModal shift={moveSub} parentBatch={parentBatch} batches={batches} onMove={u=>{onUpdateSub(u,null,moveSub);setMoveSub(null);}} onCancel={()=>setMoveSub(null)}/>}
    </div>);
}

// ══ SILICA GEL SHIFTS ═════════════════════════════════════════════════════
// Sachets/Capsules production doesn't go through Injection→Sorting→Assembly like Flip-Off
// Caps — it's packed straight from silica gel beads and packaging film rolls in one pass, so
// each shift just records who ran it, how much came out, and what it used.
function SilicaShiftForm({parentBatch,batches,data,employees,existing,onSave,onCancel}){
  const mySubs=batches.filter(b=>b.parentBatchNo===parentBatch.batchNo&&b.isSubBatch);
  const subNo=existing?existing.batchNo:parentBatch.batchNo+"-"+String.fromCharCode(65+mySubs.length);
  const e=existing||{};
  const [date,setDate]=useState(e.mfgDate||new Date().toISOString().split("T")[0]);
  const [workers,setWorkers]=useState(e.workers||[]);
  const [amount,setAmount]=useState(e.amountPcs!=null?String(e.amountPcs):"");
  const [silicaLotId,setSilicaLotId]=useState(e.silicaLotId||"");
  const [silicaBags,setSilicaBags]=useState(e.silicaKg!=null?String(e.silicaKg/BAG_KG):"");
  const [rollsLotId,setRollsLotId]=useState(e.rollsLotId||"");
  const [rollsUsed,setRollsUsed]=useState(e.rollsUsed!=null?String(e.rollsUsed):"");
  const [noCartons,setNoCartons]=useState(e.id?!e.cartonsLotId&&!e.cartonsUsed:false);
  const [cartonsLotId,setCartonsLotId]=useState(e.cartonsLotId||"");
  const [cartonsUsedStr,setCartonsUsedStr]=useState(e.cartonsUsed!=null?String(e.cartonsUsed):"");
  const [notes,setNotes]=useState(e.notes||""),[err,setErr]=useState("");
  const silicaLots=((data&&data["Silica Gel"]&&data["Silica Gel"].lots)||[]).filter(l=>l.status!=="Out of Stock"||l.id===e.silicaLotId);
  const rollsLots=((data&&data["Sachets Paper"]&&data["Sachets Paper"].lots)||[]).filter(l=>l.status!=="Out of Stock"||l.id===e.rollsLotId);
  const cartonsLots=((data&&data["Cartons"]&&data["Cartons"].lots)||[]).filter(l=>l.status!=="Out of Stock"||l.id===e.cartonsLotId);
  const selSilica=silicaLotId?silicaLots.filter(l=>l.id===silicaLotId)[0]:null;
  const selRolls=rollsLotId?rollsLots.filter(l=>l.id===rollsLotId)[0]:null;
  const selCartons=cartonsLotId?cartonsLots.filter(l=>l.id===cartonsLotId)[0]:null;
  const cartonsUsed=noCartons?0:Number(cartonsUsedStr)||0;
  // Silica Gel is stocked and used in 25 KG bags (matches the inventory lot itself, e.g.
  // "Silica Gel Beaded Type A – 25 KG/bag") — simpler to enter bags than raw KG.
  const amt=Number(amount)||0,sBags=Number(silicaBags)||0,sKg=sBags*BAG_KG,rQty=Number(rollsUsed)||0;
  const availSilicaKg=selSilica?Number(selSilica.qtyRemaining):0;
  const availSilicaBags=availSilicaKg/BAG_KG;
  const availRolls=selRolls?Number(selRolls.qtyRemaining):0;
  const save=()=>{
    if(amt<1){setErr("Enter the amount made.");return;}
    if(workers.length===0){setErr("Add at least one worker on this shift.");return;}
    if(sBags>0&&!silicaLotId){setErr("Select which Silica Gel lot was used.");return;}
    if(selSilica&&!existing&&sBags>availSilicaBags+0.01){setErr("Only "+fmt(availSilicaBags)+" bags available in that lot.");return;}
    if(rQty>0&&!rollsLotId){setErr("Select which Sachets Paper lot was used.");return;}
    if(selRolls&&!existing&&rQty>availRolls+0.01){setErr("Only "+availRolls+" rolls available in that lot.");return;}
    if(cartonsUsed>0&&!cartonsLotId){setErr("Select which Cartons lot was used.");return;}
    if(selCartons&&!existing&&cartonsUsed>Number(selCartons.qtyRemaining)+0.01){setErr("Only "+fmtN(selCartons.qtyRemaining)+" cartons available in that lot.");return;}
    const payload={id:e.id||genId(),batchNo:subNo,isSubBatch:true,parentBatchNo:parentBatch.batchNo,
      product:parentBatch.product,color:parentBatch.color,client:parentBatch.client,orderNo:parentBatch.orderNo,
      stage:"Complete",status:"Complete",
      cartons:0,bagsPerCarton:0,pcsPerBag:0,partialCartonBags:0,totalPcs:0,
      mfgDate:date,operator:workers.map(w=>w.name).join(", "),workers:workers,amountPcs:amt,goodPcs:amt,
      silicaLotId:silicaLotId||null,silicaLotNo:selSilica?selSilica.lotNumber:null,silicaKg:sKg,
      rollsLotId:rollsLotId||null,rollsLotNo:selRolls?selRolls.lotNumber:null,rollsUsed:rQty,
      cartonsLotId:noCartons?null:(cartonsLotId||null),cartonsLotNo:noCartons?null:(selCartons?selCartons.lotNumber:null),cartonsUsed:cartonsUsed,noCartons:noCartons,
      notes:notes.trim(),createdAt:e.createdAt||today()};
    onSave(payload,{silicaLotId:silicaLotId||null,silicaKg:sKg,rollsLotId:rollsLotId||null,rollsUsed:rQty,
      cartonsLotId:noCartons?null:(cartonsLotId||null),cartonsUsed:cartonsUsed});
  };
  return(<div style={{maxWidth:640,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#0E4A2A",borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>🟡 Shift — {subNo}</div><div style={{color:"rgba(255,255,255,0.65)",fontSize:12}}>{existing?"Editing saved data":"Silica Gel Sachets production"}</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{marginBottom:14}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Date of Production</label>
        <input type="date" value={date} onChange={ev=>setDate(ev.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
      <div style={{background:"#D0F0E0",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:"#0E4A2A",marginBottom:10}}>👷 Workers on this shift</div>
        <WorkerPicker employees={employees} station="Silica" value={workers} onChange={v=>{setWorkers(v);setErr("");}}/>
        {err==="Add at least one worker on this shift."&&<div style={{fontSize:11,color:"#DC3545",marginTop:6}}>{err}</div>}</div>
      <div style={{marginBottom:14}}><Field label="Amount Made (pcs)" value={amount} onChange={v=>{setAmount(v);setErr("");}} type="number" ph="e.g. 25000" accent="#0E4A2A" error={err==="Enter the amount made."}/>
        {err==="Enter the amount made."&&<div style={{fontSize:11,color:"#DC3545",marginTop:4}}>↑ This field, not the rolls below — the rolls value you typed is fine.</div>}</div>
      <div style={{background:"#D0F0E0",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:"#0E4A2A",marginBottom:10}}>🟡 Silica Gel Used</div>
        <div style={{marginBottom:10}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Draw From Lot</label>
          <select value={silicaLotId} onChange={ev=>{setSilicaLotId(ev.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid "+(silicaLots.length?"#E2E8F0":"#F1948A"),borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— not specified —</option>
            {silicaLots.map(l=><option key={l.id} value={l.id}>{l.lotNumber} · {fmtN(Number(l.qtyRemaining)/BAG_KG)} bags available</option>)}</select>
          {silicaLots.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No Silica Gel lots in inventory — go to Inventory → Silica Gel first.</div>}</div>
        <Field label={"Bags Used (1 bag = "+BAG_KG+" KG)"} value={silicaBags} onChange={v=>{setSilicaBags(v);setErr("");}} type="number" ph="e.g. 2" accent="#1A7A45"/>
        {selSilica&&<div style={{fontSize:11,color:"#1A7A45",marginTop:6}}>{fmtN(availSilicaBags)} bags ({fmtN(availSilicaKg)} KG) available{sBags>0?" · using "+fmt(sKg)+" KG":""}</div>}</div>
      <div style={{background:"#FEE8D0",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:"#6B3010",marginBottom:10}}>📄 Rolls Used</div>
        <div style={{marginBottom:10}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Draw From Lot</label>
          <select value={rollsLotId} onChange={ev=>{setRollsLotId(ev.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid "+(rollsLots.length?"#E2E8F0":"#F1948A"),borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— not specified —</option>
            {rollsLots.map(l=><option key={l.id} value={l.id}>{l.lotNumber} · {fmtN(l.qtyRemaining)} rolls available</option>)}</select>
          {rollsLots.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No Sachets Paper lots in inventory — go to Inventory → Sachets Paper first.</div>}</div>
        <Field label="Rolls Used" value={rollsUsed} onChange={v=>{setRollsUsed(v);setErr("");}} type="number" ph="e.g. 2" accent="#B85C1A"/>
        {selRolls&&<div style={{fontSize:11,color:"#B85C1A",marginTop:6}}>{fmtN(availRolls)} rolls available</div>}</div>
      <div style={{background:"#F5E8D8",borderRadius:10,padding:14,marginBottom:14}}>
        <div style={{fontWeight:700,fontSize:13,color:"#7A5230",marginBottom:10}}>📦 Cartons Used</div>
        <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#555",cursor:"pointer",marginBottom:noCartons?0:10}}>
          <input type="checkbox" checked={noCartons} onChange={ev=>{setNoCartons(ev.target.checked);setErr("");}} style={{width:16,height:16}}/>
          This shift doesn&apos;t use cartons</label>
        {!noCartons&&(<>
          <div style={{marginBottom:10}}>
            <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Draw From Lot</label>
            <select value={cartonsLotId} onChange={ev=>{setCartonsLotId(ev.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid "+(cartonsLots.length?"#E2E8F0":"#F1948A"),borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
              <option value="">— not specified —</option>
              {cartonsLots.map(l=><option key={l.id} value={l.id}>{l.lotNumber} · {fmtN(l.qtyRemaining)} cartons available</option>)}</select>
            {cartonsLots.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No Cartons lots in inventory — go to Inventory → Cartons first.</div>}</div>
          <Field label="Cartons Used" value={cartonsUsedStr} onChange={v=>{setCartonsUsedStr(v);setErr("");}} type="number" ph="e.g. 5" accent="#B8865C"/>
          {selCartons&&<div style={{fontSize:11,color:"#7A5230",marginTop:6}}>{fmtN(selCartons.qtyRemaining)} cartons available</div>}</>)}</div>
      <div style={{marginBottom:18}}><Field label="Notes (optional)" value={notes} onChange={setNotes} accent="#0E4A2A"/></div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#0E4A2A",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save Shift</button>
    </div></div>);
}
// Leftover FINISHED sachets from another Silica Gel Sachets batch, logged as a completed
// shift here without drawing fresh Silica Gel/Rolls/Cartons — that material was already
// consumed under the original batch, so redrawing it here would double-count it.
function SilicaCarryoverForm({parentBatch,batches,data,onSave,onCancel}){
  const mySubs=batches.filter(b=>b.parentBatchNo===parentBatch.batchNo&&b.isSubBatch);
  const priorCarryovers=mySubs.filter(b=>b.isCarryover).length;
  const subNo=parentBatch.batchNo+"-CO"+(priorCarryovers+1);
  const sourceOptions=batches.filter(b=>!b.isSubBatch&&b.product==="Silica Gel Sachets"&&b.batchNo!==parentBatch.batchNo);
  // Leftover Silica Gel Sachets saved to WIP Inventory are tagged with a description starting
  // "Silica Gel Sachets" (see SilicaSaveLeftoverForm) — matched here so only that stock, not
  // Flip-Off's plastic/assembled WIP stock, shows up as a source.
  const wipLots=((data&&data["WIP Inventory"]&&data["WIP Inventory"].lots)||[]).filter(l=>l.status!=="Out of Stock"&&Number(l.qtyRemaining)>0&&(l.description||"").indexOf("Silica Gel Sachets")===0);
  const [source,setSource]=useState("batch");   // "batch" | "wip"
  const [sourceBatchNo,setSourceBatchNo]=useState(""),[qty,setQty]=useState("");
  const [wipLotId,setWipLotId]=useState(""),[wipPcs,setWipPcs]=useState("");
  const [notes,setNotes]=useState(""),[err,setErr]=useState("");
  const selWip=wipLotId?wipLots.filter(l=>l.id===wipLotId)[0]:null;
  const wipRemaining=selWip?Number(selWip.qtyRemaining):0;
  const manualQty=Number(qty)||0,wipQty=Number(wipPcs)||0;
  const effectiveQty=source==="wip"?wipQty:manualQty;
  const save=()=>{
    if(source==="batch"&&!sourceBatchNo){setErr("Select which batch this carried over from.");return;}
    if(source==="wip"&&!wipLotId){setErr("Select which saved leftover lot this came from.");return;}
    if(effectiveQty<=0){setErr("Enter a quantity.");return;}
    if(source==="wip"&&wipQty>wipRemaining+0.5){setErr("Only "+fmtN(wipRemaining)+" pcs left in that lot.");return;}
    const fromLabel=source==="wip"?selWip.lotNumber:sourceBatchNo;
    const payload={id:genId(),batchNo:subNo,isSubBatch:true,parentBatchNo:parentBatch.batchNo,
      product:parentBatch.product,color:parentBatch.color,client:parentBatch.client,orderNo:parentBatch.orderNo,
      stage:"Complete",status:"Complete",
      cartons:0,bagsPerCarton:0,pcsPerBag:0,partialCartonBags:0,totalPcs:effectiveQty,
      mfgDate:parentBatch.mfgDate,operator:"",amountPcs:effectiveQty,goodPcs:effectiveQty,
      isCarryover:true,carryoverFrom:fromLabel,
      wipLotId:source==="wip"?wipLotId:null,wipLotNo:source==="wip"?selWip.lotNumber:null,wipPcsUsed:source==="wip"?effectiveQty:0,
      notes:"Carried over from "+fromLabel+(notes?" — "+notes:""),createdAt:today()};
    onSave(payload,source==="wip"?{wipLotId:wipLotId,wipPcsUsed:effectiveQty}:null);
  };
  return(<div style={{maxWidth:640,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#4A6741",borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>↩️ Log Carryover — {subNo}</div><div style={{color:"rgba(255,255,255,0.65)",fontSize:12}}>Leftover finished sachets from a previous batch, or saved leftover stock</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{marginBottom:14}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Where From?</label>
        <div style={{display:"flex",gap:8}}>
          {[["batch","Another Batch"],["wip","Saved Leftover Stock"]].map(([k,label])=>(
            <div key={k} onClick={()=>{setSource(k);setErr("");}} style={{flex:1,padding:"9px 12px",borderRadius:9,border:"2px solid "+(source===k?"#4A6741":"#E2E8F0"),background:source===k?"#EEF3EC":"#fff",cursor:"pointer",textAlign:"center",fontWeight:source===k?700:500,fontSize:13,color:source===k?"#4A6741":"#444"}}>{label}</div>))}</div></div>
      {source==="batch"?(<>
        <div style={{marginBottom:14}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Carried Over From Batch</label>
          <select value={sourceBatchNo} onChange={e=>{setSourceBatchNo(e.target.value);setErr("");}} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— select batch —</option>
            {sourceOptions.map(b=><option key={b.id} value={b.batchNo}>{b.batchNo} · {b.color}{b.client?" · "+b.client:""}</option>)}</select>
          {sourceOptions.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No other Silica Gel Sachets batches to carry over from yet.</div>}</div>
        <div style={{marginBottom:14}}><Field label="Quantity (Pcs) *" value={qty} onChange={v=>{setQty(v);setErr("");}} type="number" ph="e.g. 15000" accent="#4A6741"/></div>
      </>):(<div style={{marginBottom:14}}>
        <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Saved Leftover Lot</label>
        <select value={wipLotId} onChange={e=>{setWipLotId(e.target.value);setWipPcs("");setErr("");}} style={{width:"100%",border:"1.5px solid "+(wipLots.length?"#E2E8F0":"#F1948A"),borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
          <option value="">— select lot —</option>
          {wipLots.map(l=><option key={l.id} value={l.id}>{l.lotNumber} · {fmtN(l.qtyRemaining)} pcs · {l.description}</option>)}</select>
        {wipLots.length===0&&<div style={{fontSize:11,color:"#DC3545",marginTop:5,fontWeight:600}}>⚠️ No saved leftover Silica Gel Sachets stock yet — use &quot;💾 Save Leftover&quot; on a batch first.</div>}
        {selWip&&<div style={{marginTop:10}}>
          <Field label="Pcs to Use" value={wipPcs} onChange={v=>{setWipPcs(v);setErr("");}} type="number" ph={"up to "+fmtN(wipRemaining)} accent="#4A6741"/>
          <div style={{fontSize:11,color:"#4A6741",marginTop:4}}>{fmtN(wipRemaining)} pcs available <button type="button" onClick={()=>setWipPcs(String(wipRemaining))} style={{marginLeft:8,background:"none",border:"none",color:"#4A6741",textDecoration:"underline",cursor:"pointer",fontSize:11,padding:0}}>use all</button></div></div>}
      </div>)}
      <div style={{marginBottom:18}}><Field label="Notes (optional)" value={notes} onChange={setNotes} accent="#4A6741"/></div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#4A6741",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Log Carryover</button>
    </div></div>);
}
// Leftover FINISHED Silica Gel Sachets from a batch that wasn't fully used/shipped, saved as
// its own WIP Inventory lot (size/client tagged) so it's visible in stock for a later batch's
// Carryover — simpler than the Flip-Off version since Silica has no intermediate stages,
// just finished pcs.
function SilicaSaveLeftoverForm({parentBatch,onSave,onClose}){
  const mc=MATERIAL_META["WIP Inventory"];
  const [size,setSize]=useState(parentBatch.color||""),[company,setCompany]=useState(parentBatch.client||"");
  const [qty,setQty]=useState(""),[notes,setNotes]=useState(""),[err,setErr]=useState("");
  const pcs=Number(qty)||0;
  const save=()=>{
    if(pcs<=0){setErr("Enter the leftover quantity in pcs.");return;}
    onSave({id:genId(),lotNumber:"WIP-"+parentBatch.batchNo+"-"+genId().slice(-4),plNo:"",date:today(),
      supplier:company.trim(),
      description:"Silica Gel Sachets — Finished — "+(size.trim()||"any size")+(company.trim()?" — "+company.trim():""),
      qtyReceived:pcs,unit:"Pcs",qtyRemaining:pcs,unitCost:"",status:"In Stock",
      notes:"From "+parentBatch.batchNo+(notes?" — "+notes:""),image:null,usageLog:[]});
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:460,maxHeight:"92vh",overflowY:"auto"}}>
      <div style={{background:mc.color,borderRadius:"16px 16px 0 0",padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>{mc.emoji} Save Leftover to Stock</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{parentBatch.batchNo}{parentBatch.color?" · "+parentBatch.color:""}{parentBatch.client?" · "+parentBatch.client:""}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label="Size / Variant" value={size} onChange={setSize} ph="e.g. 10g" accent={mc.accent}/>
          <Field label="Company" value={company} onChange={setCompany} ph="e.g. Mountain Nutrition" accent={mc.accent}/></div>
        <div style={{marginBottom:14}}><Field label="Quantity (Pcs) *" value={qty} onChange={v=>{setQty(v);setErr("");}} type="number" ph="e.g. 5000" accent={mc.accent}/></div>
        <div style={{marginBottom:18}}><Field label="Notes (optional)" value={notes} onChange={setNotes} accent={mc.accent}/></div>
        {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:mc.accent,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save to WIP Inventory</button>
      </div></div></div>);
}
function SilicaShiftManager({parentBatch,batches,data,employees,onClose,onCreateSub,onUpdateSub,onDeleteSub,onSaveLeftover}){
  const [form,setForm]=useState(null);      // {mode:"new"} | {mode:"carryover"} | {mode:"leftover"} | {subId, editing:true}
  const [confDel,setConfDel]=useState(null);
  const mySubs=batches.filter(b=>b.parentBatchNo===parentBatch.batchNo&&b.isSubBatch).sort((a,b)=>a.batchNo.localeCompare(b.batchNo));
  const totalGood=mySubs.reduce((s,b)=>s+(b.goodPcs||0),0);
  const target=parentBatch.totalPcs||0;
  const pct=target?Math.min(100,Math.round(totalGood/target*100)):0;
  const totalSilicaKg=mySubs.reduce((s,b)=>s+(b.silicaKg||0),0);
  const totalRolls=mySubs.reduce((s,b)=>s+(b.rollsUsed||0),0);
  const totalCartons=mySubs.reduce((s,b)=>s+(b.cartonsUsed||0),0);
  const cur=form&&form.subId?mySubs.filter(b=>b.id===form.subId)[0]:null;
  const close=()=>setForm(null);

  if(form&&form.mode==="new")return <SilicaShiftForm parentBatch={parentBatch} batches={batches} data={data} employees={employees} onSave={(b,m)=>{onCreateSub(b,m);close();}} onCancel={close}/>;
  if(form&&form.mode==="carryover")return <SilicaCarryoverForm parentBatch={parentBatch} batches={batches} data={data} onSave={(b,m)=>{onCreateSub(b,m);close();}} onCancel={close}/>;
  if(form&&form.mode==="leftover")return <SilicaSaveLeftoverForm parentBatch={parentBatch} onSave={lot=>{onSaveLeftover(lot);close();}} onClose={close}/>;
  if(cur)return <SilicaShiftForm parentBatch={parentBatch} batches={batches} data={data} employees={employees} existing={cur} onSave={(b,m)=>{onUpdateSub(b,m,cur);close();}} onCancel={close}/>;

  return(<div style={{fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"#0E4A2A",padding:"14px 18px",borderRadius:"12px 12px 0 0",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>Shifts — {parentBatch.batchNo}</div>
        <div style={{color:"rgba(255,255,255,0.6)",fontSize:12,marginTop:2}}>{parentBatch.client} · {parentBatch.color} · Target {target.toLocaleString()} pcs</div></div>
      <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 14px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:16}}>
      {target>0&&<div style={{background:"#D0F0E0",borderRadius:10,padding:12,marginBottom:12}}>
        <div style={{display:"flex",justifyContent:"space-between",marginBottom:6,fontSize:12}}>
          <span style={{fontWeight:700,color:"#0E4A2A"}}>{totalGood.toLocaleString()} good pcs</span>
          <span style={{color:"#888"}}>{pct}% · {Math.max(0,target-totalGood).toLocaleString()} remaining</span></div>
        <div style={{height:8,background:"#B8E0C8",borderRadius:4,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:pct>=100?"#22A03A":"#1A7A45",borderRadius:4}}/></div></div>}
      {mySubs.length>0&&<div style={{display:"flex",gap:14,fontSize:12,color:"#666",marginBottom:12,flexWrap:"wrap"}}>
        <div>🟡 {fmtN(totalSilicaKg/BAG_KG)} bags silica used ({fmtN(totalSilicaKg)} KG)</div><div>📄 {fmtN(totalRolls)} rolls used</div>
        {totalCartons>0&&<div>📦 {fmtN(totalCartons)} cartons used</div>}</div>}
      <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:14}}>
        {mySubs.length===0&&<div style={{textAlign:"center",padding:20,color:"#888",fontSize:13}}>No shifts yet — start the first one below</div>}
        {mySubs.map(sub=>(<div key={sub.id} style={{background:"#FAFBFC",borderRadius:10,border:"1.5px solid #EEF2F7",padding:"10px 14px"}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",flexWrap:"wrap",gap:8}}>
            <div><span style={{fontFamily:"monospace",fontWeight:800,fontSize:14,color:NAVY}}>{sub.batchNo}</span>
              <span style={{fontSize:11,color:"#888",marginLeft:8}}>{sub.mfgDate}{sub.operator?" · "+sub.operator:""}</span>
              {sub.isCarryover&&<span style={{background:"#EEF3EC",color:"#4A6741",borderRadius:20,padding:"2px 9px",fontSize:11,fontWeight:700,marginLeft:8}}>↩️ from {sub.carryoverFrom}</span>}</div>
            <button type="button" onClick={()=>setForm({subId:sub.id,editing:true})} style={{background:"#fff",border:"1px solid #0E4A2A",color:"#0E4A2A",borderRadius:20,padding:"3px 10px",fontSize:10,fontWeight:700,cursor:"pointer"}}>✏️ Edit</button></div>
          <div style={{display:"flex",gap:14,fontSize:11,color:"#666",flexWrap:"wrap",marginTop:8}}>
            <span style={{fontWeight:700,color:"#1A6B2A"}}>✅ {fmtN(sub.goodPcs)} pcs</span>
            {sub.silicaKg?<span>🟡 {fmtN(sub.silicaKg/BAG_KG)} bags silica</span>:null}
            {sub.rollsUsed?<span>📄 {sub.rollsUsed} rolls</span>:null}
            {sub.cartonsUsed?<span>📦 {sub.cartonsUsed} cartons</span>:null}</div>
          <div style={{marginTop:9,paddingTop:9,borderTop:"1px solid #F0F0F0"}}>
            {confDel===sub.id?(<div style={{display:"flex",gap:8,alignItems:"center"}}>
              <span style={{fontSize:11,color:"#8B1A1A",fontWeight:600,flex:1}}>Delete {sub.batchNo}{(sub.silicaLotId||sub.rollsLotId||sub.cartonsLotId)?" — any material it drew will be returned to stock":""}?</span>
              <button type="button" onClick={()=>{onDeleteSub(sub);setConfDel(null);}} style={{background:"#DC3545",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:11,color:"#fff",fontWeight:800}}>Yes, delete</button>
              <button type="button" onClick={()=>setConfDel(null)} style={{background:"#E2E8F0",border:"none",borderRadius:6,padding:"5px 12px",cursor:"pointer",fontSize:11}}>Cancel</button></div>)
            :(<button type="button" onClick={()=>setConfDel(sub.id)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:11,fontWeight:600,padding:0}}>🗑 Delete this shift</button>)}</div>
        </div>))}
      </div>
      <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
        <button type="button" onClick={()=>setForm({mode:"new"})} style={{flex:1,padding:13,background:"linear-gradient(135deg,#0E4A2A,#1A7A45)",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:14,cursor:"pointer",minWidth:150}}>+ New Shift ({String.fromCharCode(65+mySubs.length)})</button>
        <button type="button" onClick={()=>setForm({mode:"carryover"})} style={{padding:"13px 16px",background:"#fff",border:"1.5px solid #4A6741",color:"#4A6741",borderRadius:10,fontWeight:800,fontSize:14,cursor:"pointer",whiteSpace:"nowrap"}}>↩️ Carryover</button>
        <button type="button" onClick={()=>setForm({mode:"leftover"})} style={{padding:"13px 16px",background:"#fff",border:"1.5px solid "+MATERIAL_META["WIP Inventory"].accent,color:MATERIAL_META["WIP Inventory"].accent,borderRadius:10,fontWeight:800,fontSize:14,cursor:"pointer",whiteSpace:"nowrap"}}>💾 Save Leftover</button></div>
    </div></div>);
}

// ══ BATCH FORM / CARD / PRODUCTION ════════════════════════════════════════
// A carton doesn't always hold uniform bags — e.g. 12 bags of 2000 pcs plus 1 bag of 1000 pcs
// makes one 25,000-pc carton. bagMixTotals sums a list of {bags,pcs} rows into the real bag
// count and pcs-per-carton for that mix; bagsPerCarton/pcsPerBag are still stored on the batch
// (as the total bag count and pcsPerCarton/bagsPerCarton) purely so every other formula that
// multiplies them together — order progress, the plain "Edit Amount" math — keeps working
// unchanged, while the real per-size breakdown is kept in batch.bagMix for display.
function bagMixTotals(mix){
  const bags=(mix||[]).reduce((s,r)=>s+(Number(r.bags)||0),0);
  const pcsPerCarton=(mix||[]).reduce((s,r)=>s+(Number(r.bags)||0)*(Number(r.pcs)||0),0);
  return {bags:bags,pcsPerCarton:pcsPerCarton};
}
function BagMixEditor({mix,onChange,accent}){
  const rows=mix&&mix.length?mix:[{bags:"",pcs:""}];
  const upd=(i,field,val)=>onChange(rows.map((r,ri)=>ri===i?Object.assign({},r,{[field]:val}):r));
  const addRow=()=>onChange(rows.concat([{bags:"",pcs:""}]));
  const removeRow=i=>onChange(rows.length>1?rows.filter((_,ri)=>ri!==i):rows);
  const totals=bagMixTotals(rows);
  return(<div>
    {rows.map((r,i)=>(<div key={i} style={{display:"flex",gap:8,marginBottom:8,alignItems:"center"}}>
      <input type="number" value={r.bags} onChange={e=>upd(i,"bags",e.target.value)} placeholder="bags" style={{width:80,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
      <span style={{fontSize:12,color:"#888",whiteSpace:"nowrap"}}>bags of</span>
      <input type="number" value={r.pcs} onChange={e=>upd(i,"pcs",e.target.value)} placeholder="pcs each" style={{width:100,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"8px 10px",fontSize:13,boxSizing:"border-box"}}/>
      <span style={{fontSize:12,color:"#888",whiteSpace:"nowrap"}}>pcs each</span>
      {rows.length>1&&<button type="button" onClick={()=>removeRow(i)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:16,padding:"0 4px"}}>✕</button>}
    </div>))}
    <button type="button" onClick={addRow} style={{padding:"6px 12px",border:"1.5px dashed #CBD5E0",borderRadius:8,background:"#fff",color:accent||"#555",cursor:"pointer",fontSize:12,fontWeight:600,marginBottom:8}}>+ Add bag size</button>
    <div style={{fontSize:12,color:"#555"}}>{totals.bags} bags/carton · <strong>{fmtN(totals.pcsPerCarton)} pcs/carton</strong></div>
  </div>);
}
function BatchForm({batches,orders,onSave,onCancel}){
  const [product,setProduct]=useState("Flip-Off Caps 20mm");
  const meta=PRODUCT_META[product];
  const [variant,setVariant]=useState(""),[line,setLine]=useState(meta.lines?meta.lines[0]:"");
  const [client,setClient]=useState(""),[cartons,setCartons]=useState("4");
  const [bpc,setBpc]=useState("2"),[ppb,setPpb]=useState("5000"),[partial,setPartial]=useState("0");
  const [partialBagPcs,setPartialBagPcs]=useState("0");
  const [useBagMix,setUseBagMix]=useState(false),[bagMix,setBagMix]=useState([{bags:"",pcs:""}]);
  const [mfgDate,setMfgDate]=useState(new Date().toISOString().split("T")[0]);
  const [expDate,setExpDate]=useState("");
  const [status,setStatus]=useState("Production"),[orderNo,setOrderNo]=useState(""),[notes,setNotes]=useState(""),[err,setErr]=useState("");
  const [isSample,setIsSample]=useState(false);
  const [sellPrice,setSellPrice]=useState("");
  // Picking an order pre-fills the selling price from that order's own price, same as Finance
  // does — still just a starting point, editable per batch if this one sells for something else.
  const pickOrder=no=>{
    setOrderNo(no);
    if(!sellPrice){
      const ord=orders.filter(o=>o.orderNo===no)[0];
      if(ord&&ord.sellPricePerPc)setSellPrice(String(ord.sellPricePerPc));
    }
  };
  const [capWt,setCapWt]=useState(String(CAP_WT)),[asmWt,setAsmWt]=useState(String(ASM_WT));
  const [wastePerInj,setWastePerInj]=useState(String(WASTE_PER_INJ));
  const isFO=product==="Flip-Off Caps 20mm";
  const isSachets=product==="Silica Gel Sachets";
  // Silica Gel Sachets has a fixed 3-year shelf life under good conditions — expiry is always
  // exactly 3 years from manufacture, not something entered per batch.
  const sachetExpiry=isSachets?addYears(mfgDate,3):"";
  const preview=nextBatchNo(batches,meta.code);
  const c=Number(cartons)||0,b=Number(bpc)||0,p=Number(ppb)||0,pt=Number(partial)||0;
  // partialBagPcs overrides the pcs count of just the very last bag (still one physical bag,
  // counted in cartons/bagsPerCarton same as any other) — for when the last bag of a run
  // doesn't get filled to a full bag's worth. 0 means "normal", every bag is a full ppb.
  const pbp=Number(partialBagPcs)||0;
  const totalBags=c*b+pt;
  const mixTotals=bagMixTotals(bagMix);
  const totalPcs=useBagMix?c*mixTotals.pcsPerCarton:(pbp>0&&totalBags>0?(totalBags-1)*p+pbp:totalBags*p);
  const changeProduct=v=>{const m=PRODUCT_META[v];setProduct(v);setVariant("");setLine(m.lines?m.lines[0]:"");setErr("");};
  const pickVariant=v=>{
    setVariant(v);setErr("");
    if(product==="Silica Gel Sachets"&&SACHET_PCS_PER_BAG[v])setPpb(String(SACHET_PCS_PER_BAG[v]));
  };
  const save=()=>{if(!variant.trim()){setErr(meta.variantLabel+" is required.");return;}if(c<1){setErr("At least 1 carton.");return;}
    const mixFields=useBagMix?{bagsPerCarton:mixTotals.bags,pcsPerBag:mixTotals.bags>0?mixTotals.pcsPerCarton/mixTotals.bags:0,
      partialCartonBags:0,partialBagPcs:0,bagMix:bagMix.map(r=>({bags:Number(r.bags)||0,pcs:Number(r.pcs)||0}))}
      :{bagsPerCarton:b,pcsPerBag:p,partialCartonBags:pt,partialBagPcs:pbp,bagMix:null};
    onSave(Object.assign({id:genId(),batchNo:preview,isSubBatch:false,parentBatchNo:null,product:product,status:status,
      color:variant.trim(),line:meta.lines?line:"",cartons:c,totalPcs:totalPcs,
      mfgDate:mfgDate,expiryDate:isSachets?sachetExpiry:expDate,shelfLife:isSachets?"3 Years (Under Good Conditions)":null,client:client.trim(),orderNo:orderNo||null,notes:notes.trim(),createdAt:today(),isSample:isSample,
      sellPricePerPc:Number(sellPrice)||0,
      capWt:isFO?(Number(capWt)||CAP_WT):null,asmWt:isFO?(Number(asmWt)||ASM_WT):null,
      wastePerInj:isFO?(Number(wastePerInj)||WASTE_PER_INJ):null},mixFields));};
  return(<div style={{maxWidth:700,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:NAVY,borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>Create Batch</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12,fontFamily:"monospace"}}>{preview}</div></div>
      <button type="button" onClick={onCancel} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <div style={{gridColumn:"1/-1"}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Product</label>
          <select value={product} onChange={e=>changeProduct(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            {PRODUCTS.map(pr=><option key={pr}>{pr}</option>)}</select></div>
        {meta.sizes?(<div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>{meta.variantLabel} *</label>
          <select value={variant} onChange={e=>pickVariant(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— select —</option>{meta.sizes.map(s=><option key={s}>{s}</option>)}</select></div>)
        :(<Field label={meta.variantLabel+" *"} value={variant} onChange={v=>{setVariant(v);setErr("");}} ph="e.g. Blue"/>)}
        {meta.lines&&<div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Production Line</label>
          <select value={line} onChange={e=>setLine(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            {meta.lines.map(l=><option key={l}>{l}</option>)}</select></div>}
        {isFO&&<Field label="Plastic Weight (g/cap)" value={capWt} onChange={setCapWt} type="number" ph="0.56"/>}
        {isFO&&<Field label="Assembled Weight (g/cap)" value={asmWt} onChange={setAsmWt} type="number" ph="0.96"/>}
        {isFO&&<Field label="Waste per Injection (g)" value={wastePerInj} onChange={setWastePerInj} type="number" ph="28"/>}
        <Field label="Client" value={client} onChange={setClient} ph="e.g. Pharco"/>
        <Field label="Cartons" value={cartons} onChange={setCartons} type="number"/>
        <div style={{gridColumn:"1/-1"}}>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#555",cursor:"pointer"}}>
            <input type="checkbox" checked={useBagMix} onChange={e=>setUseBagMix(e.target.checked)} style={{width:16,height:16}}/>
            Custom bag mix (a carton has bags of different sizes)</label></div>
        {useBagMix?(<div style={{gridColumn:"1/-1"}}><BagMixEditor mix={bagMix} onChange={setBagMix}/></div>):(<>
          <Field label="Bags per Carton" value={bpc} onChange={setBpc} type="number"/>
          <Field label="Pcs per Bag" value={ppb} onChange={setPpb} type="number"/>
          <Field label="Partial Final Carton (bags)" value={partial} onChange={setPartial} type="number"/>
          <Field label="Partial Last Bag (pcs, optional)" value={partialBagPcs} onChange={setPartialBagPcs} type="number" ph="0 = normal full bag"/>
        </>)}
        <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Mfg. Date</label>
          <input type="date" value={mfgDate} onChange={e=>setMfgDate(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
        {isSachets?(<div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Expiry Date (auto — 3 yrs from Mfg.)</label>
          <div style={{padding:"9px 12px",background:"#F7F9FC",borderRadius:8,fontSize:13,color:"#555",border:"1.5px solid #E2E8F0"}}>{sachetExpiry||"—"}</div></div>)
        :(<div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>{isFO?"Retest Date (optional)":"Expiry Date"}</label>
          <input type="date" value={expDate} onChange={e=>setExpDate(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>)}
        <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Status</label>
          <select value={status} onChange={e=>setStatus(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>{BSTATUSES.map(s=><option key={s}>{s}</option>)}</select></div>
        <div style={{gridColumn:"1/-1"}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Link to Order</label>
          <select value={orderNo} onChange={e=>pickOrder(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— none —</option>{orders.map(o=><option key={o.id} value={o.orderNo}>{o.orderNo} · {o.client}</option>)}</select></div>
        <div style={{gridColumn:"1/-1"}}><Field label="Selling Price per Pc (EGP, optional)" value={sellPrice} onChange={setSellPrice} type="number" ph="e.g. 0.85"/></div>
        <div style={{gridColumn:"1/-1"}}><Field label="Notes" value={notes} onChange={setNotes}/></div>
        <div style={{gridColumn:"1/-1"}}>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#555",cursor:"pointer"}}>
            <input type="checkbox" checked={isSample} onChange={e=>setIsSample(e.target.checked)} style={{width:16,height:16}}/>
            🎁 This is a free sample (no charge — excluded from revenue)</label></div></div>
      <div style={{background:"#EBF1F8",borderRadius:10,padding:"12px 14px",marginBottom:12}}>
        <div style={{fontSize:11,fontWeight:700,color:NAVY,textTransform:"uppercase"}}>Preview</div>
        <div style={{fontFamily:"monospace",fontSize:15,fontWeight:700,color:NAVY}}>{preview}</div>
        <div style={{fontSize:12,color:"#555",marginTop:3}}>{useBagMix?
          (c+" cartons × "+mixTotals.bags+" mixed bags ("+fmtN(mixTotals.pcsPerCarton)+" pcs/carton) · "):
          (c+" cartons · "+b+" bags/carton"+(pt>0?" + "+pt+" bag"+(pt===1?"":"s")+" partial carton":"")+" · ")}
          <strong>{fmtN(totalPcs)} pcs total</strong>{!useBagMix&&pbp>0&&totalBags>0?" (last bag is "+fmtN(pbp)+" pcs, not "+fmtN(p)+")":""}</div></div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"linear-gradient(135deg,"+NAVY+","+ACCENT+")",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save Batch</button>
    </div></div>);
}
function BatchWeightsModal({batch,onSave,onClose}){
  const [capWt,setCapWt]=useState(String(batch.capWt||CAP_WT)),[asmWt,setAsmWt]=useState(String(batch.asmWt||ASM_WT));
  const [wastePerInj,setWastePerInj]=useState(String(batch.wastePerInj||WASTE_PER_INJ));
  const save=()=>onSave(Object.assign({},batch,{capWt:Number(capWt)||CAP_WT,asmWt:Number(asmWt)||ASM_WT,wastePerInj:Number(wastePerInj)||WASTE_PER_INJ}));
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:440,overflow:"hidden"}}>
      <div style={{background:NAVY,padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>⚖️ Batch Weights</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{batch.batchNo}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{marginBottom:14}}><Field label="Plastic Weight (g/cap)" value={capWt} onChange={setCapWt} type="number" ph="0.56"/></div>
        <div style={{marginBottom:14}}><Field label="Assembled Weight (g/cap)" value={asmWt} onChange={setAsmWt} type="number" ph="0.96"/></div>
        <div style={{marginBottom:18}}><Field label="Waste per Injection (g)" value={wastePerInj} onChange={setWastePerInj} type="number" ph="28"/></div>
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save Weights</button>
      </div></div></div>);
}
// Lets the cartons/bags/pcs spec set at Create Batch be corrected afterward — e.g. the last
// bag or last carton of a real run turned out to be a different amount than planned — without
// forcing a delete-and-recreate. Reuses the exact same math as Create Batch's own fields.
function BatchQuantityModal({batch,onSave,onClose}){
  const [cartons,setCartons]=useState(String(batch.cartons||0));
  const [bpc,setBpc]=useState(String(batch.bagsPerCarton||0));
  const [ppb,setPpb]=useState(String(batch.pcsPerBag||0));
  const [partial,setPartial]=useState(String(batch.partialCartonBags||0));
  const [partialBagPcs,setPartialBagPcs]=useState(String(batch.partialBagPcs||0));
  const [useBagMix,setUseBagMix]=useState(!!(batch.bagMix&&batch.bagMix.length));
  const [bagMix,setBagMix]=useState(batch.bagMix&&batch.bagMix.length?batch.bagMix.map(r=>({bags:String(r.bags),pcs:String(r.pcs)})):[{bags:"",pcs:""}]);
  const [err,setErr]=useState("");
  const c=Number(cartons)||0,b=Number(bpc)||0,p=Number(ppb)||0,pt=Number(partial)||0,pbp=Number(partialBagPcs)||0;
  const totalBags=c*b+pt;
  const mixTotals=bagMixTotals(bagMix);
  const totalPcs=useBagMix?c*mixTotals.pcsPerCarton:(pbp>0&&totalBags>0?(totalBags-1)*p+pbp:totalBags*p);
  const save=()=>{
    if(c<1){setErr("At least 1 carton.");return;}
    const mixFields=useBagMix?{bagsPerCarton:mixTotals.bags,pcsPerBag:mixTotals.bags>0?mixTotals.pcsPerCarton/mixTotals.bags:0,
      partialCartonBags:0,partialBagPcs:0,bagMix:bagMix.map(r=>({bags:Number(r.bags)||0,pcs:Number(r.pcs)||0}))}
      :{bagsPerCarton:b,pcsPerBag:p,partialCartonBags:pt,partialBagPcs:pbp,bagMix:null};
    onSave(Object.assign({},batch,{cartons:c,totalPcs:totalPcs},mixFields));
  };
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:440,overflow:"hidden"}}>
      <div style={{background:NAVY,padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>🔢 Edit Amount</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{batch.batchNo}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
          <Field label="Cartons" value={cartons} onChange={v=>{setCartons(v);setErr("");}} type="number"/>
        </div>
        <div style={{marginBottom:14}}>
          <label style={{display:"flex",alignItems:"center",gap:8,fontSize:13,color:"#555",cursor:"pointer"}}>
            <input type="checkbox" checked={useBagMix} onChange={e=>setUseBagMix(e.target.checked)} style={{width:16,height:16}}/>
            Custom bag mix (a carton has bags of different sizes)</label></div>
        {useBagMix?(<div style={{marginBottom:14}}><BagMixEditor mix={bagMix} onChange={setBagMix}/></div>):(
          <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:14}}>
            <Field label="Bags per Carton" value={bpc} onChange={setBpc} type="number"/>
            <Field label="Pcs per Bag" value={ppb} onChange={setPpb} type="number"/>
            <Field label="Partial Final Carton (bags)" value={partial} onChange={setPartial} type="number"/>
            <Field label="Partial Last Bag (pcs, optional)" value={partialBagPcs} onChange={setPartialBagPcs} type="number" ph="0 = normal full bag"/>
          </div>)}
        <div style={{background:"#EBF1F8",borderRadius:10,padding:"10px 12px",marginBottom:18,fontSize:12,color:"#555"}}>
          {useBagMix?
            (c+" cartons × "+mixTotals.bags+" mixed bags ("+fmtN(mixTotals.pcsPerCarton)+" pcs/carton) · "):
            (c+" cartons · "+b+" bags/carton"+(pt>0?" + "+pt+" bag"+(pt===1?"":"s")+" partial carton":"")+" · ")}
          <strong>{fmtN(totalPcs)} pcs total</strong>{!useBagMix&&pbp>0&&totalBags>0?" (last bag is "+fmtN(pbp)+" pcs, not "+fmtN(p)+")":""}</div>
        {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save Amount</button>
      </div></div></div>);
}
function BatchCard({batch,subBatches,onStatusChange,onDelete,onManageShifts,onUpdateBatch}){
  const [exp,setExp]=useState(false),[confDel,setConfDel]=useState(false),[showWeights,setShowWeights]=useState(false),[showQty,setShowQty]=useState(false);
  const cfg=BST[batch.status]||BST.Production;
  const subs=subBatches||[];
  const subGood=subs.reduce((s,b)=>s+(b.goodPcs||0),0);
  const subPct=batch.totalPcs?Math.min(100,Math.round(subGood/batch.totalPcs*100)):0;
  const isFO=batch.batchNo.indexOf("EPS-FO-")===0;
  const isSS=batch.product==="Silica Gel Sachets";
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",overflow:"hidden"}}>
    <div style={{padding:"12px 14px"}}>
      <div style={{display:"flex",alignItems:"flex-start",gap:8,flexWrap:"wrap"}}>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"center",gap:7,flexWrap:"wrap",marginBottom:4}}>
            <span style={{fontFamily:"monospace",fontWeight:700,fontSize:14,color:NAVY}}>{batch.batchNo}</span>
            <span style={{display:"inline-flex",alignItems:"center",gap:4,background:cfg.bg,color:cfg.text,borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700}}>
              <span style={{width:6,height:6,borderRadius:"50%",background:cfg.dot}}/>{batch.status}</span>
            {batch.isSample&&<span style={{background:"#FFF3CD",color:"#8A6D00",borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700}}>🎁 Sample</span>}</div>
          <div style={{fontSize:12,color:"#666"}}>{batch.product&&batch.product!=="Flip-Off Caps 20mm"?batch.product+" · ":""}{batch.color?batch.color+" · ":""}{batch.line?batch.line+" · ":""}{batch.cartons} cartons · <strong>{fmtN(batch.totalPcs)} pcs</strong>{batch.client?" · "+batch.client:""}</div>
          {batch.orderNo&&<div style={{fontSize:11,color:"#888",marginTop:2}}>Order: <span style={{fontFamily:"monospace",color:NAVY}}>{batch.orderNo}</span></div>}
          {subs.length>0&&<div style={{marginTop:6}}>
            <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#888",marginBottom:3}}>
              <span>{subs.length} shift{subs.length!==1?"s":""} · {subGood.toLocaleString()} good pcs</span><span>{subPct}%</span></div>
            <div style={{height:4,background:"#F0F0F0",borderRadius:2,overflow:"hidden"}}><div style={{height:"100%",width:subPct+"%",background:subPct>=100?"#22A03A":ACCENT,borderRadius:2}}/></div></div>}</div>
        <div style={{display:"flex",gap:6,flexShrink:0,alignItems:"center"}}>
          {(isFO||isSS)&&<button type="button" onClick={onManageShifts} style={{background:NAVY,color:"#fff",border:"none",borderRadius:7,padding:"8px 14px",cursor:"pointer",fontSize:12,fontWeight:700,whiteSpace:"nowrap"}}>🏭 Shifts{subs.length?" ("+subs.length+")":""}</button>}
          <button type="button" onClick={()=>setExp(!exp)} style={{background:"#F5F7FA",border:"none",borderRadius:7,padding:"8px 11px",cursor:"pointer",fontSize:12,color:"#555"}}>{exp?"▲":"▼"}</button></div>
      </div></div>
    {exp&&<div style={{padding:"0 14px 14px",borderTop:"1px solid #F0F0F0",paddingTop:12}}>
      <div style={{fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",marginBottom:8}}>Update Status</div>
      <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
        {BSTATUSES.map(s=>{const c=BST[s];return(<button type="button" key={s} onClick={()=>onStatusChange(s)} style={{padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer",border:"1.5px solid "+(batch.status===s?c.dot:"#E2E8F0"),background:batch.status===s?c.bg:"#fff",color:batch.status===s?c.text:"#666"}}>{s}</button>);})}</div>
      <div style={{fontSize:12,color:"#666",lineHeight:1.7,marginBottom:10}}>
        <div><strong>Qty:</strong> {batch.bagMix&&batch.bagMix.length?
          (batch.cartons+" cartons × ("+batch.bagMix.map(r=>r.bags+"×"+fmtN(r.pcs)).join(" + ")+")"):
          (batch.cartons+" × "+batch.bagsPerCarton+" × "+fmtN(batch.pcsPerBag))} = {fmtN(batch.totalPcs)} pcs</div>
        {batch.mfgDate&&<div><strong>Mfg:</strong> {batch.mfgDate}</div>}
        {batch.expiryDate&&<div><strong>Expiry:</strong> {batch.expiryDate}{batch.shelfLife?" ("+batch.shelfLife+")":""}</div>}
        {isFO&&<div><strong>Weights:</strong> {batch.capWt||CAP_WT} g/cap plastic · {batch.asmWt||ASM_WT} g/cap assembled · {batch.wastePerInj||WASTE_PER_INJ} g/shot waste</div>}
        {batch.notes&&<div><strong>Notes:</strong> {batch.notes}</div>}</div>
      <button type="button" onClick={()=>setShowQty(true)} style={{padding:"6px 14px",border:"1.5px solid #E2E8F0",color:"#555",background:"#fff",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,marginBottom:10,marginRight:8}}>🔢 Edit Amount</button>
      <button type="button" onClick={()=>onUpdateBatch(Object.assign({},batch,{isSample:!batch.isSample}))} style={{padding:"6px 14px",border:"1.5px solid "+(batch.isSample?"#E6C200":"#E2E8F0"),color:batch.isSample?"#8A6D00":"#555",background:batch.isSample?"#FFF3CD":"#fff",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,marginBottom:10,marginRight:8}}>🎁 {batch.isSample?"Unmark Sample":"Mark as Sample"}</button>
      {isFO&&<button type="button" onClick={()=>setShowWeights(true)} style={{padding:"6px 14px",border:"1.5px solid #E2E8F0",color:"#555",background:"#fff",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600,marginBottom:10,marginRight:8}}>⚖️ Edit Weights</button>}
      {confDel?(<div style={{display:"flex",gap:8}}>
        <button type="button" onClick={()=>{onDelete();setConfDel(false);}} style={{padding:"6px 14px",background:"#DC3545",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:700}}>Yes, delete</button>
        <button type="button" onClick={()=>setConfDel(false)} style={{padding:"6px 14px",border:"1.5px solid #E2E8F0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:12}}>Cancel</button></div>)
      :(<button type="button" onClick={()=>setConfDel(true)} style={{padding:"6px 14px",border:"1.5px solid #F1948A",color:"#DC3545",background:"#FFF0F0",borderRadius:6,cursor:"pointer",fontSize:12}}>Delete batch</button>)}
    </div>}
    {showWeights&&<BatchWeightsModal batch={batch} onSave={u=>{onUpdateBatch(u);setShowWeights(false);}} onClose={()=>setShowWeights(false)}/>}
    {showQty&&<BatchQuantityModal batch={batch} onSave={u=>{onUpdateBatch(u);setShowQty(false);}} onClose={()=>setShowQty(false)}/>}
  </div>);
}
function ProductionSection({data,batches,orders,employees,onCreateBatch,onUpdateBatch,onDeleteBatch,onApplyAluminum,onApplyPlastic,onApplyMaterial,onDeleteSub,onSaveLeftover,onMarkUnpricedSamples}){
  const [showForm,setShowForm]=useState(false),[filterSt,setFilterSt]=useState(""),[search,setSearch]=useState(""),[shiftId,setShiftId]=useState(null);
  const [confSamples,setConfSamples]=useState(false);
  const all=batches||[];
  const main=all.filter(b=>!b.isSubBatch);
  const filtered=main.filter(b=>(!filterSt||b.status===filterSt)&&(!search||b.batchNo.toLowerCase().indexOf(search)>=0||((b.color||"")+(b.client||"")).toLowerCase().indexOf(search)>=0));
  const stats={total:main.length,totalPcs:main.reduce((s,b)=>s+(b.totalPcs||0),0)};
  BSTATUSES.forEach(s=>{stats[s]=main.filter(b=>b.status===s).length;});
  const parent=shiftId?main.filter(b=>b.id===shiftId)[0]:null;

  if(parent&&parent.product==="Silica Gel Sachets")return <SilicaShiftManager parentBatch={parent} batches={all} data={data} employees={employees} onClose={()=>setShiftId(null)}
    onCreateSub={(b,m)=>{onCreateBatch(b);
      if(m){
        if(m.silicaKg)onApplyMaterial("Silica Gel",null,0,m.silicaLotId,m.silicaKg,b.batchNo);
        if(m.rollsUsed)onApplyMaterial("Sachets Paper",null,0,m.rollsLotId,m.rollsUsed,b.batchNo);
        if(m.cartonsUsed)onApplyMaterial("Cartons",null,0,m.cartonsLotId,m.cartonsUsed,b.batchNo);
        if(m.wipPcsUsed)onApplyMaterial("WIP Inventory",null,0,m.wipLotId,m.wipPcsUsed,b.batchNo);
      }}}
    onUpdateSub={(b,m,old)=>{onUpdateBatch(b);
      if(m){
        onApplyMaterial("Silica Gel",old?old.silicaLotId:null,old?(old.silicaKg||0):0,m.silicaLotId,m.silicaKg,b.batchNo);
        onApplyMaterial("Sachets Paper",old?old.rollsLotId:null,old?(old.rollsUsed||0):0,m.rollsLotId,m.rollsUsed,b.batchNo);
        onApplyMaterial("Cartons",old?old.cartonsLotId:null,old?(old.cartonsUsed||0):0,m.cartonsLotId,m.cartonsUsed,b.batchNo);
      }}}
    onDeleteSub={onDeleteSub} onSaveLeftover={onSaveLeftover}/>;
  if(parent)return <ShiftManager parentBatch={parent} batches={all} data={data} employees={employees} onClose={()=>setShiftId(null)}
    onCreateSub={(b,m)=>{onCreateBatch(b);
      if(m&&m.plasticLotId!==undefined)onApplyPlastic(null,0,m.plasticLotId,m.plasticBags,b.batchNo);
      if(m&&m.wipLotId)onApplyMaterial("WIP Inventory",null,0,m.wipLotId,m.wipPcsUsed,b.batchNo);}}
    onUpdateSub={(b,m,old)=>{onUpdateBatch(b);
      if(m&&m.plasticLotId!==undefined)onApplyPlastic(old?old.plasticLotId:null,old?(old.virginBags||0):0,m.plasticLotId,m.plasticBags,b.batchNo);
      if(m&&m.selections)onApplyAluminum(old?(old.aluminumSelections||[]):[],m.selections);
      if(m&&m.cartonsLotId!==undefined)onApplyMaterial("Cartons",old?old.cartonsLotId:null,old?(old.cartonsUsed||0):0,m.cartonsLotId,m.cartonsUsed,b.batchNo);}}
    onDeleteSub={onDeleteSub} onSaveLeftover={onSaveLeftover}/>;
  if(showForm)return <BatchForm batches={all} orders={orders} onSave={b=>{onCreateBatch(b);setShowForm(false);}} onCancel={()=>setShowForm(false)}/>;

  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:16,flexWrap:"wrap"}}>
      {[["Batches",stats.total],["Production",stats.Production],["QC Hold",stats["QC Hold"]],["Released",stats.Released],["Shipped",stats.Shipped],["Total Pcs",fmtN(stats.totalPcs)]].map(x=>(
        <div key={x[0]} style={{background:"#fff",borderRadius:10,padding:"10px 14px",border:"1.5px solid #EEF2F7",flex:1,minWidth:90}}>
          <div style={{fontSize:9,fontWeight:700,color:"#999",textTransform:"uppercase"}}>{x[0]}</div>
          <div style={{fontSize:18,fontWeight:900,color:NAVY,marginTop:3}}>{x[1]}</div></div>))}</div>
    <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap",alignItems:"center"}}>
      <input value={search} onChange={e=>setSearch(e.target.value.toLowerCase())} placeholder="Search…" style={{flex:1,minWidth:150,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"8px 12px",fontSize:13,outline:"none"}}/>
      <select value={filterSt} onChange={e=>setFilterSt(e.target.value)} style={{border:"1.5px solid #E2E8F0",borderRadius:8,padding:"8px 12px",fontSize:13,background:"#fff"}}>
        <option value="">All statuses</option>{BSTATUSES.map(s=><option key={s}>{s}</option>)}</select>
      <button type="button" onClick={()=>setShowForm(true)} style={{background:NAVY,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontWeight:700,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"}}>+ New Batch</button>
      {confSamples?(<div style={{display:"flex",gap:6,alignItems:"center",background:"#FFF3CD",border:"1px solid #E6C200",borderRadius:8,padding:"6px 10px"}}>
        <span style={{fontSize:11,color:"#8A6D00",fontWeight:600}}>Mark all batches with no price/cost on record as free samples?</span>
        <button type="button" onClick={()=>{onMarkUnpricedSamples();setConfSamples(false);}} style={{padding:"5px 10px",background:"#8A6D00",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:700}}>Yes</button>
        <button type="button" onClick={()=>setConfSamples(false)} style={{padding:"5px 10px",border:"1.5px solid #E2E8F0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:11}}>Cancel</button></div>)
      :(<button type="button" onClick={()=>setConfSamples(true)} style={{padding:"8px 12px",border:"1.5px solid #E2E8F0",color:"#555",background:"#fff",borderRadius:8,cursor:"pointer",fontSize:12,fontWeight:600,whiteSpace:"nowrap"}}>🎁 Mark Un-priced as Samples</button>)}</div>
    {filtered.length===0?(<div style={{textAlign:"center",padding:40,background:"#fff",borderRadius:12,border:"2px dashed #E2E8F0"}}>
      <div style={{fontSize:32,marginBottom:8}}>🏭</div><div style={{fontWeight:700,color:"#333"}}>No batches</div></div>)
    :(<div style={{display:"flex",flexDirection:"column",gap:8}}>
      {filtered.map(batch=><BatchCard key={batch.id} batch={batch} subBatches={all.filter(b=>b.parentBatchNo===batch.batchNo&&b.isSubBatch)}
        onStatusChange={st=>onUpdateBatch(Object.assign({},batch,{status:st}))} onDelete={()=>onDeleteBatch(batch.id)} onManageShifts={()=>setShiftId(batch.id)} onUpdateBatch={onUpdateBatch}/>)}</div>)}
  </div>);
}

// ══ ORDERS ════════════════════════════════════════════════════════════════
function orderFinance(order){
  const sellPricePerPc=Number(order.sellPricePerPc)||0;
  const estCostEGP=Number(order.estCostEGP)||0;
  const extraExpenses=order.extraExpenses||[];
  const extraExpensesEGP=extraExpenses.reduce((s,e)=>s+(Number(e.amountEGP)||0),0);
  const totalCostEGP=estCostEGP+extraExpensesEGP;
  // A Rejected order is never going to be sold — the material/labor cost already happened and
  // won't come back, but there's no revenue to offset it, so it's a full loss (not priced as
  // if it were a normal sale even if a sell price had been set for it).
  const isRejected=order.status==="Rejected";
  const revenueEGP=isRejected?0:sellPricePerPc*(Number(order.targetQty)||0);
  const profitEGP=revenueEGP-totalCostEGP;
  const marginPct=revenueEGP>0?profitEGP/revenueEGP*100:null;
  return {sellPricePerPc:sellPricePerPc,estCostEGP:estCostEGP,extraExpenses:extraExpenses,extraExpensesEGP:extraExpensesEGP,
    totalCostEGP:totalCostEGP,revenueEGP:revenueEGP,profitEGP:profitEGP,marginPct:marginPct,isRejected:isRejected};
}
function OrderFinanceModal({order,onSave,onClose}){
  const [price,setPrice]=useState(order.sellPricePerPc?String(order.sellPricePerPc):"");
  const [cost,setCost]=useState(order.estCostEGP?String(order.estCostEGP):"");
  const [expenses,setExpenses]=useState(order.extraExpenses||[]);
  const [expLabel,setExpLabel]=useState(""),[expAmount,setExpAmount]=useState("");
  const expensesTotal=expenses.reduce((s,e)=>s+(Number(e.amountEGP)||0),0);
  const addExpense=()=>{
    if(!expLabel.trim()||!(Number(expAmount)>0))return;
    setExpenses(p=>p.concat([{id:genId(),label:expLabel.trim(),amountEGP:Number(expAmount)||0}]));
    setExpLabel("");setExpAmount("");
  };
  const removeExpense=id=>setExpenses(p=>p.filter(e=>e.id!==id));
  const save=()=>onSave({sellPricePerPc:Number(price)||0,estCostEGP:Number(cost)||0,extraExpenses:expenses});
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16,overflowY:"auto"}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:420,overflow:"hidden",margin:"24px 0"}}>
      <div style={{background:"#1A6B2A",padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>💰 Sale Price &amp; Cost</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{order.orderNo}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{marginBottom:14}}><Field label="Sold For (EGP per Pc)" value={price} onChange={setPrice} type="number" ph="e.g. 0.85"/></div>
        <div style={{marginBottom:18}}><Field label="Estimated Total Cost (EGP)" value={cost} onChange={setCost} type="number" ph="e.g. 150000"/>
          <div style={{fontSize:11,color:"#999",marginTop:4}}>A rough total — material + labor for this order.</div></div>
        <div style={{marginBottom:18}}>
          <label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:6,textTransform:"uppercase"}}>Extra Expenses (optional)</label>
          <div style={{fontSize:11,color:"#999",marginBottom:8}}>One-off costs beyond the estimate above — e.g. an engineer called in to fix something.</div>
          {expenses.length>0&&<div style={{display:"flex",flexDirection:"column",gap:6,marginBottom:10}}>
            {expenses.map(e=>(<div key={e.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",background:"#F7F9FC",borderRadius:6,padding:"6px 10px",fontSize:12}}>
              <span>{e.label}</span>
              <span style={{display:"flex",alignItems:"center",gap:8}}><strong>{fmt(e.amountEGP)} EGP</strong>
                <button type="button" onClick={()=>removeExpense(e.id)} style={{background:"none",border:"none",color:"#DC3545",cursor:"pointer",fontSize:13,padding:0}}>✕</button></span></div>))}
            <div style={{fontSize:11,color:"#666",textAlign:"right"}}>Subtotal: <strong>{fmt(expensesTotal)} EGP</strong></div></div>}
          <div style={{display:"flex",gap:6}}>
            <input value={expLabel} onChange={e=>setExpLabel(e.target.value)} placeholder="e.g. Engineer repair" style={{flex:1,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"8px 10px",fontSize:12,outline:"none"}}/>
            <input value={expAmount} onChange={e=>setExpAmount(e.target.value.replace(/,/g,""))} type="number" placeholder="EGP" style={{width:90,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"8px 10px",fontSize:12,outline:"none"}}/>
            <button type="button" onClick={addExpense} style={{padding:"8px 14px",background:"#1A6B2A",color:"#fff",border:"none",borderRadius:8,fontWeight:700,fontSize:12,cursor:"pointer",whiteSpace:"nowrap"}}>+ Add</button></div></div>
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#1A6B2A",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save</button>
      </div></div></div>);
}
function OrderRow({order,linked,allBatches,onDelete,onUpdateOrder}){
  const [confDel,setConfDel]=useState(false);
  const [showFin,setShowFin]=useState(false);
  const [showStatus,setShowStatus]=useState(false);
  const linkedNos=linked.map(b=>b.batchNo);
  const shifts=(allBatches||[]).filter(b=>b.isSubBatch&&linkedNos.indexOf(b.parentBatchNo)>=0);
  const ref=linked.filter(b=>Number(b.bagsPerCarton)>0&&Number(b.pcsPerBag)>0)[0];
  const bpc=ref?Number(ref.bagsPerCarton):0,ppb=ref?Number(ref.pcsPerBag):0;
  const cartonsMode=bpc>0&&ppb>0;
  // Real cartons produced (not each batch's static target totalPcs) — whole cartons plus
  // the partial bag/KG leftover from Final Sorting, converted to a carton fraction.
  const producedCartons=cartonsMode?shifts.reduce((s,x)=>{
    if(x.finalCartons!=null){
      const partialPcs=(Number(x.finalPartialBags)||0)*ppb+kgToPcs(Number(x.finalPartialKg)||0,x.asmWt||ASM_WT);
      return s+(Number(x.finalCartons)||0)+partialPcs/(bpc*ppb);
    }
    return s+(Number(x.goodPcs)||0)/(bpc*ppb);   // older shifts/carryovers without cartons detail
  },0):0;
  const targetCartons=cartonsMode&&order.targetQty?order.targetQty/(bpc*ppb):0;
  const produced=cartonsMode?producedCartons:shifts.reduce((s,x)=>s+(x.goodPcs||0),0);
  const pct=cartonsMode?(targetCartons?Math.min(100,Math.round(producedCartons/targetCartons*100)):0)
    :(order.targetQty?Math.min(100,Math.round(produced/order.targetQty*100)):0);
  const cfg=BST[order.status]||BST.Production;
  const {sellPricePerPc,extraExpensesEGP,totalCostEGP,revenueEGP,profitEGP,marginPct}=orderFinance(order);
  return(<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14}}>
    <div style={{display:"flex",alignItems:"flex-start",gap:8,flexWrap:"wrap"}}>
      <div style={{flex:1,minWidth:0}}>
        <div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginBottom:5}}>
          <span style={{fontFamily:"monospace",fontWeight:700,fontSize:14,color:NAVY}}>{order.orderNo}</span>
          <button type="button" onClick={()=>setShowStatus(!showStatus)} style={{display:"inline-flex",alignItems:"center",gap:4,background:cfg.bg,color:cfg.text,borderRadius:20,padding:"3px 10px",fontSize:11,fontWeight:700,border:"none",cursor:"pointer"}}>
            <span style={{width:6,height:6,borderRadius:"50%",background:cfg.dot}}/>{order.status}{showStatus?" ▲":" ▾"}</button></div>
        {showStatus&&<div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:8}}>
          {BSTATUSES.map(s=>{const c=BST[s];return(<button type="button" key={s} onClick={()=>{onUpdateOrder(Object.assign({},order,{status:s}));setShowStatus(false);}} style={{padding:"5px 12px",borderRadius:20,fontSize:11,fontWeight:600,cursor:"pointer",border:"1.5px solid "+(order.status===s?c.dot:"#E2E8F0"),background:order.status===s?c.bg:"#fff",color:order.status===s?c.text:"#666"}}>{s}</button>);})}</div>}
        <div style={{fontSize:12,color:"#666",marginBottom:6}}>{order.product&&order.product!=="Flip-Off Caps 20mm"?order.product+" · ":""}{order.client} · {order.color||"any"} · Target {fmtN(order.targetQty)} pcs{cartonsMode?" ("+fmt(targetCartons)+" cartons)":""}</div>
        <div style={{marginBottom:6}}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#888",marginBottom:3}}>
            <span>{cartonsMode?fmt(producedCartons)+" of "+fmt(targetCartons)+" cartons":fmtN(produced)+" pcs produced"}</span><span>{pct}%</span></div>
          <div style={{height:6,background:"#F0F0F0",borderRadius:3,overflow:"hidden"}}><div style={{height:"100%",width:pct+"%",background:pct>=100?"#22A03A":ACCENT,borderRadius:3}}/></div>
          {cartonsMode&&<div style={{fontSize:11,color:"#888",marginTop:3}}>{fmt(Math.max(0,targetCartons-producedCartons))} cartons left</div>}</div>
        {linked.length>0&&<div style={{fontSize:11,color:"#888",marginBottom:6}}>{linked.length} batches: {linked.map(b=><span key={b.id} style={{fontFamily:"monospace",marginRight:8,color:NAVY}}>{b.batchNo}{b.isSample?" 🎁":""}</span>)}</div>}
        <button type="button" onClick={()=>setShowFin(true)} style={{padding:"5px 10px",border:"1.5px solid #E2E8F0",color:"#555",background:"#fff",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:600,marginBottom:sellPricePerPc>0||totalCostEGP>0?8:0}}>💰 {sellPricePerPc>0||totalCostEGP>0?"Edit":"Set"} Sale Price &amp; Cost</button>
        {(sellPricePerPc>0||totalCostEGP>0)&&(<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(90px,1fr))",gap:8}}>
          <div style={{background:"#F7F9FC",borderRadius:8,padding:"7px 10px"}}><div style={{fontSize:9,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Revenue</div><div style={{fontSize:14,fontWeight:900,color:NAVY,marginTop:1}}>{fmt(revenueEGP)}</div></div>
          <div style={{background:"#F7F9FC",borderRadius:8,padding:"7px 10px"}}><div style={{fontSize:9,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Cost{extraExpensesEGP>0?" (+ extras)":""}</div><div style={{fontSize:14,fontWeight:900,color:NAVY,marginTop:1}}>{fmt(totalCostEGP)}</div></div>
          <div style={{background:profitEGP>=0?"#EAF7EC":"#FFF0F0",borderRadius:8,padding:"7px 10px"}}><div style={{fontSize:9,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Profit</div><div style={{fontSize:14,fontWeight:900,color:profitEGP>=0?"#1A6B2A":"#DC3545",marginTop:1}}>{fmt(profitEGP)}{marginPct!=null?" ("+marginPct.toFixed(0)+"%)":""}</div></div></div>)}</div>
      {confDel?(<div style={{display:"flex",gap:6,flexShrink:0}}>
        <button type="button" onClick={onDelete} style={{padding:"5px 12px",background:"#DC3545",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:700}}>Yes</button>
        <button type="button" onClick={()=>setConfDel(false)} style={{padding:"5px 12px",border:"1.5px solid #E2E8F0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:11}}>Cancel</button></div>)
      :(<button type="button" onClick={()=>setConfDel(true)} style={{padding:"5px 10px",border:"1px solid #F1948A",color:"#DC3545",background:"#FFF0F0",borderRadius:6,cursor:"pointer",fontSize:11,flexShrink:0}}>Delete</button>)}
    </div>
    {showFin&&<OrderFinanceModal order={order} onSave={f=>{onUpdateOrder(Object.assign({},order,f));setShowFin(false);}} onClose={()=>setShowFin(false)}/>}
    </div>);
}
function OrdersSection({batches,orders,onCreateOrder,onDeleteOrder,onDeleteAllOrders,onUpdateOrder}){
  const [showForm,setShowForm]=useState(false),[search,setSearch]=useState("");
  const [confDelAll,setConfDelAll]=useState(false);
  const [client,setClient]=useState(""),[color,setColor]=useState(""),[tq,setTq]=useState("1000000"),[delivery,setDelivery]=useState(""),[status,setStatus]=useState("Production"),[err,setErr]=useState("");
  const [product,setProduct]=useState("Flip-Off Caps 20mm");
  const filtered=orders.filter(o=>!search||(o.orderNo+o.client+(o.color||"")).toLowerCase().indexOf(search.toLowerCase())>=0);
  const preview=nextOrdNo(orders);
  const save=()=>{if(!client.trim()){setErr("Client required.");return;}
    onCreateOrder({id:genId(),orderNo:preview,client:client.trim(),product:product,color:color.trim(),targetQty:Number(tq)||0,deliveryDate:delivery,status:status,notes:"",createdAt:today()});
    setClient("");setColor("");setTq("1000000");setDelivery("");setShowForm(false);};
  if(showForm)return(<div style={{maxWidth:600,fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:NAVY,borderRadius:"12px 12px 0 0",padding:"16px 20px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
      <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>Create New Order</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12,fontFamily:"monospace"}}>{preview}</div></div>
      <button type="button" onClick={()=>setShowForm(false)} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:13}}>Cancel</button></div>
    <div style={{background:"#fff",borderRadius:"0 0 12px 12px",border:"1.5px solid #EEF2F7",borderTop:"none",padding:20}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:12}}>
        <div style={{gridColumn:"1/-1"}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Product</label>
          <select value={product} onChange={e=>setProduct(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            {PRODUCTS.map(pr=><option key={pr}>{pr}</option>)}</select></div>
        <Field label="Client *" value={client} onChange={v=>{setClient(v);setErr("");}} ph="e.g. Pharco"/>
        <Field label={product==="Flip-Off Caps 20mm"?"Cap Color":"Variant"} value={color} onChange={setColor} ph="e.g. Blue"/>
        <Field label="Target Quantity (pcs)" value={tq} onChange={setTq} type="number"/>
        <div><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Delivery Date</label>
          <input type="date" value={delivery} onChange={e=>setDelivery(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/></div>
        <div style={{gridColumn:"1/-1"}}><label style={{display:"block",fontSize:11,fontWeight:700,color:"#666",marginBottom:4,textTransform:"uppercase"}}>Status</label>
          <select value={status} onChange={e=>setStatus(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            {BSTATUSES.map(s=><option key={s}>{s}</option>)}</select></div></div>
      {err&&<div style={{color:"#DC3545",fontSize:12,fontWeight:600,marginBottom:10}}>{err}</div>}
      <button type="button" onClick={save} style={{width:"100%",padding:13,background:"linear-gradient(135deg,"+NAVY+","+ACCENT+")",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save Order</button>
    </div></div>);
  return(<div>
    <div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center"}}>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search orders…" style={{flex:1,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"8px 12px",fontSize:13,outline:"none"}}/>
      <button type="button" onClick={()=>setShowForm(true)} style={{background:NAVY,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",fontWeight:700,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"}}>+ New Order</button></div>
    {orders.length>0&&(confDelAll?(<div style={{display:"flex",gap:8,marginBottom:12,alignItems:"center",background:"#FFF0F0",border:"1px solid #F1948A",borderRadius:8,padding:"8px 12px"}}>
      <span style={{fontSize:12,color:"#DC3545",fontWeight:600,flex:1}}>Delete all {orders.length} orders? Batches are not affected.</span>
      <button type="button" onClick={()=>{onDeleteAllOrders();setConfDelAll(false);}} style={{padding:"5px 12px",background:"#DC3545",color:"#fff",border:"none",borderRadius:6,cursor:"pointer",fontSize:11,fontWeight:700}}>Yes, delete all</button>
      <button type="button" onClick={()=>setConfDelAll(false)} style={{padding:"5px 12px",border:"1.5px solid #E2E8F0",borderRadius:6,background:"#fff",cursor:"pointer",fontSize:11}}>Cancel</button></div>)
    :(<div style={{textAlign:"right",marginBottom:12}}>
      <button type="button" onClick={()=>setConfDelAll(true)} style={{padding:"5px 10px",border:"1px solid #F1948A",color:"#DC3545",background:"#FFF0F0",borderRadius:6,cursor:"pointer",fontSize:11}}>🗑️ Delete All Orders</button></div>))}
    {filtered.length===0?(<div style={{textAlign:"center",padding:40,background:"#fff",borderRadius:12,border:"2px dashed #E2E8F0"}}>
      <div style={{fontSize:32,marginBottom:8}}>📋</div><div style={{fontWeight:700,color:"#333"}}>No orders</div></div>)
    :(<div style={{display:"flex",flexDirection:"column",gap:8}}>
      {filtered.map(o=><OrderRow key={o.id} order={o} linked={batches.filter(b=>b.orderNo===o.orderNo&&!b.isSubBatch)} allBatches={batches} onDelete={()=>onDeleteOrder(o.id)} onUpdateOrder={onUpdateOrder}/>)}</div>)}
  </div>);
}

// ══ ACTIVITY LOG ══════════════════════════════════════════════════════════
function ActivityLog({data,batches,onClose}){
  const [filter,setFilter]=useState("all"),[search,setSearch]=useState("");
  const entries=[];
  Object.keys(data).forEach(matName=>{
    const mc=MATERIAL_META[matName]||{};const lots=data[matName].lots||[];
    lots.forEach(lot=>{
      entries.push({id:"r-"+lot.id,type:"received",date:lot.date||"—",material:matName,emoji:mc.emoji,accent:mc.accent,light:mc.light,color:mc.color,lotNo:lot.lotNumber,qty:lot.qtyReceived,unit:lot.unit,note:lot.supplier||""});
      (lot.usageLog||[]).forEach(e=>entries.push({id:"u-"+e.id,type:"used",date:e.date||"—",material:matName,emoji:mc.emoji,accent:mc.accent,light:mc.light,color:mc.color,lotNo:lot.lotNumber,qty:e.qtyUsed,unit:lot.unit,note:e.reason||""}));
      (lot.bags||[]).filter(b=>b.used).forEach(b=>entries.push({id:"b-"+lot.id+"-"+b.id,type:"used",date:b.usedDate||"—",material:matName,emoji:"🔘",accent:mc.accent,light:mc.light,color:mc.color,lotNo:lot.lotNumber,qty:1,unit:"Bag",note:"Bag "+b.label}));
    });
  });
  batches.forEach(b=>entries.push({id:"bt-"+b.id,type:b.isSubBatch?"shift":"batch",date:b.createdAt||b.mfgDate||"—",material:b.isSubBatch?"Shift":"Production",emoji:b.isSubBatch?"🔄":"🏭",accent:"#607D8B",light:"#ECEFF1",color:"#37474F",lotNo:b.batchNo,qty:b.goodPcs||b.totalPcs,unit:"Pcs",note:(b.color||"")+(b.client?" · "+b.client:"")+(b.stage?" · "+b.stage:"")}));
  const sorted=entries.slice().sort((a,b)=>{try{return new Date(b.date.replace(/-/g," "))-new Date(a.date.replace(/-/g," "));}catch(e){return 0;}});
  const filtered=sorted.filter(e=>{
    if(filter!=="all"&&e.type!==filter)return false;
    const q=search.toLowerCase();
    return [e.material,e.lotNo,e.note].some(v=>(v||"").toLowerCase().indexOf(q)>=0);});
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0D1F3C,"+NAVY+")",position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div style={{flex:1}}><div style={{color:"#fff",fontWeight:800,fontSize:17}}>📋 Activity Log</div>
          <div style={{color:"rgba(255,255,255,0.5)",fontSize:11}}>{sorted.length} entries</div></div></div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16}}>
      <div style={{display:"flex",gap:8,marginBottom:12,flexWrap:"wrap"}}>
        {[["all","All"],["received","📦 In"],["used","📊 Out"],["batch","🏭 Batches"],["shift","🔄 Shifts"]].map(x=>(
          <button type="button" key={x[0]} onClick={()=>setFilter(x[0])} style={{padding:"7px 14px",borderRadius:20,border:"1.5px solid "+(filter===x[0]?NAVY:"#E2E8F0"),background:filter===x[0]?NAVY:"#fff",color:filter===x[0]?"#fff":"#666",fontWeight:700,fontSize:12,cursor:"pointer"}}>{x[1]}</button>))}</div>
      <div style={{marginBottom:12}}><input placeholder="🔍 Search…" value={search} onChange={e=>setSearch(e.target.value)} style={{width:"100%",boxSizing:"border-box",padding:"10px 12px",border:"1.5px solid #E2E8F0",borderRadius:10,fontSize:13,outline:"none",background:"#fff"}}/></div>
      <div style={{display:"flex",flexDirection:"column",gap:7}}>
        {filtered.map(e=>{
          const isIn=e.type==="received"||e.type==="batch"||e.type==="shift";
          const bar=e.type==="batch"||e.type==="shift"?"#607D8B":isIn?e.accent:"#DC3545";
          return(<div key={e.id} style={{background:"#fff",borderRadius:11,border:"1.5px solid #EEF2F7",overflow:"hidden",display:"flex"}}>
            <div style={{width:4,background:bar,flexShrink:0}}/>
            <div style={{flex:1,padding:"10px 12px"}}>
              <div style={{display:"flex",justifyContent:"space-between",gap:8,marginBottom:5,flexWrap:"wrap"}}>
                <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
                  <span>{e.emoji}</span><span style={{fontWeight:700,fontSize:12}}>{e.material}</span>
                  <span style={{fontFamily:"monospace",fontSize:11,color:NAVY}}>{e.lotNo}</span></div>
                <span style={{fontSize:11,color:"#aaa",whiteSpace:"nowrap"}}>{e.date}</span></div>
              <div style={{display:"flex",justifyContent:"space-between",gap:8}}>
                <span style={{fontSize:14,fontWeight:900,color:bar}}>{isIn?"+ ":"− "}{fmtN(e.qty)} {e.unit}</span>
                <span style={{fontSize:11,color:"#888",textAlign:"right"}}>{e.note}</span></div></div>
          </div>);})}
      </div></div></div>);
}

// ══ DASHBOARD ═════════════════════════════════════════════════════════════
function Dashboard({data,batches,onSelect,onLogout,onExport,onImportFile,lastSync,onSection}){
  const importRef=useRef();
  const all=[];Object.keys(data).forEach(k=>{(data[k].lots||[]).forEach(l=>all.push(l));});
  const main=batches.filter(b=>!b.isSubBatch);
  const bStats={total:main.length,prod:main.filter(b=>b.status==="Production").length,rel:main.filter(b=>b.status==="Released").length,totalPcs:main.reduce((s,b)=>s+(b.totalPcs||0),0)};
  const alAvail=buildAluminumAvailability(data);
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0D1F3C,"+NAVY+")",padding:"28px 16px 22px"}}>
      <div style={{maxWidth:700,margin:"0 auto"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
          <div><div style={{color:"rgba(255,255,255,0.4)",fontSize:10,fontWeight:700,textTransform:"uppercase",letterSpacing:"0.12em",marginBottom:4}}>East Pharmaceutical Services</div>
            <h1 style={{color:"#fff",fontSize:22,fontWeight:900,margin:"0 0 3px"}}>EPS Factory System</h1>
            <div style={{color:"rgba(255,255,255,0.35)",fontSize:11}}>Inventory · Production · Orders</div></div>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            <button type="button" onClick={onExport} title="Download a backup of all data" style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.7)",borderRadius:8,padding:"7px 10px",cursor:"pointer",fontSize:12,fontWeight:600}}>⬇️ Backup</button>
            <button type="button" onClick={()=>importRef.current.click()} title="Restore from a backup file" style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.7)",borderRadius:8,padding:"7px 10px",cursor:"pointer",fontSize:12,fontWeight:600}}>⬆️ Restore</button>
            <input ref={importRef} type="file" accept="application/json" style={{display:"none"}} onChange={e=>{const f=e.target.files[0];if(f)onImportFile(f);e.target.value="";}}/>
            <button type="button" onClick={onLogout} style={{background:"rgba(255,255,255,0.1)",border:"1px solid rgba(255,255,255,0.2)",color:"rgba(255,255,255,0.7)",borderRadius:8,padding:"7px 12px",cursor:"pointer",fontSize:12,fontWeight:600}}>🔒 Sign out</button></div></div>
        <div style={{display:"flex",gap:8,marginTop:14,flexWrap:"wrap"}}>
          {[["In Stock",all.filter(l=>l.status==="In Stock").length,"#22C55E","rgba(34,197,94,0.15)"],["Batches",bStats.total,"#60A5FA","rgba(96,165,250,0.15)"],["In Production",bStats.prod,"#FBBF24","rgba(251,191,36,0.15)"],["Released",bStats.rel,"#34D399","rgba(52,211,153,0.15)"]].map(x=>(
            <div key={x[0]} style={{background:x[3],borderRadius:10,padding:"7px 13px",display:"flex",alignItems:"center",gap:7}}>
              <span style={{color:x[2],fontWeight:900,fontSize:17}}>{x[1]}</span>
              <span style={{color:"rgba(255,255,255,0.5)",fontSize:11,fontWeight:600}}>{x[0]}</span></div>))}</div>
        {lastSync&&<div style={{marginTop:10,color:"rgba(255,255,255,0.3)",fontSize:10}}>☁️ Synced {lastSync}</div>}</div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:"18px 16px"}}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:18}}>
        <button type="button" onClick={()=>onSection("production")} style={{background:NAVY,color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:700,fontSize:13,cursor:"pointer",textAlign:"left"}}>🏭 Production
          <div style={{fontWeight:400,fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:4}}>{bStats.total} batches · {fmtN(bStats.totalPcs)} pcs</div></button>
        <button type="button" onClick={()=>onSection("reports")} style={{background:"#4A1A6E",color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:700,fontSize:13,cursor:"pointer",textAlign:"left"}}>🧾 Reports
          <div style={{fontWeight:400,fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:4}}>For the board</div></button>
        <button type="button" onClick={()=>onSection("finance")} style={{background:"#8B6914",color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:700,fontSize:13,cursor:"pointer",textAlign:"left"}}>💰 Finance
          <div style={{fontWeight:400,fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:4}}>Cost per batch</div></button>
        <button type="button" onClick={()=>onSection("labels")} style={{background:"#5A3E1B",color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:700,fontSize:13,cursor:"pointer",textAlign:"left"}}>🏷️ Labels
          <div style={{fontWeight:400,fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:4}}>Batch, carton &amp; bag labels</div></button>
        <button type="button" onClick={()=>onSection("certificates")} style={{background:"#1B5A4E",color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:700,fontSize:13,cursor:"pointer",textAlign:"left"}}>🧪 Certificates
          <div style={{fontWeight:400,fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:4}}>Certificate of Analysis (COA)</div></button>
        <button type="button" onClick={()=>onSection("employees")} style={{background:"#6E3A1B",color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:700,fontSize:13,cursor:"pointer",textAlign:"left"}}>👷 Employees
          <div style={{fontWeight:400,fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:4}}>Roster, stations &amp; wages</div></button>
        <button type="button" onClick={()=>onSection("cashledger")} style={{background:"#0E4A2A",color:"#fff",border:"none",borderRadius:12,padding:14,fontWeight:700,fontSize:13,cursor:"pointer",textAlign:"left"}}>🏦 East Pharma Finance
          <div style={{fontWeight:400,fontSize:11,color:"rgba(255,255,255,0.6)",marginTop:4}}>Cash, P&amp;L, balance sheet &amp; commissions</div></button></div>
      <div onClick={()=>onSelect("Aluminum Caps")} style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:14,marginBottom:18,cursor:"pointer"}}>
        <div style={{fontSize:11,fontWeight:800,color:"#37474F",textTransform:"uppercase",marginBottom:8}}>🔘 Aluminum Availability</div>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:8}}>
          <div><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Already Made</div><div style={{fontSize:16,fontWeight:900,color:"#37474F"}}>{fmtN(alAvail.madeCapsPcs)}</div><div style={{fontSize:10,color:"#aaa"}}>pcs in stock</div></div>
          <div><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Can Still Make</div><div style={{fontSize:16,fontWeight:900,color:"#2D6A9F"}}>{fmtN(alAvail.makeableCapsPcs)}</div><div style={{fontSize:10,color:"#aaa"}}>from {fmt(alAvail.coilKgRemaining)} KG coil</div></div>
          <div><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Total Available</div><div style={{fontSize:16,fontWeight:900,color:"#1A6B2A"}}>{fmtN(alAvail.totalAvailablePcs)}</div><div style={{fontSize:10,color:"#aaa"}}>= Already Made + Can Still Make</div></div></div>
        <div style={{fontSize:10,color:"#bbb"}}>Can Still Make = coil KG × ~{fmtN(COIL_KG_TO_CAPS)} caps/KG. Watch Total Available against what your orders need to know when to buy more coil.</div></div>
      <div style={{fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",letterSpacing:"0.07em",marginBottom:10}}>Raw Material Inventory</div>
      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))",gap:10}}>
        {Object.keys(data).map(matName=>{
          const mc=MATERIAL_META[matName],lots=data[matName].lots||[];
          const totalQty=lots.reduce((s,l)=>s+(Number(l.qtyRemaining)||0),0);
          const unit=lots.length?lots[0].unit:"KG";
          const totalBags=lots.reduce((s,l)=>s+((l.bags&&l.bags.length)||0),0);
          const usedBags=lots.reduce((s,l)=>s+((l.bags&&l.bags.filter(b=>b.used).length)||0),0);
          const sc=Object.keys(STATUS_CONFIG).map(s=>({label:s,count:lots.filter(l=>l.status===s).length,cfg:STATUS_CONFIG[s]})).filter(x=>x.count>0);
          return(<div key={matName} onClick={()=>onSelect(matName)} style={{background:"#fff",borderRadius:12,overflow:"hidden",cursor:"pointer",border:"1.5px solid #EEF2F7"}}>
            <div style={{height:4,background:"linear-gradient(90deg,"+mc.color+","+mc.accent+")"}}/>
            <div style={{padding:14}}>
              <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:10}}>
                <div style={{display:"flex",alignItems:"center",gap:7}}><span style={{fontSize:18}}>{mc.emoji}</span><span style={{fontWeight:800,fontSize:13}}>{matName}</span></div>
                {lots.length===0&&<span style={{background:"#FDDEDE",color:"#8B1A1A",borderRadius:20,padding:"2px 7px",fontSize:10,fontWeight:800}}>NO STOCK</span>}</div>
              <div style={{fontSize:22,fontWeight:900,color:mc.color}}>{lots.length} <span style={{fontSize:11,color:"#aaa",fontWeight:600}}>lots</span></div>
              {lots.length>0&&<div style={{fontSize:12,color:"#777",marginBottom:8}}>
                {isSilica(lots[0])?(totalQty/BAG_KG).toLocaleString()+" bags":totalBags>0?(totalBags-usedBags)+" of "+totalBags+" bags":fmtN(totalQty)+" "+unit} remaining</div>}
              {sc.length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap",marginBottom:8}}>
                {sc.map(s=><span key={s.label} style={{background:s.cfg.bg,color:s.cfg.text,borderRadius:20,padding:"2px 8px",fontSize:10,fontWeight:700}}>{s.count} {s.label}</span>)}</div>}
              <div style={{borderTop:"1px solid #F5F7FA",paddingTop:8,display:"flex",justifyContent:"flex-end"}}>
                <span style={{color:mc.accent,fontWeight:800,fontSize:12}}>Open →</span></div></div></div>);})}
      </div></div></div>);
}

// ══ REPORTS ═══════════════════════════════════════════════════════════════
function ReportPrintBar({onBack,backLabel}){
  return(<div className="eps-no-print" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
    <button type="button" onClick={onBack} style={{background:"#F5F7FA",border:"none",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontWeight:700,fontSize:13,color:"#444"}}>← {backLabel||"Back"}</button>
    <button type="button" onClick={()=>window.print()} style={{background:NAVY,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontWeight:700,fontSize:13}}>🖨️ Print / Save as PDF</button></div>);
}
function ReportTitle({title,subtitle}){
  return(<div style={{marginBottom:20,borderBottom:"2px solid "+NAVY,paddingBottom:14}}>
    <div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.1em"}}>East Pharmaceutical Services</div>
    <h1 style={{fontSize:22,fontWeight:900,color:NAVY,margin:"4px 0 2px"}}>{title}</h1>
    <div style={{fontSize:12,color:"#888"}}>{subtitle} · Generated {today()}</div></div>);
}
function ReportSection({title,children}){
  return(<div style={{marginBottom:22}}>
    <div style={{fontSize:12,fontWeight:800,color:NAVY,textTransform:"uppercase",letterSpacing:"0.06em",marginBottom:10}}>{title}</div>
    {children}</div>);
}
function StatRow({items}){
  return(<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10}}>
    {items.map((x,i)=>(<div key={i} style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}>
      <div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>{x[0]}</div>
      <div style={{fontSize:17,fontWeight:900,color:x[2]||NAVY,marginTop:2}}>{x[1]}</div></div>))}</div>);
}
function WorkerTable({workers}){
  const stages=["Injection","Assembly","Final Sorting"].filter(st=>workers.some(w=>w.stage===st));
  if(!stages.length)return <div style={{color:"#888",fontSize:12}}>No shift data in this period.</div>;
  return(<div style={{display:"flex",flexDirection:"column",gap:16}}>
    {stages.map(st=>(<div key={st}>
      <div style={{fontWeight:700,fontSize:12,color:"#555",marginBottom:6}}>{st}</div>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{borderBottom:"2px solid #E2E8F0",textAlign:"left"}}>
          <th style={{padding:"6px 8px"}}>Operator</th><th style={{padding:"6px 8px"}}>Shifts</th><th style={{padding:"6px 8px"}}>Good Output</th><th style={{padding:"6px 8px"}}>Efficiency</th></tr></thead>
        <tbody>{workers.filter(w=>w.stage===st).map((w,i)=>(
          <tr key={i} style={{borderBottom:"1px solid #F0F0F0"}}>
            <td style={{padding:"6px 8px",fontWeight:700}}>{w.operator}</td>
            <td style={{padding:"6px 8px"}}>{w.shifts}</td>
            <td style={{padding:"6px 8px"}}>{fmtN(w.pcsOut)} pcs</td>
            <td style={{padding:"6px 8px",fontWeight:800,color:w.rate==null?"#888":w.rate>=95?"#1A6B2A":w.rate>=85?"#856404":"#DC3545"}}>{w.rate==null?"—":w.rate.toFixed(1)+"%"}</td>
          </tr>))}</tbody></table></div>))}
  </div>);
}
function WasteBlock({waste}){
  const items=[["Injection Loss",fmt(waste.injLossKg)+" KG","#8B1A1A"],["Plastic Sort Reject",fmt(waste.plasticRejKg)+" KG","#8B1A1A"],["Assembly Shrinkage",fmtN(waste.asmLossPcs)+" pcs","#8B1A1A"],["Final Sort Reject",fmt(waste.finalRejKg)+" KG","#8B1A1A"]];
  const wastePct=waste.totalPlasticInKg>0?((waste.injLossKg+waste.plasticRejKg)/waste.totalPlasticInKg*100):null;
  return(<div>
    <StatRow items={items}/>
    {wastePct!=null&&<div style={{fontSize:12,color:"#666",marginTop:10}}>Plastic waste: <strong>{wastePct.toFixed(1)}%</strong> of total plastic input ({fmt(waste.totalPlasticInKg)} KG)</div>}
  </div>);
}
function MaterialsUsageTable({rows}){
  if(!rows.length)return <div style={{color:"#888",fontSize:12}}>No material movement recorded this month.</div>;
  return(<table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
    <thead><tr style={{borderBottom:"2px solid #E2E8F0",textAlign:"left"}}><th style={{padding:"6px 8px"}}>Material</th><th style={{padding:"6px 8px"}}>Received</th><th style={{padding:"6px 8px"}}>Used</th></tr></thead>
    <tbody>{rows.map((r,i)=>(<tr key={i} style={{borderBottom:"1px solid #F0F0F0"}}>
      <td style={{padding:"6px 8px",fontWeight:700}}>{r.material}</td>
      <td style={{padding:"6px 8px",color:"#1A6B2A"}}>{r.added>0?"+"+fmtN(r.added)+" "+r.unit:"—"}</td>
      <td style={{padding:"6px 8px",color:"#DC3545"}}>{r.used>0?fmtN(r.used)+" "+r.unit:"—"}</td></tr>))}</tbody></table>);
}
function ShiftMaterialsBlock({materials}){
  const alLotRows=Object.keys(materials.alLots);
  return(<div>
    <StatRow items={[["Virgin Plastic",fmtN(materials.virginBags)+" bags"],["Total Plastic",fmt(materials.totalPlasticKg)+" KG"],["Aluminum Caps Used",fmtN(materials.alPcs)+" pcs"]]}/>
    {alLotRows.length>0&&<div style={{marginTop:10,fontSize:12,color:"#555"}}>
      <strong>Aluminum lots drawn from:</strong> {alLotRows.map(l=>l+" ("+fmtN(materials.alLots[l])+" pcs)").join(", ")}</div>}
  </div>);
}
function ShiftTable({shifts}){
  if(!shifts.length)return <div style={{color:"#888",fontSize:12}}>No shifts recorded.</div>;
  return(<div style={{overflowX:"auto"}}><table style={{width:"100%",borderCollapse:"collapse",fontSize:11.5,minWidth:640}}>
    <thead><tr style={{borderBottom:"2px solid #E2E8F0",textAlign:"left"}}>
      <th style={{padding:"6px 8px"}}>Shift</th><th style={{padding:"6px 8px"}}>Date</th><th style={{padding:"6px 8px"}}>Stage</th>
      <th style={{padding:"6px 8px"}}>Inj. Operator</th><th style={{padding:"6px 8px"}}>Asm. Operator</th><th style={{padding:"6px 8px"}}>Sort Operator</th>
      <th style={{padding:"6px 8px"}}>Good Pcs</th></tr></thead>
    <tbody>{shifts.map(s=>(<tr key={s.id} style={{borderBottom:"1px solid #F0F0F0"}}>
      <td style={{padding:"6px 8px",fontFamily:"monospace"}}>{s.batchNo}{s.isCarryover?" ↩️":""}</td>
      <td style={{padding:"6px 8px"}}>{s.mfgDate}</td>
      <td style={{padding:"6px 8px"}}>{s.stage}</td>
      <td style={{padding:"6px 8px"}}>{s.operator||"—"}</td>
      <td style={{padding:"6px 8px"}}>{s.assemblyOperator||"—"}</td>
      <td style={{padding:"6px 8px"}}>{s.finalSortOperator||"—"}</td>
      <td style={{padding:"6px 8px",fontWeight:700}}>{s.goodPcs?fmtN(s.goodPcs):"—"}</td></tr>))}</tbody></table></div>);
}
function MonthlyReportDoc({report,onBack}){
  const productRows=Object.keys(report.byProduct);
  return(<div style={{maxWidth:760,margin:"0 auto",background:"#fff",borderRadius:12,padding:24,fontFamily:"'Inter',sans-serif"}}>
    <ReportPrintBar onBack={onBack} backLabel="Back to Reports"/>
    <ReportTitle title={"Monthly Production Report"} subtitle={fmtMonthKey(report.monthKey)}/>
    <ReportSection title="Production Summary">
      <StatRow items={[["Batches Started",report.batches.length],["Good Pcs Produced",fmtN(report.goodPcs)],
        ...productRows.map(p=>[p,fmtN(report.byProduct[p])+" pcs (target)"])]}/>
    </ReportSection>
    <ReportSection title="Material Usage"><MaterialsUsageTable rows={report.materials}/></ReportSection>
    <ReportSection title="Waste"><WasteBlock waste={report.waste}/></ReportSection>
    <ReportSection title="Worker Performance"><WorkerTable workers={report.workers}/></ReportSection>
    <ReportSection title="Orders Active This Month">
      {report.orders.length===0?<div style={{color:"#888",fontSize:12}}>None.</div>:
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{borderBottom:"2px solid #E2E8F0",textAlign:"left"}}><th style={{padding:"6px 8px"}}>Order</th><th style={{padding:"6px 8px"}}>Client</th><th style={{padding:"6px 8px"}}>Status</th></tr></thead>
        <tbody>{report.orders.map(o=>(<tr key={o.id} style={{borderBottom:"1px solid #F0F0F0"}}>
          <td style={{padding:"6px 8px",fontFamily:"monospace"}}>{o.orderNo}</td><td style={{padding:"6px 8px"}}>{o.client||"—"}</td><td style={{padding:"6px 8px"}}>{o.status}</td></tr>))}</tbody></table>}
    </ReportSection>
  </div>);
}
function BatchOrderReportDoc({type,report,onBack}){
  const isOrder=type==="order";
  const title=isOrder?"Order Report — "+report.order.orderNo:"Batch Report — "+report.batch.batchNo;
  const subtitle=isOrder?(report.order.client||"")+(report.order.color?" · "+report.order.color:""):(report.batch.client||"")+(report.batch.color?" · "+report.batch.color:"")+(report.batch.product?" · "+report.batch.product:"");
  return(<div style={{maxWidth:760,margin:"0 auto",background:"#fff",borderRadius:12,padding:24,fontFamily:"'Inter',sans-serif"}}>
    <ReportPrintBar onBack={onBack} backLabel="Back to Reports"/>
    <ReportTitle title={title} subtitle={subtitle}/>
    <ReportSection title="Production Summary">
      <StatRow items={isOrder?
        [["Batches",report.production.batchCount],["Good Pcs",fmtN(report.production.goodPcs)],["Target",fmtN(report.production.target)],["Completion",report.production.pct!=null?report.production.pct+"%":"—"]]:
        [["Status",report.production.status],["Shifts",report.production.shiftCount],["Good Pcs",fmtN(report.production.goodPcs)],["Target",fmtN(report.production.target)],["Completion",report.production.pct!=null?report.production.pct+"%":"—"]]}/>
    </ReportSection>
    {isOrder&&<ReportSection title="Batches in this Order">
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{borderBottom:"2px solid #E2E8F0",textAlign:"left"}}><th style={{padding:"6px 8px"}}>Batch</th><th style={{padding:"6px 8px"}}>Status</th><th style={{padding:"6px 8px"}}>Good Pcs</th><th style={{padding:"6px 8px"}}>Target</th></tr></thead>
        <tbody>{report.batches.map(r=>(<tr key={r.batch.id} style={{borderBottom:"1px solid #F0F0F0"}}>
          <td style={{padding:"6px 8px",fontFamily:"monospace"}}>{r.batch.batchNo}</td><td style={{padding:"6px 8px"}}>{r.batch.status}</td>
          <td style={{padding:"6px 8px"}}>{fmtN(r.production.goodPcs)}</td><td style={{padding:"6px 8px"}}>{fmtN(r.production.target)}</td></tr>))}</tbody></table>
    </ReportSection>}
    {!isOrder&&<ReportSection title="Shifts"><ShiftTable shifts={report.shifts}/></ReportSection>}
    {!isOrder&&report.carryovers.length>0&&<ReportSection title="Carryovers Logged">
      {report.carryovers.map(c=><div key={c.id} style={{fontSize:12,color:"#555",marginBottom:4}}>↩️ {c.batchNo} — from <strong>{c.carryoverFrom}</strong> ({fmtN(c.goodPcs||c.assembledPcs||c.acceptedPcs||0)} pcs) — {c.notes}</div>)}
    </ReportSection>}
    <ReportSection title="Material Used"><ShiftMaterialsBlock materials={report.materials}/></ReportSection>
    <ReportSection title="Waste"><WasteBlock waste={report.waste}/></ReportSection>
    <ReportSection title="Worker Performance"><WorkerTable workers={report.workers}/></ReportSection>
  </div>);
}
function ReportsSection({data,batches,orders,onClose}){
  const [doc,setDoc]=useState(null);
  const [monthKey,setMonthKey]=useState(()=>{const d=new Date();return d.getFullYear()+"-"+pad(d.getMonth()+1,2);});
  const [pickBatchNo,setPickBatchNo]=useState(""),[pickOrderNo,setPickOrderNo]=useState("");
  const mainBatches=batches.filter(b=>!b.isSubBatch).sort((a,b)=>b.batchNo.localeCompare(a.batchNo));
  if(doc)return(<div className="eps-print-page" style={{minHeight:"100vh",background:"#F7F9FC",padding:"20px 16px"}}>
    {doc.type==="monthly"&&<MonthlyReportDoc report={doc.report} onBack={()=>setDoc(null)}/>}
    {(doc.type==="batch"||doc.type==="order")&&<BatchOrderReportDoc type={doc.type} report={doc.report} onBack={()=>setDoc(null)}/>}
  </div>);
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0D1F3C,"+NAVY+")",position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:17}}>🧾 Reports</div>
          <div style={{color:"rgba(255,255,255,0.5)",fontSize:11}}>For board members and management review</div></div></div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16,display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>📅 Monthly Production Report</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Production, material usage, waste, and worker performance for one month.</div>
        <div style={{display:"flex",gap:8}}>
          <input type="month" value={monthKey} onChange={e=>setMonthKey(e.target.value)} style={{flex:1,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,boxSizing:"border-box"}}/>
          <button type="button" onClick={()=>setDoc({type:"monthly",report:buildMonthlyReport(data,batches,orders,monthKey)})} style={{background:NAVY,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontWeight:700,fontSize:13,cursor:"pointer",whiteSpace:"nowrap"}}>Generate</button></div>
      </div>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>🏭 Batch Report</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Full drill-down on one batch — shifts, material used, waste, worker performance.</div>
        <div style={{display:"flex",gap:8}}>
          <select value={pickBatchNo} onChange={e=>setPickBatchNo(e.target.value)} style={{flex:1,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— select batch —</option>
            {mainBatches.map(b=><option key={b.id} value={b.batchNo}>{b.batchNo} · {b.color}{b.client?" · "+b.client:""}</option>)}</select>
          <button type="button" disabled={!pickBatchNo} onClick={()=>{const b=mainBatches.filter(x=>x.batchNo===pickBatchNo)[0];if(b)setDoc({type:"batch",report:buildBatchReport(b,batches)});}}
            style={{background:pickBatchNo?NAVY:"#E2E8F0",color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontWeight:700,fontSize:13,cursor:pickBatchNo?"pointer":"default",whiteSpace:"nowrap"}}>Generate</button></div>
      </div>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>📋 Order Report</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Rolls up every batch linked to one order — production, material, waste, worker performance.</div>
        <div style={{display:"flex",gap:8}}>
          <select value={pickOrderNo} onChange={e=>setPickOrderNo(e.target.value)} style={{flex:1,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— select order —</option>
            {orders.map(o=><option key={o.id} value={o.orderNo}>{o.orderNo} · {o.client}</option>)}</select>
          <button type="button" disabled={!pickOrderNo} onClick={()=>{const o=orders.filter(x=>x.orderNo===pickOrderNo)[0];if(o)setDoc({type:"order",report:buildOrderReport(o,batches)});}}
            style={{background:pickOrderNo?NAVY:"#E2E8F0",color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontWeight:700,fontSize:13,cursor:pickOrderNo?"pointer":"default",whiteSpace:"nowrap"}}>Generate</button></div>
      </div>
    </div></div>);
}

// ══ LABELS ════════════════════════════════════════════════════════════════
function Barcode({value}){
  const ref=useRef(null);
  useEffect(()=>{
    if(ref.current&&value){
      try{JsBarcode(ref.current,value,{format:"CODE128",displayValue:true,fontSize:9,height:26,margin:0});}catch{/* invalid chars for CODE128 — skip rendering */}
    }
  },[value]);
  return <svg ref={ref}/>;
}
const labelHdStyle={fontSize:8,color:"#666",fontWeight:700,textTransform:"uppercase",letterSpacing:"0.02em"};
const labelValStyle={fontSize:12,fontWeight:800,color:"#111",marginTop:1};
// Sized to fill its grid cell — 8 per printed A4 page (4 rows × 2 columns, see LabelsSection),
// each cell roughly 93×64mm — so the card stretches (height:100%, flex column, space-between)
// instead of sitting small in the top-left of a mostly-empty cell.
function LabelCard({product,client,variantLabel,variantValue,unitLabel,unitText,netQtyText,mfgDate,expDate,serial}){
  const showExp=expDate!=null;
  return(<div className="eps-label-card" style={{border:"1.5px dashed #999",borderRadius:8,padding:"12px 16px",width:"100%",height:"65mm",background:"#fff",breakInside:"avoid",pageBreakInside:"avoid",display:"flex",flexDirection:"column",justifyContent:"space-between",boxSizing:"border-box"}}>
    <div style={{background:"#000",color:"#fff",display:"flex",justifyContent:"space-between",alignItems:"center",padding:"5px 10px",gap:10}}>
      <span style={{fontWeight:800,fontSize:12,letterSpacing:"0.02em"}}>{COMPANY_NAME}</span>
      <span style={{fontSize:8,fontWeight:700,whiteSpace:"nowrap"}}>{COMPANY_CERT}</span></div>
    <div style={{fontSize:16,fontWeight:800,color:"#111"}}>{product}</div>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,1fr)",gap:8}}>
      <div><div style={labelHdStyle}>{unitLabel}</div><div style={labelValStyle}>{unitText}</div></div>
      <div><div style={labelHdStyle}>Client</div><div style={labelValStyle}>{client||"—"}</div></div>
      <div><div style={labelHdStyle}>{variantLabel}</div><div style={labelValStyle}>{variantValue||"—"}</div></div>
      <div><div style={labelHdStyle}>Serial No.</div><div style={{...labelValStyle,fontFamily:"monospace",fontSize:10}}>{serial}</div></div></div>
    <div style={{display:"grid",gridTemplateColumns:"repeat("+(showExp?3:2)+",1fr)",gap:8}}>
      <div><div style={labelHdStyle}>Net Qty</div><div style={labelValStyle}>{netQtyText}</div></div>
      <div><div style={labelHdStyle}>Mfg. Date</div><div style={labelValStyle}>{mfgDate||"—"}</div></div>
      {showExp&&<div><div style={labelHdStyle}>Exp. Date</div><div style={labelValStyle}>{expDate||"—"}</div></div>}</div>
    <div style={{display:"flex",justifyContent:"center"}}><Barcode value={serial}/></div>
    <div style={{borderTop:"1px solid #ddd",paddingTop:6,fontSize:8,color:"#333",lineHeight:1.4}}>
      <div>{COMPANY_PHONE}</div><div>{COMPANY_EMAIL}</div><div>{COMPANY_ADDRESS}</div></div>
  </div>);
}
// Builds one label per unit for a batch — the whole batch, one per carton, or one per bag —
// reusing the same real label template at every scale, just changing the counted unit.
function buildLabels(batch,mode){
  const meta=PRODUCT_META[batch.product]||{variantLabel:"Variant"};
  const isFO=batch.batchNo.indexOf("EPS-FO-")===0;
  const base={product:batch.product,client:batch.client,variantLabel:meta.variantLabel||"Variant",
    variantValue:batch.color,mfgDate:batch.mfgDate};
  if(!isFO)base.expDate=batch.expiryDate||"";
  const bpc=Number(batch.bagsPerCarton)||0,ppb=Number(batch.pcsPerBag)||0;
  const fullCartons=Number(batch.cartons)||0,partialBags=Number(batch.partialCartonBags)||0;
  const partialBagPcs=Number(batch.partialBagPcs)||0;
  const totalCartons=fullCartons+(partialBags>0?1:0);
  const totalBagsOverall=fullCartons*bpc+partialBags;
  // The very last bag overall may hold fewer pcs than a normal full bag (partialBagPcs), so
  // labels for that specific bag/carton need to reflect the real count, not just bagCount×ppb.
  const bagPcsAt=bagNo=>bagNo===totalBagsOverall&&partialBagPcs>0?partialBagPcs:ppb;
  const out=[];
  if(mode==="batch"){
    out.push(Object.assign({},base,{unitLabel:"Batch No.",unitText:batch.batchNo,
      netQtyText:fmtN(batch.totalPcs)+" pcs",serial:batch.batchNo}));
  }else if(mode==="carton"){
    let bagCounter=0;
    for(let c=1;c<=totalCartons;c++){
      const isPartial=c>fullCartons;
      const bagsInCarton=isPartial?partialBags:bpc;
      let cartonPcs=0;
      for(let i=0;i<bagsInCarton;i++){bagCounter++;cartonPcs+=bagPcsAt(bagCounter);}
      out.push(Object.assign({},base,{unitLabel:"Carton No.",unitText:"Carton "+pad(c,2)+" of "+pad(totalCartons,2),
        netQtyText:fmtN(cartonPcs)+" pcs",serial:batch.batchNo+"-C"+pad(c,2)}));
    }
  }else if(mode==="bag"){
    let bagCounter=0;
    for(let c=1;c<=totalCartons;c++){
      const isPartial=c>fullCartons;
      const bagsInCarton=isPartial?partialBags:bpc;
      for(let bI=1;bI<=bagsInCarton;bI++){
        bagCounter++;
        out.push(Object.assign({},base,{unitLabel:"Bag No.",unitText:"Bag "+pad(bI,2)+" of "+pad(bagsInCarton,2)+" (Carton "+pad(c,2)+")",
          netQtyText:fmtN(bagPcsAt(bagCounter))+" pcs",serial:batch.batchNo+"-C"+pad(c,2)+"-B"+pad(bI,2)}));
      }
    }
  }
  return out;
}
function LabelsSection({batches,onClose}){
  const [pickBatchNo,setPickBatchNo]=useState(""),[mode,setMode]=useState("carton"),[labels,setLabels]=useState(null);
  const mainBatches=batches.filter(b=>!b.isSubBatch).sort((a,b)=>b.batchNo.localeCompare(a.batchNo));
  const batch=pickBatchNo?mainBatches.filter(b=>b.batchNo===pickBatchNo)[0]:null;
  const MODES=[["batch","📦 Full Batch","One label for the whole batch"],["carton","🗃️ Per Carton","One label per carton"],["bag","🛍️ Per Bag","One label per bag inside each carton"]];
  if(labels)return(<div className="eps-print-page" style={{minHeight:"100vh",background:"#F7F9FC"}}>
    <div className="eps-label-wrap" style={{maxWidth:680,margin:"0 auto",padding:"20px 16px"}}>
      <ReportPrintBar onBack={()=>setLabels(null)} backLabel="Back to Labels"/>
      <div className="eps-no-print" style={{fontSize:12,color:"#888",marginBottom:14}}>{labels.length} label{labels.length===1?"":"s"} — {batch.batchNo}</div>
      {/* 8 labels per printed page — 2 columns × 4 rows — each page is its own grid so a row
          never splits awkwardly across a page break. */}
      {chunk(labels,8).map((page,pi)=>(
        <div key={pi} className="eps-label-page" style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:"4mm 5mm",marginBottom:"6mm"}}>
          {page.map((l,i)=><LabelCard key={i} {...l}/>)}
        </div>
      ))}
    </div></div>);
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0D1F3C,"+NAVY+")",position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:17}}>🏷️ Labels</div>
          <div style={{color:"rgba(255,255,255,0.5)",fontSize:11}}>Print carton/bag/batch labels for a batch</div></div></div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16,display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>Select Batch</div>
        <select value={pickBatchNo} onChange={e=>setPickBatchNo(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff",marginTop:10}}>
          <option value="">— select batch —</option>
          {mainBatches.map(b=><option key={b.id} value={b.batchNo}>{b.batchNo} · {b.color}{b.client?" · "+b.client:""}</option>)}</select>
      </div>
      {batch&&<div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:12}}>Label Type</div>
        <div style={{display:"flex",flexDirection:"column",gap:8,marginBottom:16}}>
          {MODES.map(m=>(<div key={m[0]} onClick={()=>setMode(m[0])} style={{padding:"12px 14px",borderRadius:9,border:"2px solid "+(mode===m[0]?NAVY:"#E2E8F0"),background:mode===m[0]?"#EBF1F8":"#fff",cursor:"pointer"}}>
            <div style={{fontWeight:700,fontSize:13,color:mode===m[0]?NAVY:"#333"}}>{m[1]}</div>
            <div style={{fontSize:11,color:"#888",marginTop:2}}>{m[2]}</div></div>))}</div>
        <button type="button" onClick={()=>setLabels(buildLabels(batch,mode))} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>🏷️ Generate Labels</button>
      </div>}
    </div></div>);
}

// ══ CERTIFICATES (COA) ════════════════════════════════════════════════════
// Fixed QC spec/test template for Flip-Off Caps — only the header block (batch, qty,
// mfg date) and the issue date are per-generation; the test results are the company's
// standard sign-off, not measured per batch, so they're not pulled from batch data.
// Real letterhead logo from the company's original COA template (COAFO260008.docx),
// embedded so the generated certificate matches it exactly instead of a plain text header.
const COA_LOGO_DATA_URI="data:image/jpeg;base64,/9j/4AAQSkZJRgABAQAA3ADcAAD/4QCMRXhpZgAATU0AKgAAAAgABQESAAMAAAABAAEAAAEaAAUAAAABAAAASgEbAAUAAAABAAAAUgEoAAMAAAABAAIAAIdpAAQAAAABAAAAWgAAAAAAAADcAAAAAQAAANwAAAABAAOgAQADAAAAAQABAACgAgAEAAAAAQAAAVqgAwAEAAAAAQAAAJcAAAAA/+0AOFBob3Rvc2hvcCAzLjAAOEJJTQQEAAAAAAAAOEJJTQQlAAAAAAAQ1B2M2Y8AsgTpgAmY7PhCfv/AABEIAJcBWgMBIgACEQEDEQH/xAAfAAABBQEBAQEBAQAAAAAAAAAAAQIDBAUGBwgJCgv/xAC1EAACAQMDAgQDBQUEBAAAAX0BAgMABBEFEiExQQYTUWEHInEUMoGRoQgjQrHBFVLR8CQzYnKCCQoWFxgZGiUmJygpKjQ1Njc4OTpDREVGR0hJSlNUVVZXWFlaY2RlZmdoaWpzdHV2d3h5eoOEhYaHiImKkpOUlZaXmJmaoqOkpaanqKmqsrO0tba3uLm6wsPExcbHyMnK0tPU1dbX2Nna4eLj5OXm5+jp6vHy8/T19vf4+fr/xAAfAQADAQEBAQEBAQEBAAAAAAAAAQIDBAUGBwgJCgv/xAC1EQACAQIEBAMEBwUEBAABAncAAQIDEQQFITEGEkFRB2FxEyIygQgUQpGhscEJIzNS8BVictEKFiQ04SXxFxgZGiYnKCkqNTY3ODk6Q0RFRkdISUpTVFVWV1hZWmNkZWZnaGlqc3R1dnd4eXqCg4SFhoeIiYqSk5SVlpeYmZqio6Slpqeoqaqys7S1tre4ubrCw8TFxsfIycrS09TV1tfY2dri4+Tl5ufo6ery8/T19vf4+fr/2wBDAAEBAQEBAQIBAQICAgICAgMCAgICAwQDAwMDAwQFBAQEBAQEBQUFBQUFBQUGBgYGBgYHBwcHBwgICAgICAgICAj/2wBDAQEBAQICAgMCAgMIBQUFCAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAgICAj/3QAEABb/2gAMAwEAAhEDEQA/AP7+KKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Q/v4ooooAKKKKAGBaaDgY7V+P3/BXv/gpq3/BPD4U6KfAlrp2q+OfFN8Y9F03Ug7W0Nla4N3dzrGyMyruSNFDrlnznCkV/O0P+Dl79uPv4Y+Hf/gLe/8AyVX6bwz4QZ5m+FWNwlJcjbSbaV7b2v0ufA8QeJeVZZiHhcTUfOkm0le1+5/dP97mnHHWv4Vx/wAHL/7cg6+GPh1/4C33/wAlV+iH/BL/AP4K/wD7dv7ev7VNh8JtU8LeCYfDFjZXGreLdSsILuGa0skXZF5TvPIplknZFVSvK7uRjNd+ceB+fYDC1MZioRjCCbb5l/Xp3OLLfFnKMXXp4ahKTlJpJcvc/qXyp64x1pSuetfkXr//AAWI/Zs8P/8ABTPT/wDgmrdmRtZvNOCTeJVlT7Bb6/IvnwaO46+fJbjdu+6HKRn52Ar9dAwNfluKwFaioOrBrmV1fqn1P0ShiqdXm9nK/K7P1HUUUVym4UUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAf/0f7+KKKKAGAd+lcv4z8ZeGfh74S1Hx340vINP0jSLKbUdSv7lgkVvbwIXkkYnjAUHNdOTgcV/Kn/AMHH37dv/CL+ENO/Ya+Hd6U1HXVh1vxu9u+Gh0tWY2lmxB4a5lXzGH/POMZwHFfV8E8KVs6zKjl9L7T1faK3f3bedj53iriKlleBqYyr9laLu+iP5t/+Cg/7Y/iX9uf9qHX/AI5as1xFpLy/2b4V0y4ODYaPAcQRlRwJJTmWXr87EZIC18T0UV/qBlWWUcFh6WEw8eWEEkl5I/gbH46riq08RWleUm235sWOOWaQQwxvLI7BI4owWd2b7qqByWPYDrX9pXwqi8If8EEv+CS2rfH34jWsEnxR8ZxxyJYvy82u30Un9k6aeRmKyjzJcY7iXGflr8l/+CC37BQ/ai/aV/4Xr4+tXbwX8NbqDUcyKPJvddUrJZ2x3ZDJCMTyjB6IDjeDXxV/wcI/8FG3/bd/a8m+F/w+1Bbj4d/DGefRdEa3YtDqWqnCahqB52sFdTBA2P8AVqzAkSGv5z8W87ea5jS4eov93TtKq196j+v3dj9t8OcpWXYKec1V787qnf8AF/ov+CfiJrfxP+IPiH4m3Xxo1bVryTxVe67J4nuNc37bptUkuDdNchhgq/m/OuAACBgAAV/qc/8ABIn9v3Sv+Ch/7GHh/wCMF1LAvizTV/4R/wAc6dCRm31e0ADybB91LqPbcRjH3XwOlf5Rdftd/wAEJ/8Agovc/sB/tk2Fp4wvTF8PviBJb+G/F8UrkQ2cjyAWWp45CtbSMVc45hdgfurj4LxB4ZWOwN6Uffp6x9Oq+7bzSPsuDc9eFxfLUfuz0fr0f+Z/qFUVFFLHPEssLKyOAysvIIPcVLX8un74FFFFAHOaV4l8O67e3unaLf2d3Pps4tdQhtpkkktpiufLmVSSjY5wcGprHXtE1LUb3R9NvLae809o0v7aGRWltjKu+MSoDlC6fMucZHIr+Sf4ZeIfiN+x5+2t+0N/wUL8LT3l54EtP2hb34f/ABu0H5mhtPDUlnp9xaeI4Y1OTNplxcSeecMTbSN0CGvqkfth+F/2Pvj1+3L+03b28WuFNb+FsXh2zimWOHUr/VvDdvBp6NccqkTvIrPKeFjyR0xX1NbhqWvspc2kWtPtNxTT9L39LHg088TSc48urT16JN3+dj+knqfalyBzivwL8Ff8FEf2i/Cvxs8C/B7x/wCKvhB4/b4p2+paTpF18P8A7Sh8M+JbXT5b22gvkeWU3VhO0fkrOpjff1QAiuE+Iv8AwWi+JHgz4Xfs3+N4vDOki88f6hK3xls5Wlb/AIRnTdL1e18O6nPCFOQU1S6EaeZkBVO4dSOKHDeKnKMYJO+34/5M6ZZ1Qim5Stbf8P8AM/owGO1IowtfFH7Mn7RvjH9oD40/GPS4LOxj8D+A/Ftp4G8NarDv+06hqtlZpLrpkydpit7mZIIyo5ZJATkYr7VBKjn0zXj1cPKnLllv/mrno0qqmuaOxJRRRWZoFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB//9L+/iiiigD5w/av/aO8Gfsm/s+eKfj545kRbPw9pkt1DbswVru7I221rHn+OeUrGv1z2r/MR+N/xl8dftCfFvxB8bPiVctda34l1ObVL2Q/dQyHEcKDnEcMYWKMdkUCv3l/4OFf2+I/jt8arb9k74b3om8L+A7o3GvzWsmYb7X2UDYSuQVsVJTr/rWfP3Qa/nHr+9vo/cA/2bl39o4iNqtZXXdR6L57v5dj+P8Axj4w+vY76nRl+7pfjLq/0/4cK63wD4D8W/FHxvpPw38B2UuoazrmoQaZptlCpZ5ridgijjkDJyT2FclX9Vf/AAb4/sd+HfCOi+IP+Ckvx3EVhougWV7aeELq/ISGKO3R11TVGJwNqIGgjb3lPUAj9Q494vpZJllXHT1ktIr+aT2X37+Vz8/4Q4bnmuOp4WGi3k+yW7/yPoD/AIKN/GPwR/wQ+/4JTaR+yb8FLuNfiN46srnRbS/tmC3RubmEf2xrr/xAxgiOFscOY1H3eP8APrwcepOSSTnvk89yT1r9Cf8Agp7+3d4n/wCCh/7X3iH4+ao00Whq39i+DNNk6Weh2rv9nXb2eYs00nfc/sBX571/OXCmUVcNQlVxL5qtV8035vW3yP3HP8yhWqKnQVqdNWivJdfmFJIqyKY35UjBA4paK+nPnj/SH/4N0v8AgpHN+2X+yu3wO+KWofafiD8MYrfTbuW4ZRNqeiPuWwvAM5Zo1TyJzj76qx++K/ouA+bPrX+RF/wTw/bM8W/sFftdeEf2j/DTzPaaZfLaeJNPiyft+h3TKl9AVGdzeXl4/wDpoq9xX+tD8L/iV4K+Mfw60T4r/Dm/g1TQfEWmW+saRqFs26Oe1uoxJG6keqnkdjweRX8xeIvDP1HGOrSX7ueq8n1X6n77wTnv1vDezqP34aPzXRnf0UUV+eH2Z/FRrv8AwWU/Zw/YC/aZ/ap/Zl+Pvw/8R+NrTxp8YdZ1O9j0w2RspNOvdNs7CW2nS6miYlhC+cAjaw5zX4u/CH/gor+yP4G+Dfx6/Z+8V6N8SNR0H4iaxoGofDXVmk0661Pw5F4YjYaOl6JpxHOLMiGEKu9ZIE2nBNUP22vDWg+NP+C/Gv8AgzxVax32lav+0BpWmanZTcx3Fpc6hbxTRPgj5XRipGQea/vO/wCHNH/BL4jcfgx4PJA/55S//HK/dsbistyuhQlVhJyqxjJ2fWNmnvpqfk+FwuOx9SrGnNJU5NK/ne/Q/kB+DH/Bxtcad8YvBfjf4t+AdD0DRPCcM8ur2Xwy0bSo73xRfSW7QRG5mvBH9it42fzgluxcv8u7aK8D8bf8Fb/2X/EvxL/aM8ZXfhLxp/YXxP8AA954d+HGkE6fu8M3mrXH9q6rcSYnxtm1aOK7Tyy5zuyBkA/28n/gjN/wS/GSfgx4Qx/1yl/+OUxv+CMv/BLtwUPwX8HkHIP7mXof+2leHDizI4S5oYaa0S0t0d+/f+rHpvh3NWkp14uzv17W7Ha/8EsvhTF8Iv2Cvhtos94+panq/h+LxZr+qy8yX+r6/wD8TG+uWyBzJPO34YFfoMBkkfSsDwv4Z0HwV4csPCHha2js9N0u0hsLCzhGI4beBQkca5zhVUADmt/Pp7/pX5djMQ61WdV/abf3n3+Hpezpxh2Q+iuT1Dx34H0uc2up6zpVtKPvRXF5DG4+oZga1dK1/QtdiM+iXtpeIBkvaTJKAPqhIrF05JXaNFNPS5r0UUZFQUFFcfdfEHwFYzta3uuaRDKpw0Ut5Ajg+hBYGulsr+x1K3F5p00VxE33ZYHDofoykirlCS3RKmnsywAw5/Ovlb40/tofs0/s/eOfCvwu+J/ivTbLxL411218O+GvD8Ugn1C8vLx/LQCCPc6xg/edgFUDk19UlgFyT2r/ADM9evL7Uv8Ag5Oa51GaW4kT9qKW1jknkaQpDFq8gjjUsTtRQAFQYA7Cvp+FOHo5hUqqc+VQi5etuh4WfZy8GqfLG7lJI/0z6KQMDyCDS18qe+FFFFABRRRQAUUUUAFFFFABRRRQAUUUUAFFFFAH/9P+/UgnjFfmj/wVW/bj079hL9lDV/iDpjxt4s1otoHgyzcg79SuImInZcgmK2QGVz7KvVhX6XbgOADX8m3/AAcyfsxfEzxDo/hL9qzRb+7v/DXh6E+G9Y0UKTFpr3cjSR6gpGeJm2wSEjgiPnBOPuvDTJ8Jj88wuFx07Qb1Xe2qj89j5DjzNMTg8qr4jCxvJLTy8/kfyCX19falfT6pqc0lxc3U8lzc3EzFpJZZSWd3Y9WZiSTVaiiv9PlGysfwO22z6d/Y3/Zc8a/tlftG+Gv2fvBCssusXYk1K9ClksNMhZWu7p8dBHGeB/E5VR1r95/+Din9szwR+yf+zZ4X/wCCS/7NLrYJcaNZt4uFowV7TQrcq1tZOUx+8v5FMs56tGpz/rc18m/8EAf2rvh9+zj+2RJ4I+IVlaLD8SLS38Naf4imIWXTr5ZS1vDk8CG8dhG/Iw4jOcZr5G/4ON/2Ovif+zx+39rHxs8TXl7rXhv4qv8A25oGsXXzNDNaRRw3Omsw4H2UBPKGB+5Ze4Nfy14nYqri+J8PgsYuWlTjzwXSUur+W1t9L9T+g+AqFPD5DWxWGd6k5csn/LHt8+/+R/P8BjgUUZH9aK7TjCiiigAr+2P/AINdv+CllpHomqf8E+fjJqUVvHpkNx4k+H+oahOkca2rOv2zTA0jDlHc3EQ/umQdgK/icr9OP+CWP/BNH4qf8FNfjnqHw18B6x/wi2m+HtHbWNa8VS273EdoXdY7e3RUeMmWdicDcMIrGvl+MsuwuJy+pDFy5Utebs11/TzufRcM42vRxkHho8zelu67fqf6pJ+JHw6PJ1/RR/2/Qf8Axdbuk+IdA1+J5dCvrO/WNgsjWcyTBSeQCUJwfrX8U/8AxCVfGAf83Aj/AMFFz/8AJlfsn/wSC/4I4+MP+CYXinxh4u8T/FPUvHH/AAlOn2mnpowtXtLC2NpK8n2nbJPKWmYNsyMYXI5yMfzjmWUZbSoueHxvPJbLlav87n7dgsxx1Soo1sNyp9eZO3yP44f2zdY0jw7/AMHA+teIPEFzBZWGn/tDaPe317dOI4be3g1G2eSWRzwqIgJYnoK/0K1/4KL/ALCAH/JXPAGf+wzbf/F1/nL/APBSH4ap8Zv+C2vj/wCDc14dOTxb8Zrfww2oCMTG1XU7qG2MwjyofZvLbSRnGMiv3dH/AAZ5+H8/8l0uv/CVg/8Akyv0jirBZdWw+BeMxDptU1a0b30R8Rw/isdTrYlYWippzd7u1tWf1Fn/AIKLfsHHr8XfAP8A4Obb/wCLq9pP/BQH9iLX9WtdC0X4q+Bbq8vbiO1tLWDV7d5JppWCIiKGyzMxwAOpr+Wf/iDu8P8A/RdLv/wlYP8A5Mr0P4Rf8Gluh/Cr4seF/ilH8a7q9PhvxDp+vCzPhiCPzzYTpP5ZcXZK79m3ODjOcV8TUyfIlF8uOk3/AIGfVRzHN7pPCxt/iP7F+3Jz61/CH/wVu/4LI/tW/tSftdS/8E9P+CfN9qGj6fbeJh4Mk1HQZPL1XxDrcczQzJDcqc29nFICNykM2xpCwTGf7uSARx+Qr8LPHP7G3/BFv/gmx8ZNI/bG8dJ4f+HPiWwury80u6utSnd5ri8jljmlSzLTSSsVkf5gvBPXNebwni8NQrTqVqLqSt7qtdX80dvEWDrVqUadOryRv7zvZ28j8VvDH/BqZ+0P430lPEnx4+Oe/wARXKiW5W2W9v1jdhyjTzyBnIPBPQ9q/Lb9sz9kD/gop/wQg+J3hjx14I+JeqTaJrFxIdB1/Qru6Fi91a7ZJLO/sJ2MZba24BlKuuSDlSR/UV8Vv+Don/gml4EWa38FzeLPFk8TYU6dp32a3k91mnYH80Ffzgf8Fkv+C4/g/wD4Kf8AwR0b4N/D34dav4d0rQvF9v4jHiTVL1Z2lkjtLm2FsIoogi+YtwXyZCRs6HOR+mcOYvPa+JhDHUb0pbppJW8r2Phc6w+U0aEpYWpaotrNt3P7c/8Aglz+2fL+35+xH4M/aW1O0gsNY1KC40/xFY23+qh1XTpmtrryxkkRu6eZGDzsdc1/K5/wW1/4Kz/tWfGz9su4/wCCbP7FGo6hoNnp3iG08GaheaJL9n1PXPEF0yRPbrdKQ0Ftbyy+U4XDM6MxIUc/rV/wa1Mzf8EwipLEL8Q9eUAnhRiAkD8ST9TX87v/AAV8/ZK/aV/4Jw/8FQ7n9vjwdolzrfhHV/iHH8TtA1tYHlsYtRkuBfXmm3zR7jCTN5gViAGiYEfMCK8LhzLMJSzzE0ZRTcebkT2vfQ9XOsdiZ5Vh6sW7StzNb26/efb3hL/g0/8Aj94n0IeIPjF8b418R3aCe6S0jvLxElZclHuJpA8hDEgsBz1FfnT8Y7z/AIKff8G8n7S2h6BD48uvEXhzU7b+0tKhuLm4u/D+uWUcirdWrW90xNvOh2him1l3Kwypwf2++Cv/AAdtfsveKLa2tvjd8PfFHhm6wq3c+j3MWrWwb+IxjbC5APY81+hvh79uX/gin/wVY1Pw54Y8Z6r4S8Ta1ptzPJ4d0DxzBJYXlvPdBFlESzFYmaXYg2B2LbRgV1f21nNCb/tbDe0pO6a5V+DMf7My2tBPL63JU0s7v8UdH+054V+IP/BZH/gmX4S8T/sbeNpPh7feMJtG8VQaw1zdW8ttHbsxu7F5LIiTesgaNh0JU5Ff58tz+zD8ZIf+CkDfsgP4vLePR8VJPBH/AAnJmuc/2wl41udR87P2jJkBfdnfz61/rH/D74deAvhP4StPAPw10jT9C0WwV1stL0uFYLeEO5dtkaAAbmLMfUkmv82PVeP+DkeT/s6q4/8ATxLR4c5vJPFUaSXJGLkrpX8rvqHGmXxaw86j95ySdtj+0v8A4JAfsC/tQfsFeAvGnhf9p34lP8SL3xFrdpqWlXj3d9d/YoILfypIs3xLLuf5sJx681+xRHGFpAR6E+9BII61+TY7HTxFaVapa8uyt+B+i4XDRowVOnsiSiiiuU2CiiigAooooAKKKKACiiigAooooAKKKKAP/9T+/UE5BNea/F74U+Cfjh8MNd+EXxHs1vtD8RaZPpGqWrfxwXCFGwezDOVI5BAI5FelMSBSbTjArSjWlTkpwdmndPqn3IqU4zi4TV09Gj/LF/a6/Zk8cfse/tDeJP2f/HqsbnRLwizvCCFvbCb95a3CHgEPEQT6MCvUEV82+9f3Zf8ABwP+wWf2h/2e0/aX+HtmZPF3w4tprm9jgTL3+gHD3UZxyz2u0zx9eA6j71fwlqwZdw6H+tf6V+FfHUM+ymniZaVI+7Neff0e/wCB/CniDwnLKMwnQXwS1i+6/wCBsWILm4tLiO8spHhnhkWWGWMkOjo25WDdirAEEdxX9onhKw8Kf8F8P+CQ198KfGdzb/8AC1/BSqkd8wAmtvEOno32G7bv5OowDZNjg7pB1QY/i1r9JP8AglX+3FqH7CH7WGl/EDUZZf8AhFNd2eH/ABnaIcq9hM2Y7gL3e0kIlU9Su9Mjca4vFzg2eZ5eq+EX7+i+aHdvrH5r8bHV4c8Txy/GeyxD/dVVaXl2fy/zPwJ1/wAP674U12+8KeKLWbT9T0y8m0/UbK4UpLb3Vu5jlicHBDKwIOfasmv6y/8Ag50/4J52Hw5+JOl/8FCPgxbRS+FvHjwaf4x/s9d8FvrRjLW2oZTKiK/iCqzdPOUEkmWv5NK/JcgzmGPwsMTBWutfJ9V8j9KzjLJYPESoz+XmujCiij/P5V7B5Jf0nS9T17VLbQdEt5ry+v7mKysrS3UvLPPO6xxRIvVnd2Cgetf6of8AwRt/4J6aR/wTu/Y10b4f6pBF/wAJr4iSLxJ48vFALHVLmJf9FVupitEAhQdCQzdWNfydf8GzH/BOAftD/tBT/tofE6xd/CXw1vETw3HcRnydS8SMpKupPDrYIQ7YyBK0Y6qRX+hQcAGvwPxW4l9pUWX0npHWXr0X6n7H4fZF7ODxlRavRfq/0H0UUV+Nn6af5if7WZ/46IL/AP7OQ0P/ANOdrX+nRj5cmv8ALm/4Ka2nxo+Hv/BYf4lfGbwH4X169uvDvxXXxJpEw0e8ubSWfT5o7iIlkiKSRl0GcEgjjNfe/wDxEg/8FfcY/wCEFsv/AAkdQ/8Ajdft/E3DdfMsPgpYaUfdgk7tLoj8uyHOqWCq4mNeL1k2rJvqz/QmyKMiv89n/iJC/wCCv2cf8INZ/wDhI6h/8bo/4iQv+Cvv/QjWf/hI6h/8br5D/iG2Y94f+BI+k/10wfaX/gLP73Pi94+t/hR8KPFHxRu4ftEfhrw9qOvyQA4Mi6fbSXBTPbcExX+af+xZ8Evin/wXu/4KU6nN+0L4rv4Le4sb3xh4gvITuktNJhmSKDT9OjYlIRumRFIHyqGPJNf3nfsC/FH4hft6f8E49A8bftJWP9naz4+8OarpniKyhtZLDZFcSXFmdsEoDpmHBGR1Oelfwkw+Bv24v+DfL9vqf4maf4XvdW0axkvdLtdWazmk0XxJ4cuZQQj3EIcW8pEaPtYh45FHUdfY4Dh7FY2hTklXStFu3nez23PK4tl7R4WrNN0m7yX+aP7NvhT/AMG+n/BKn4TSW13p/wANYNYubYA/aPEN5cagZGHd1kcqc+mMV+Sf/B0joPwL+A/7Ffwy+Anws0HQ/DcurfEFtbtdO0azhtgbTSdPuIZmIjUHAkvYupwefSqNv/wdr6Z470L+yfg38BPEmt+KJYzHDZWuqf2hbpPj5dy2lq0rLnsNpx3r8o/+CgX7G/8AwVi/bL+CGv8A/BUr9r3SZtPNhcadp2gfDiztJmvrLQ7mYxPPDZRl2gjhdo2cMGml3M742c9HD2V4+nj6WIzWtyxi9E5XvLpZX7mGdY7CTwdSlgKXM2tbLp11sf0W/wDBq5fC7/4Jm3lt8oNr8S9ciJHXLQWkvP4PX6kaP/wUi/4J3fGX4xWP7K2i/ELwl4n8Va5cXNla+Gola9WeW0ikknjYmJoAyJHJkM2Tg4zX42f8GpXii7s/2N/Hfwc8SabqulaxonxCl1lrfVbK4s2lstUsbVIpU8+NA4822mVtucEDPUV+Sf8AwV+/4JT/ALU37DX7as37fv7EWjanqPhm88Tx+NrR/DVs11eeG9a8z7RPFLaxgu9pJKHdCqlQjmJgABu8zEZPhsZnWLoVqvI224vo301O6hmVfDZXh6lOnzJJKXe3XQ/q7+M3/BFj/gmV8ebuTUfG3wo8PQXMpZpbjRVbTZGZjksTbFOT64r+Sn/gvN/wRK+Bv/BPn4ZeH/2m/wBmHUNVs9Cv/E0HhrUvDmqXLXL2t1cQT3MFzaXLfvQP9HZXQnglWUjBr7J+G/8AwdzQ+EPCdt4f/aU+DuoJ4ptrcRXlxpupLpsF1MgwXW1vIDJFuIJK7mAPAAGBX5w/toftg/8ABQL/AIOBfiZ4Z+EHwJ+GGs6T4L0q/N5pWlxxzPZJdyKYm1HVNUkijhPlxOyoqDCqxwpZiT7PDGX51hMZGWKq8tKPxc0rq33nm5/istxGHlHD071HtaNmmf1V/wDBvD+1L8S/2q/+CbWia78XdQudW1zwr4g1LwXNq14S093baeY5LR5HP33S3mjjZjyxQknOa/j71VGX/g5JkU5z/wANUXBweuP7XlP8ua/vg/4Js/sS+H/+CfX7IXhf9mjRbsaldaYJ9Q1zVQuwXuq38jT3Uyr1Cb22xg8hFUV/B5/wV0+G3xo/YD/4LI6t+1RqegX0+iN8RNO+KnhrVmilXTL6P7RHeSWr3aqUidZUlhkViGCjcBtYVhwfiaFXNMcqGkZxlyrbqacSUa1PBYSVXVwkub7up/pbZAO2kY7eeK/Gj/glD/wWU+F3/BVa48X6b4H8K6p4WvPB8VhcXMV/dx3sdzHfGVQ0UsUaL+7eIqRyeh4r9l8qw57V+V43A1cNVdGvG0luj9BwuKp16aqU3dMfRRRXIdAUUUUAFFFFABRRRQAUUUUAFFFFABRRRQB//9X+/iiiigDN1Cws9VsJ9L1KKOe2uImhnglUMkkcilXVgRghgcEHqDX+cR/wVz/YVvP2GP2stR8O6FbOvgvxSZvEPg24APlxwTSHz7AnGN9o52gd4mjPUnH+kOeTjtX5c/8ABXD9hVf27v2TdR8GeHY4x4v8PSnxF4PncY3XsEbK9qzdluY2aM9gxVj0r9a8G+PHkeawlVl+6qe7Ly7S+T/C5+beJ3CH9q5dJU43qU9Y+fdfM/zd6GAYEYGDwQeas3dpd6fdyWGoRS29xbyNDPBOpWSKVCQyMp5BUgggjIPWq1f6PJ3V0fxC1rY/sV/4JD/HTwD/AMFIP2EPGP8AwTD/AGlJmu9R0zw7Ppmn3E2HnuNAlCpa3EbPnNzp05UA4+6Im5O6v4gP2pf2bviP+yJ+0B4p/Zx+K8Hla34V1NrCeRQfLuYWAktrqE8ZjuIWSRTjoccEEV94fso/tHeMP2Sv2hfC/wC0F4IaU3Ph7Uorm6s4n8v7dYsQLqzYjjbPFlDnocHnAr+hv/g4c/ZK8EftrfsjeDv+Cqv7M0C6lPpWjwf8JK9mm6W78NXOWE8wXJ83TJyUcYyqPIDgJx/J/F2Tf6v577SCth8U7rtGp1XpL+tj+i+Gs0/tjKfZyd62HXzlH/gf1ufw7V678A/gf8Qv2l/jN4Z+AnwptmvPEHivVrfR9NTB2I8zfNNKRkrFCgaSRudqqT715F2zX9zn/BrT/wAE5l8JeC77/goh8T7Uf2j4jguNB+HsE6Hdb6UsgW81ABuj3MsflRsOREjEcSGubirPo5bg515fFsl3b2X9djp4eyeWNxMaS2W77I/p8/Y7/ZY+Hf7GH7N3hb9m/wCF0Ai0vw3py27zYxJd3chMl1dSkY3STzM0jH1OOlfT34UH1ppLY6Gv5Dr1pVJyqTd23dvzP6QpU1CKhFWSJKKKKgs8A/4Xl+zVeeNNQ8BP4p8Gv4h03zm1PSZL60+3QfZ0Mk3mQs3mZjRSz5GVUEnAru21f4ZLcwWck+iLJc6dJq9ujGAGSxh2eZcqD1hTzE3P90bhk81+U93/AME+fiR4xsfiVrHjXUiovPHvi3xj4P8ADNnFaRpdXN2ko0yW61AQm68tmk3PDvCg4VgyDB474lfsR/tXNceHtF8Ia9fa4mr/AAluvhjruqeIrm2Mfh+HVL3S3vmgitoYXnVrO1uIh8wbcYyGXGT7cMDh5WtXPLeKrJO9I/UvxZ8bv2ZPAejaN4i8aeJvBuk6f4ihFzoN9qF5aQW+oQlFkEltI7BZE2urblJGGBzg11Vn40+Cuom6/s/U/DM4sNKg129aGe1dYdNuldobxyCQLeQRuUl+4wUkE4NfkFo37A/7V6+KdE8Dx+I9N8P6V4Og8bw+F/FOk6fZ3cKWfiSWwvbHTzpmoRXISGznW5iXa4YQxxqrKvA8ym/4J5fH+LT3Pg3w9a6L/wAJZ4Js/g94ysjq5mEPh2cST399DLszJJDdrK1uhCnZeuMqExW39nYVqyr6/wDB/wAjF42uv+XOn/A/zP3n0rxz8PryfSdJ0TVtJkl1rT5NV0W1t7iLde2MXll7i2RWzJEvnRlnQEDeuSMiuB1z4w/s4+IZdd8KeJPEXhC9fw3BLd+ItPvLu1m+wQ27BZpLmNyfLWJsLIW+4xCtgkCvyk8Dfsaftf2Hinwb8apToWl6h8O7fwt4U0Dw4CZrhtB0+1a21vyb0ERRG9a9uG2NE5K2tuNwIG3oNV/Z3+N+ofsm3f7L9j8MtOTxDo3w71bw0fHst7aq2p37xLCs1mxjaXdqTL585n4iPyt5h+as1l1HmVq2l1t08/lp8zX65VcX+7779T9D/gzr37HniWRtR+AU3gC7drs2TT+GxZMxuRF53lboBneIgX29doJ6VteMv2q/2X/Bmojw5478eeD9Nu5WaIWWo6nbRO7K5iZdjvkkOpUjnBBHUV8aeHPA3x38J2fhbxrH4Y8Q63N4Y8bSX9/puqyaNaahLpl5pFzZNJZ/2dBb28hhmkjYxy4ZlLYcYAq58Mf2XvHklr8LfEnjvw3pcV3YfFbxb428RWNw8V1LYabrena9HZwtKUxM6S3tsHVflViSM7ATnVw9O/NOo3+d9f8AgfeVSrztaEEvy6f18j7f1j4z/APwFpUHiTXvEvhfSLK8vptLgvbm8traKW6tmZJoQ7MoLQsrCQZ/d4O7GM16BN4s8JjXLbwpNqOn/wBoahZTahZae0yGe5tICiyzRx53PEhljDMAQC65PIr8h/B/7Onxt+DfjvVfiP4g8B23j6x1ceO9Kt/DSXluPsn9s+J7vVrOdjcqYhFqFtNHHcEAvCI1G2QEgW5f2X/2tn+PWlftSWNn4W0ufwtfeH/C+j+CLLc4/wCEUjtfs+sw216SqwpNcXclyI2iLOthbrlSxwSy+jdr2mmuumr6IqOLqW+D/gH6Un4Wfs+/EjT7XxofDvhPW7a+tkvLTUzY2lzHPBModJUl2sGVlO4MDgjmuf0T46fss+GfCereIPDXinwTY6H4fuI7TWruxvbOK0sJZ5PLjWdoyETzJDtTPDNwMkEV41+xNoPxa8IfsreF/gN8UPB0+ial4S8AaT4bmlub6G4tL+7tbJbWVY3g+dY9yZ3FQdrcc1+aNp+x/wDtPx/D258H+GfCE+laXpsHgaKxtb650q81qxfw94lgv57LStRa2xe6fBaI7wHUUeRpMA4ya1pYWM5Sp1auia66Wvvv2MqtdwjGdOlq1fTf0P2Pn/a9/ZXtdE0/xNc/EXwbDp2q3Fxa6dfy6vapb3E1oUW4SOUuFJiLoHGfl3DOM12fiPW/gj428LX194tuvDWraLp8scN/Nftb3NnBLNHFLGsjPuRTJHPE65PzLIhGQwz+bGt/sqftFfFK/wDDOreH9Y1Twbe6J4R8ZaadW1uw0K/nmvtUvtInsYp7SK0+zfZ2S2ly8KJKBGoLHdWd4Q/Yx+K+la/8P/Bei6HaaF8PNU0fwrefEbQpdSa8ksNU8CJ/oEETlQbpb1xaiSYlTtsY9wO4gT9SoKzjVs1/X322K+tVno6d0/6/M/QW28a/spfBGC1ltNS8DeFYtYnktLRoZrKwF3JBKYpFG3ZuEcoKOeivwSDxXSn9o34Br8R/+FPt4x8N/wDCVi4+yHw7/aEP9oCcp5gj+z7vM3+WQ2MZxz0r81fCvwJ+M3wlGrTeI/hXpnxEPiPw9qmjW1tPf2wis5Ztf1e+W1uhcRsFs7uG+jlkljDMrBlKN8pGt8M/gH8cvB3xh8VTazoOp/2XrXiK9vbWzsJNJ/sE295p0NsoaV7Y6pHGsilSEmDLgFcKcUquCpOUr1b269/1CGKqJRSp28ux+nfgP4sfDL4pi+Pw28QaPrw02cWt+dJu4rr7PIckLJ5TNjdg7T0bBxnBx6MSB1r8tP2FPgv8ZPhf8Qb6TxV4fl0fw1B4NsdEtBrz2N5rFreWlzIy2FrqFlFFJd6ZFE5ZJLvdMZDnjLZ/UogNyc15uMoRp1HGEro7cNVlOCclYdRRRXMbhRRRQAUUUUAFFFFABRRRQAUUUUAf/9b+/iiiigAooooA/hP/AODhH9hG2/Z++Ptt+1F8PbMw+GPiLcy/20kK4gsvEKKGkPHCi8QGXHGZFkPUnP8AO7vX1H51/q+/F/4KfCr4/wDgmb4c/GbQNM8SaJPNFcSabq0C3EJkhbcj7XHDKehHrj1r5CH/AASb/wCCcOP+SOeB/wDwWxf4V/VnAf0iaOX5bSweY0JVJU1ZNNbLa9+qWh/PHFvgnPGY+picHVjCM9bO+/W1unU/zP8AevqK/qM/4N7P2z9G1G48Qf8ABOv45S2994Z8U2F7deFbTUSHhMs6kalpm1s5juomaVUJxlXwMvX9Go/4JMf8E4B/zR3wN/4LYv8ACup8B/8ABNT9g/4Z+MdN+IHgT4V+ENK1nSLpb3TNRtLCNJ7aePO2SNgMqwycEdKOO/HTJc7y2rgqmEmm9Yu8fdktnv8Af5XHwn4SZnlWOp4uniYtLdWeq6o/hV8a/wDBB/4mW/8AwWBh/YY0K2vo/h9q92/jK08TqjtHa+DBKXlQynIN1AcWQ3HLSMjkbScf6Lvw98BeEfhZ4G0j4c/D+wg0vRNDsINL0vT7ZdsdvbW6BI0UegUdepPJ5rqjbQ+eLkxoZAu0SbRv25zjPXHt0qwvQ5GK/njiHinE5lGlGvtBfe+r/r9T9pyXh+hgXUlSXxP8Ow+iiivmj3QooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooA/9f+/iiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigD/0P7+KKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKACiiigAooooAKKKKAP/Z";
// Fixed QC spec/test template for Flip-Off Caps, reproduced from the company's real COA
// (see COAFO260008.docx) — only the header block (batch, qty, mfg date) and the issue date
// are per-generation; the test results are the standard sign-off, not measured per batch.
const COA_PRODUCT_NAME="Flip-Off Aluminum–Plastic Vial Seal (20 mm)";
// item indent level 1 = 0.25in (360 twips), level 2 = 0.5in (720 twips) — matches the
// original document's sub-grouping of the dimension checks under section 1.
const COA_SECTIONS=[
  {title:"1. Appearance & Identification",items:[
    ["Visual Appearance: Clean, uniform color; no burrs or cracks — Complies",1],
    ["Dimensions: 20 mm ± 0.05 mm — Complies",1],
    ["Total Height: 9.2 mm ± 0.1 mm - Complies",2],
    ["Aluminum Height: 7.6 mm ± 0.1 mm - Complies",2],
    ["Flip-Off External Diameter: 22.75 mm ± 0.1 mm - Complies",2],
    ["Aluminum Diameter: 20.3 mm ± 0.05 mm - Complies",2],
    ["Aluminum Alloy ID: Confirms 8011 alloy — Pass",1]]},
  {title:"2. Functional Tests",items:[
    ["Flip-Off Force: 18–25 N — 22 N",1],
    ["Crimping Performance: Must seal properly — Pass",1],
    ["Tamper Evidence: Button detaches clearly — Pass",1]]},
  {title:"3. Material Tests",items:[
    ["Aluminum Thickness: 0.23 mm ± 0.01 — 0.23 mm",1],
    ["Polypropylene Button: Virgin PP — Conforms",1],
    ["Color Masterbatch: Heavy metal–free — Conforms",1]]},
  {title:"4. Chemical & Safety Tests",items:[
    ["Heavy Metals: ≤ EU/USP limits — Pass",1],
    ["Extractables: Within USP <661.1> — Pass",1],
    ["TSE/BSE: Free from animal origin — Complies",1],
    ["ISO 10993: Non-cytotoxic — Pass",1]]},
  {title:"5. Microbiological Tests",items:[
    ["Bioburden: ≤100 CFU/pcs — <10 CFU",1],
    ["Yeast & Mold: ≤10 CFU — <1 CFU",1],
    ["Endotoxin: ≤0.25 EU/mL — Pass",1]]},
  {title:"6. Compliance Statements",items:[
    ["Manufactured under ISO 9001 & GMP",1]]}];
// QC spec/test table for Silica Gel Sachets, transcribed cell-for-cell from the company's own
// 0.5g COA (COAEPSSS260002.docx, an actual grid table — not the bulleted-list layout Flip-Off's
// COA uses) and the client-supplied 1g/10g COAs, which share the identical table. Per Abdallah's
// explicit instruction, the heavy-metal line is kept verbatim as "NLT 100 PPM" exactly like the
// source documents, even though NLT ("not less than") reads backwards for a contaminant ceiling —
// this is intentionally not "corrected" to NMT. Shelf life is 3 years for every size (source
// 1g/10g docs said "One Year") per separate confirmation. Packing dimension/printing are only
// known for 0.5g/1g/10g from those sources; other sizes (e.g. 5g) get a flagged placeholder
// rather than a guessed figure. rowSpan/colSpan below reproduce the source table's real merged
// cells exactly (e.g. "Appearance" and "Content in the packing" are single tall cells spanning
// their sub-rows, "Packing Dimension" spans both label columns).
const SILICA_COA_PACKING={"0.5g":"17*34 MM","1g":"20*42 MM","10g":"45*70 MM"};
const SILICA_COA_PRINTING={"0.5g":"Printed","1g":"Plain White","10g":"Plain White"};
const silicaSizeLabel=size=>(size||"").replace(/g$/,"G");
const coaCell=(text,span)=>Object.assign({text:text},span);
// A cell built from multiple runs of mixed bold/plain text on one line (e.g. a bold "Batch
// Number: " label immediately followed by a plain value) — the header info table needs this;
// the test-items table's cells are always single-style so they keep using plain coaCell.
const coaRuns=(runs,span)=>Object.assign({runs:runs},span);
function silicaCoaTestRows(size){
  const dim=SILICA_COA_PACKING[size]||"— (spec not yet provided for this size)";
  const printing=SILICA_COA_PRINTING[size]||"Plain White";
  return [
    {cells:[coaCell("Test Item",{colSpan:2}),coaCell("Standard"),coaCell("Result"),coaCell("Conclude")]},
    {cells:[coaCell("Appearance",{rowSpan:2}),coaCell("Appearance"),coaCell("Flat, No Damage, No smell, No dirty"),coaCell("Confirm"),coaCell("Pass")]},
    {cells:[coaCell("Printing"),coaCell(printing),coaCell("Confirm"),coaCell("Pass")]},
    {cells:[coaCell("Moisture",{colSpan:2}),coaCell("NMT 4%"),coaCell("3.10%"),coaCell("Pass")]},
    {cells:[coaCell("Content in the packing",{rowSpan:3}),coaCell("Cadmium"),coaCell("NLT 100 PPM"),coaCell("2 PPM"),coaCell("Pass")]},
    {cells:[coaCell("Chromium"),coaCell("NLT 100 PPM"),coaCell("2 PPM"),coaCell("Pass")]},
    {cells:[coaCell("Mercury"),coaCell("NLT 100 PPM"),coaCell("2 PPM"),coaCell("Pass")]},
    {cells:[coaCell("Packing",{colSpan:2}),coaCell("No Damage if fell from 1.2m high"),coaCell("Negative"),coaCell("Pass")]},
    {cells:[coaCell("Packing Dimension: "+silicaSizeLabel(size),{colSpan:2}),coaCell(dim),coaCell(dim),coaCell("Pass")]},
    {cells:[coaCell("Packing Material",{colSpan:2}),coaCell("Water Vapor Permeability"),coaCell("≤0.5g/m² · 24h"),coaCell("Pass")]},
    {cells:[coaCell("Fluorescence",{colSpan:2}),coaCell("No fluorescence"),coaCell("Negative"),coaCell("Pass")]},
    {cells:[coaCell("Decoloration",{colSpan:2}),coaCell("No decoloration"),coaCell("Negative"),coaCell("Pass")]},
    {cells:[coaCell("Residue",{rowSpan:2}),coaCell("Total"),coaCell("NMT 10.0mg/m²"),coaCell("0.1"),coaCell("Pass")]},
    {cells:[coaCell("Benzene"),coaCell("NMT 3.0mg/m²"),coaCell("0.01"),coaCell("Pass")]},
    {cells:[coaCell("Standard Packaging Information",{rowSpan:2,colSpan:2}),coaCell("Prevent dust sex,"),coaCell("≤10 mg/u"),coaCell("Pass")]},
    {cells:[coaCell("Odor Absorption Speed"),coaCell("≤16u ≥0.25/7h·u"),coaCell("Pass")]},
    {cells:[coaCell("Conclusion",{colSpan:2}),coaCell("Confirm with standard",{colSpan:3})]}];
}
const SILICA_SHELF_LIFE="Three Years (Under Good Conditions)";
// Matches the source table exactly: left-column labels are bold with a plain value following on
// the same line; the right column is plain text throughout (not bold, even the label) and right-
// aligned. Row 3 is genuinely ONE cell holding both "Item Name" and "Batch Qty." (with literal
// multiple spaces as separation, as in the source) — the right cell for rows 2 and 3 is empty,
// not a second value column.
function silicaCoaHeaderRows(batch){
  return [
    {cells:[coaRuns([{t:"Batch Number: ",bold:true},{t:batch.batchNo}]),
      coaRuns([{t:"Manufacturer Date: "+(batch.mfgDate||"—")}],{align:"right"})]},
    {cells:[coaRuns([{t:"Shelf Life: ",bold:true},{t:batch.shelfLife||SILICA_SHELF_LIFE}]),
      coaRuns([{t:"Expiry Date: "+(batch.expiryDate||"—")}],{align:"right"})]},
    {cells:[coaRuns([{t:"Client: ",bold:true},{t:batch.client||"—"}]),coaCell("")]},
    {cells:[coaRuns([{t:"Item Name:    ",bold:true},{t:"Silica gel "+(silicaSizeLabel(batch.color)||"—")},
      {t:"        Batch Qty.:    ",bold:true},{t:fmtN(batch.totalPcs)+" PCS"}]),coaCell("")]}];
}
// Draws a bordered grid table cell-by-cell, honoring rowSpan/colSpan on each cell (jsPDF has no
// built-in table support) — used only for Silica's COA, a real table in the source document,
// unlike Flip-Off's bulleted layout. Cells are placed left-to-right/top-to-bottom, skipping any
// column still covered by an earlier row's rowSpan; a rowSpan cell's box grows to the combined
// height of the rows it covers, which is computed after every row's own height is known.
// "≤"/"≥" aren't in the base14 WinAnsi fonts jsPDF draws with — swap them for plain ASCII in
// the PDF only (the on-screen table keeps the real symbols since browsers render them fine).
const pdfSafeText=s=>String(s||"").replace(/≤/g,"<=").replace(/≥/g,">=");
function pdfDrawGridTable(doc,x,startY,colWidths,rowDefs,{fontSize=8.5,boldRows=[],maxY=284.6,marginTop=12.4,fontFamily="times",noBorders=false}={}){
  const pad=1.4,lineH=fontSize*0.42+1.3;
  const nRows=rowDefs.length;
  const occupied=rowDefs.map(()=>({}));
  const placed=rowDefs.map(()=>[]);
  for(let r=0;r<nRows;r++){
    let col=0;
    rowDefs[r].cells.forEach(cell=>{
      while(occupied[r][col])col++;
      const cs=cell.colSpan||1,rs=cell.rowSpan||1;
      placed[r].push({cell:cell,col:col,colSpan:cs,rowSpan:rs});
      for(let rr=r;rr<r+rs;rr++)for(let cc=col;cc<col+cs;cc++)occupied[rr][cc]=true;
      col+=cs;
    });
  }
  const colX=i=>x+colWidths.slice(0,i).reduce((a,b)=>a+b,0);
  const spanW=(c,n)=>colWidths.slice(c,c+n).reduce((a,b)=>a+b,0);
  // Cells with `runs` (mixed bold/plain text on one line, e.g. a bold label + plain value) are
  // measured as a single line with a total width (for right-alignment); plain-text cells wrap
  // normally across the cell's width, same as before.
  const measured={},rowH=new Array(nRows).fill(0);
  for(let r=0;r<nRows;r++){
    const rowBold=boldRows.indexOf(r)!==-1;
    doc.setFontSize(fontSize);
    placed[r].forEach(p=>{
      if(p.cell.runs){
        let totalW=0;
        p.cell.runs.forEach(run=>{doc.setFont(fontFamily,run.bold||rowBold?"bold":"normal");totalW+=doc.getTextWidth(run.t);});
        measured[r+"-"+p.col]={runs:true,totalW:totalW};
        if(p.rowSpan===1)rowH[r]=Math.max(rowH[r],lineH+2*pad);
      }else{
        doc.setFont(fontFamily,rowBold?"bold":"normal");
        const lines=doc.splitTextToSize(pdfSafeText(p.cell.text),spanW(p.col,p.colSpan)-2*pad);
        measured[r+"-"+p.col]={lines:lines};
        if(p.rowSpan===1)rowH[r]=Math.max(rowH[r],lines.length*lineH+2*pad);
      }
    });
    if(rowH[r]===0)rowH[r]=lineH+2*pad;
  }
  for(let r=0;r<nRows;r++)placed[r].forEach(p=>{
    if(p.rowSpan>1){
      const m=measured[r+"-"+p.col];
      const needed=(m.lines?m.lines.length:1)*lineH+2*pad;
      let covered=0;for(let rr=r;rr<r+p.rowSpan;rr++)covered+=rowH[rr];
      if(needed>covered)rowH[r+p.rowSpan-1]+=needed-covered;
    }
  });
  let y=startY;
  const rowY=new Array(nRows);
  for(let r=0;r<nRows;r++){
    if(y+rowH[r]>maxY){doc.addPage();y=marginTop;}
    rowY[r]=y;
    y+=rowH[r];
  }
  for(let r=0;r<nRows;r++){
    const rowBold=boldRows.indexOf(r)!==-1;
    placed[r].forEach(p=>{
      const w=spanW(p.col,p.colSpan);
      let h=0;for(let rr=r;rr<r+p.rowSpan;rr++)h+=rowH[rr];
      const cx=colX(p.col);
      if(!noBorders)doc.rect(cx,rowY[r],w,h);
      const m=measured[r+"-"+p.col];
      const ty=rowY[r]+pad+lineH*0.78;
      if(m.runs){
        let tx=p.cell.align==="right"?cx+w-pad-m.totalW:cx+pad;
        p.cell.runs.forEach(run=>{
          doc.setFont(fontFamily,run.bold||rowBold?"bold":"normal");
          doc.text(run.t,tx,ty);
          tx+=doc.getTextWidth(run.t);
        });
      }else{
        doc.setFont(fontFamily,rowBold?"bold":"normal");
        m.lines.forEach((ln,li)=>doc.text(ln,cx+pad,ty+li*lineH));
      }
    });
  }
  return y;
}
// Silica's COA layout, margins and column widths are taken directly from the company's real
// document (COAEPSSS260002.docx — a Word doc with its own page margins, table grid, borderless
// header table and Calibri font), which differs from Flip-Off's own real template — so it gets
// its own full drawing path rather than sharing Flip-Off's below.
function generateSilicaCOAPdf(doc,batch){
  const pageW=210,marginX=15,marginTop=12.35,maxY=284.6;
  doc.setFont("helvetica","normal");
  try{doc.addImage(COA_LOGO_DATA_URI,"JPEG",marginX,marginTop,50.2,22);}catch{/* image decode failed — continue without it */}
  const ruleY=marginTop+22+2.8;
  doc.setDrawColor(30,55,110);doc.setLineWidth(0.26);doc.line(marginX,ruleY,pageW-marginX,ruleY);
  let y=ruleY+11;
  doc.setFontSize(20);doc.setFont("helvetica","bold");
  doc.text("Certificate of Analysis",pageW/2,y,{align:"center"});
  y+=9;
  y=pdfDrawGridTable(doc,marginX,y,[91.68,75.02],silicaCoaHeaderRows(batch),{fontSize:10.5,maxY,marginTop,fontFamily:"helvetica",noBorders:true});
  y+=5;
  y=pdfDrawGridTable(doc,marginX,y,[22.85,30.49,67.12,24.27,21.86],silicaCoaTestRows(batch.color),{fontSize:8,boldRows:[0],maxY,marginTop,fontFamily:"helvetica"});
  y+=8;
  doc.setFontSize(9.5);doc.setFont("helvetica","bold");
  doc.text("Plot number 602 industrial zone 6th October , Giza government",marginX,y); y+=4.5;
  doc.text("neweastpharma@gmail.com     01222442004 - 01110055538",marginX,y);
}
// Builds the COA as a real PDF file (vector text, not a screenshot), laid out to match the
// original document's own margins, fonts, indents and divider color as closely as jsPDF allows.
function generateCOAPdf(batch){
  const doc=new jsPDF({unit:"mm",format:"a4"});
  if(batch.product==="Silica Gel Sachets"){generateSilicaCOAPdf(doc,batch);doc.save("COA-"+batch.batchNo+".pdf");return;}
  const pageW=210,marginX=21.2,marginTop=12.4,maxY=284.6;
  let y=marginTop;
  const ensure=need=>{if(y+need>maxY){doc.addPage();doc.setFont("times","normal");y=marginTop;}};
  doc.setFont("times","normal");
  try{doc.addImage(COA_LOGO_DATA_URI,"JPEG",marginX-9,marginTop-6.8,40,17.5);}catch{/* image decode failed — continue without it */}
  doc.setFontSize(13);
  doc.text("CERTIFICATE OF ANALYSIS (COA)",pageW/2,y+4,{align:"center"});
  y+=16;
  doc.setFontSize(11);
  [["Product: ",COA_PRODUCT_NAME],["Batch/Lot Number: ",batch.batchNo],
    ["Quantity: ",fmtN(batch.totalPcs)+" pcs"],["Manufacturing Date: ",batch.mfgDate||"—"]].forEach(([label,val])=>{
    ensure(5);
    doc.setFont("times","bold");doc.text(label,marginX,y);
    const lw=doc.getTextWidth(label);
    doc.setFont("times","normal");doc.text(val,marginX+lw,y);
    y+=5;
  });
  y+=3;
  // "≤" isn't in the base14 WinAnsi font jsPDF draws with — swap it for plain ASCII in the
  // PDF only (the on-screen version keeps the real symbol since browsers render it fine).
  const pdfSafe=s=>s.replace(/≤/g,"<=");
  COA_SECTIONS.forEach(sec=>{
    ensure(9);
    y+=2;
    doc.setFont("times","bold");doc.text(sec.title,marginX,y); y+=5;
    doc.setFont("times","normal");
    sec.items.forEach(([text,level])=>{
      const ind=marginX+(level===2?12.7:6.35);
      doc.splitTextToSize("-  "+pdfSafe(text),pageW-ind-marginX).forEach(ln=>{ensure(5);doc.text(ln,ind,y);y+=5;});
    });
  });
  y+=4;
  const authX=marginX+79.4;
  ensure(24);
  doc.text("Authorization:",authX,y); y+=5;
  doc.text("QC Analyst: Abdallah Shoukry",authX,y); y+=5;
  doc.text("QA Reviewer: Roger Gendy",authX,y); y+=5;
  doc.text("Date of Issue: "+today(),authX,y); y+=8;
  ensure(10);
  doc.setDrawColor(31,56,100);doc.setLineWidth(0.4);doc.line(marginX,y,pageW-marginX,y); y+=6;
  doc.setFontSize(10);
  doc.text("Plot number 602 industrial zone 6th October , Giza government",marginX,y); y+=4.5;
  doc.text("neweastpharma@gmail.com   01222442004 - 01110055538",marginX,y);
  doc.save("COA-"+batch.batchNo+".pdf");
}
// Real bordered <table> — used only for Silica's COA, whose source document is an actual grid
// table (unlike Flip-Off's bulleted layout).
// Real bordered <table> — used only for Silica's COA, whose source document is an actual grid
// table (unlike Flip-Off's bulleted layout). colWidths (percentages) and noBorders let the
// header-info table (no borders, wide label columns) and the test-items table (bordered, five
// narrower columns) share the same renderer while matching their very different real layouts.
function CoaTable({rows,boldRows,colWidths,noBorders}){
  const br=boldRows||[];
  return(<table style={{width:"100%",borderCollapse:"collapse",fontSize:13,marginBottom:4,tableLayout:"fixed"}}>
    {colWidths&&<colgroup>{colWidths.map((w,i)=><col key={i} style={{width:w+"%"}}/>)}</colgroup>}
    <tbody>
    {rows.map((row,ri)=>(<tr key={ri}>
      {row.cells.map((c,ci)=><td key={ci} rowSpan={c.rowSpan||1} colSpan={c.colSpan||1} style={{border:noBorders?"none":"1px solid #000",padding:noBorders?"2px 4px":"4px 6px",fontWeight:br.indexOf(ri)!==-1?700:400,whiteSpace:"pre-wrap",verticalAlign:"top",textAlign:c.align||"left"}}>
        {c.runs?c.runs.map((r,i2)=><span key={i2} style={{fontWeight:r.bold?700:400}}>{r.t}</span>):c.text}
      </td>)}
    </tr>))}
    </tbody>
  </table>);
}
function COADoc({batch,onBack}){
  const isSachets=batch.product==="Silica Gel Sachets";
  const dlBtn=<button type="button" onClick={()=>generateCOAPdf(batch)} style={{background:NAVY,color:"#fff",border:"none",borderRadius:8,padding:"8px 16px",cursor:"pointer",fontWeight:700,fontSize:13}}>📄 Download PDF</button>;
  const backBtn=<button type="button" onClick={onBack} style={{background:"#F5F7FA",border:"none",borderRadius:8,padding:"8px 14px",cursor:"pointer",fontWeight:700,fontSize:13,color:"#444"}}>← Back to Certificates</button>;
  if(isSachets){
    // Matches COAEPSSS260002.docx exactly: logo top-left, a thin navy rule under it (not
    // overlapping the title like Flip-Off's letterhead), then a plain centered title, a
    // borderless header-info table, the bordered test-items table, and a bold contact footer —
    // Calibri throughout, not Times New Roman.
    return(<div style={{maxWidth:760,margin:"0 auto",background:"#fff",borderRadius:12,padding:24,fontFamily:"Calibri,'Segoe UI',Arial,sans-serif",color:"#000"}}>
      <div className="eps-no-print" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,fontFamily:"'Inter',sans-serif"}}>
        {backBtn}{dlBtn}</div>
      <img src={COA_LOGO_DATA_URI} alt="" style={{width:170,height:74,display:"block"}}/>
      <div style={{borderBottom:"1px solid #1E376E",marginTop:8,marginBottom:18}}/>
      <div style={{textAlign:"center",fontWeight:700,fontSize:26,marginBottom:18}}>Certificate of Analysis</div>
      <CoaTable rows={silicaCoaHeaderRows(batch)} colWidths={[55,45]} noBorders/>
      <div style={{height:8}}/>
      <CoaTable rows={silicaCoaTestRows(batch.color)} boldRows={[0]} colWidths={[13.7,18.3,40.3,14.6,13.1]}/>
      <div style={{fontSize:13,marginTop:20,fontWeight:700}}>📍  Plot number 602 industrial zone 6th October , Giza government</div>
      <div style={{fontSize:13,fontWeight:700}}>✉  neweastpharma@gmail.com &nbsp;&nbsp;&nbsp;&nbsp;&nbsp;📱  01222442004 - 01110055538</div>
    </div>);
  }
  return(<div style={{maxWidth:760,margin:"0 auto",background:"#fff",borderRadius:12,padding:24,fontFamily:"'Times New Roman',Times,serif",color:"#000"}}>
    <div className="eps-no-print" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:20,fontFamily:"'Inter',sans-serif"}}>
      {backBtn}{dlBtn}</div>
    <div style={{position:"relative",marginBottom:20}}>
      <img src={COA_LOGO_DATA_URI} alt="" style={{position:"absolute",left:-14,top:-22,width:151,height:66}}/>
      <div style={{textAlign:"center",fontSize:17,paddingTop:6}}>CERTIFICATE OF ANALYSIS (COA)</div>
    </div>
    <div style={{fontSize:15,marginBottom:3}}><strong>Product: </strong>{COA_PRODUCT_NAME}</div>
    <div style={{fontSize:15,marginBottom:3}}><strong>Batch/Lot Number: </strong>{batch.batchNo}</div>
    <div style={{fontSize:15,marginBottom:3}}><strong>Quantity: </strong>{fmtN(batch.totalPcs)} pcs</div>
    <div style={{fontSize:15,marginBottom:3}}><strong>Manufacturing Date: </strong>{batch.mfgDate||"—"}</div>
    {COA_SECTIONS.map(sec=>(<div key={sec.title}>
      <div style={{fontSize:15,fontWeight:700,marginTop:14,marginBottom:5}}>{sec.title}</div>
      {sec.items.map((it,i)=><div key={i} style={{fontSize:15,marginLeft:it[1]===2?48:24,marginBottom:3}}>-  {it[0]}</div>)}
    </div>))}
    <div style={{marginLeft:300,marginTop:18}}>
      <div style={{fontSize:15,marginBottom:3}}>Authorization:</div>
      <div style={{fontSize:15,marginBottom:3}}>QC Analyst: Abdallah Shoukry</div>
      <div style={{fontSize:15,marginBottom:3}}>QA Reviewer: Roger Gendy</div>
      <div style={{fontSize:15,marginBottom:3}}>Date of Issue: {today()}</div>
    </div>
    <div style={{borderBottom:"1.5px solid #1F3864",marginTop:20,marginBottom:12}}/>
    <div style={{fontSize:13,marginBottom:4}}>Plot number 602 industrial zone 6th October , Giza government</div>
    <div style={{fontSize:13}}>neweastpharma@gmail.com &nbsp;&nbsp; 01222442004 - 01110055538</div>
  </div>);
}
function CertificatesSection({batches,onClose}){
  const [pickBatchNo,setPickBatchNo]=useState(""),[doc,setDoc]=useState(null);
  const mainBatches=batches.filter(b=>!b.isSubBatch&&(b.batchNo.indexOf("EPS-FO-")===0||b.batchNo.indexOf("EPS-SS-")===0)).sort((a,b)=>b.batchNo.localeCompare(a.batchNo));
  const batch=pickBatchNo?mainBatches.filter(b=>b.batchNo===pickBatchNo)[0]:null;
  if(doc)return(<div className="eps-print-page" style={{minHeight:"100vh",background:"#F7F9FC",padding:"20px 16px"}}><COADoc batch={doc} onBack={()=>setDoc(null)}/></div>);
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0D1F3C,"+NAVY+")",position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:17}}>🧪 Certificates</div>
          <div style={{color:"rgba(255,255,255,0.5)",fontSize:11}}>Certificate of Analysis (COA) per batch</div></div></div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16,display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>Select Batch</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Flip-Off Caps and Silica Gel Sachets batches — COA template is specific to each product.</div>
        <select value={pickBatchNo} onChange={e=>setPickBatchNo(e.target.value)} style={{width:"100%",border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff",marginBottom:12}}>
          <option value="">— select batch —</option>
          {mainBatches.map(b=><option key={b.id} value={b.batchNo}>{b.batchNo} · {b.color}{b.client?" · "+b.client:""}</option>)}</select>
        <button type="button" disabled={!batch} onClick={()=>setDoc(batch)} style={{width:"100%",padding:13,background:batch?NAVY:"#E2E8F0",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:batch?"pointer":"default"}}>🧪 Generate COA</button>
      </div>
      {mainBatches.length===0&&<div style={{color:"#888",fontSize:13,textAlign:"center",padding:20}}>No batches yet.</div>}
    </div></div>);
}

// ══ FINANCE ═══════════════════════════════════════════════════════════════
function CurrencyLines({byCurrency}){
  const curs=Object.keys(byCurrency);
  if(!curs.length)return <div style={{color:"#888",fontSize:12}}>None costed yet.</div>;
  return <div style={{display:"flex",gap:16,flexWrap:"wrap"}}>{curs.map(c=>(
    <div key={c} style={{fontSize:20,fontWeight:900,color:NAVY}}>{fmt(byCurrency[c])} <span style={{fontSize:12,color:"#888",fontWeight:700}}>{c}</span></div>))}</div>;
}
function SellingPriceModal({batch,orderPrice,autoCostEGP,onSave,onClose}){
  const [price,setPrice]=useState(batch.sellPricePerPc?String(batch.sellPricePerPc):(orderPrice?String(orderPrice):""));
  const [cost,setCost]=useState(batch.estCostEGP?String(batch.estCostEGP):"");
  const save=()=>onSave({sellPricePerPc:Number(price)||0,estCostEGP:Number(cost)||0});
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:400,overflow:"hidden"}}>
      <div style={{background:"#1A6B2A",padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>💰 Selling Price &amp; Cost</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>{batch.batchNo}</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{marginBottom:14}}><Field label="Selling Price per Pc (EGP)" value={price} onChange={setPrice} type="number" ph="e.g. 0.85"/>
          {orderPrice>0&&!batch.sellPricePerPc&&<div style={{fontSize:11,color:"#999",marginTop:4}}>Pre-filled from this batch&apos;s order ({fmt(orderPrice)} EGP/pc) — edit if this batch sold for a different price.</div>}</div>
        <div style={{marginBottom:18}}><Field label="Estimated Cost Override (EGP)" value={cost} onChange={setCost} type="number" ph="e.g. 150000"/>
          <div style={{fontSize:11,color:"#999",marginTop:4}}>Auto-computed from materials/labor: {fmt(autoCostEGP)} EGP. Leave blank to use that, or write your own estimate to use instead.</div></div>
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:"#1A6B2A",color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save</button>
      </div></div></div>);
}
function BatchCostDoc({cost,orders,onBack,onSaveSellPrice}){
  const [showPrice,setShowPrice]=useState(false);
  const b=cost.batch;
  const linkedOrder=(orders||[]).filter(o=>b.orderNo&&o.orderNo===b.orderNo)[0]||null;
  const orderPrice=linkedOrder?Number(linkedOrder.sellPricePerPc)||0:0;
  return(<div style={{maxWidth:760,margin:"0 auto",background:"#fff",borderRadius:12,padding:24,fontFamily:"'Inter',sans-serif"}}>
    <ReportPrintBar onBack={onBack} backLabel="Back to Finance"/>
    <ReportTitle title={"Batch Cost — "+b.batchNo} subtitle={(b.client||"")+(b.color?" · "+b.color:"")}/>
    {cost.isSilica?(<>
      <ReportSection title="Silica Gel Material">
        <CurrencyLines byCurrency={cost.silicaCost}/>
        <div style={{fontSize:12,color:"#666",marginTop:8}}>{fmtN(cost.silicaKgCosted)} KG costed{cost.silicaKgUncosted>0?" · "+fmtN(cost.silicaKgUncosted)+" KG with no lot cost on file":""}</div>
      </ReportSection>
      <ReportSection title="Packaging Rolls (Sachets Paper)">
        <CurrencyLines byCurrency={cost.rollsCost}/>
        <div style={{fontSize:12,color:"#666",marginTop:8}}>{fmtN(cost.rollsCosted)} rolls costed{cost.rollsUncosted>0?" · "+fmtN(cost.rollsUncosted)+" rolls with no lot cost on file":""}</div>
      </ReportSection>
    </>):(<>
      <ReportSection title="Plastic (virgin only — regrind is reused, no added cost)">
        <CurrencyLines byCurrency={cost.plasticCost}/>
        <div style={{fontSize:12,color:"#666",marginTop:8}}>{fmtN(cost.plasticBagsCosted)} bags costed{cost.plasticBagsUncosted>0?" · "+fmtN(cost.plasticBagsUncosted)+" bags with no lot cost on file":""}
          {cost.regrindKgTotal>0?" · "+fmt(cost.regrindKgTotal)+" KG regrind used (not costed)":""}</div>
      </ReportSection>
      <ReportSection title="Aluminum Caps (priced from the coil they were stamped from)">
        <CurrencyLines byCurrency={cost.alCost}/>
        <div style={{fontSize:12,color:"#666",marginTop:8}}>{fmtN(cost.alPcsCosted)} pcs costed{cost.alPcsAssumed>0?" · "+fmtN(cost.alPcsAssumed)+" pcs with no cost on file, counted at this batch's average rate ("+fmt(cost.avgAlRateEGP)+" EGP/pc)":cost.alPcsUncosted>0?" · "+fmtN(cost.alPcsUncosted)+" pcs from lots with no cost on file and no rate to assume (nothing else in this batch was costed)":""}</div>
        {cost.alCostEGP>0&&<div style={{marginTop:10,background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}>
          <div style={{fontSize:16,fontWeight:900,color:NAVY}}>{fmt(cost.alCostEGP)} <span style={{fontSize:12,color:"#888",fontWeight:700}}>EGP (converted)</span></div>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>{fmtN(cost.alPcsRealRate)} pcs at each coil&apos;s actual purchase-time rate
            {cost.alPcsFallbackRate>0?" · "+fmtN(cost.alPcsFallbackRate)+" pcs at Finance's fallback rate":""}
            {cost.alPcsAssumed>0?" · "+fmtN(cost.alPcsAssumed)+" pcs at this batch's average rate":""}
            {cost.alPcsNoRate>0?" · "+fmtN(cost.alPcsNoRate)+" pcs with no rate available":""}</div></div>}
      </ReportSection>
      <ReportSection title="Aluminum Scrap Credit (estimate)">
        <div style={{fontSize:12,color:"#666",marginBottom:8}}>Scrap generated from the coils behind this batch&apos;s caps: <strong>{fmt(cost.scrapKgForBatch)} KG</strong></div>
        {cost.scrapKgForBatch>0?(<>
          <div style={{fontSize:20,fontWeight:900,color:"#1A6B2A"}}>{fmt(cost.estScrapCreditEGP)} <span style={{fontSize:12,color:"#888",fontWeight:700}}>EGP (estimated credit)</span></div>
          <div style={{fontSize:11,color:"#999",marginTop:4}}>{cost.scrapRateIsAssumed
            ?"Based on an assumed rate of "+fmt(cost.avgScrapRateEGP)+" EGP/KG (no scrap sales recorded yet to measure a real rate)."
            :"Based on your average realized scrap sale rate ("+fmt(cost.avgScrapRateEGP)+" EGP/KG)."} Scrap is sold from a shared pool, not tracked per batch, so this is an estimate, not an exact figure.</div></>)
        :<div style={{color:"#888",fontSize:12}}>No scrap traceable to this batch&apos;s caps yet.</div>}
      </ReportSection>
    </>)}
    {(cost.cartonsCosted>0||cost.cartonsUncosted>0)&&<ReportSection title="Cartons">
      <CurrencyLines byCurrency={cost.cartonsCost}/>
      <div style={{fontSize:12,color:"#666",marginTop:8}}>{fmtN(cost.cartonsCosted)} cartons costed{cost.cartonsUncosted>0?" · "+fmtN(cost.cartonsUncosted)+" cartons with no lot cost on file":""}</div>
    </ReportSection>}
    <ReportSection title="Labor (rates set in Finance — edit any time under Labor Rates)">
      <div style={{display:"flex",flexDirection:"column",gap:6,fontSize:12,color:"#666",marginBottom:8}}>
        {cost.isSilica?(
          <div>Silica Gel Sachets — {cost.silicaShiftsCount} shift{cost.silicaShiftsCount===1?"":"s"} (one person tending the machine): <strong>{fmt(cost.laborSilicaEGP)} EGP</strong></div>
        ):(<>
        <div>Injection — {cost.injectionShifts} shift{cost.injectionShifts===1?"":"s"}: <strong>{fmt(cost.laborInjectionEGP)} EGP</strong></div>
        <div>Plastic Sorting — {fmtN(cost.sortingPcs)} pcs: <strong>{fmt(cost.laborSortingEGP)} EGP</strong></div>
        <div>Press (stamps coil into caps) — {fmtN(cost.pressPcs)} pcs: <strong>{fmt(cost.laborPressEGP)} EGP</strong></div>
        <div>Assembly (plastic + caps) — {fmtN(cost.assemblyPcs)} pcs: <strong>{fmt(cost.laborAssemblyEGP)} EGP</strong></div></>)}</div>
      <div style={{fontSize:20,fontWeight:900,color:NAVY}}>{fmt(cost.laborTotalEGP)} <span style={{fontSize:12,color:"#888",fontWeight:700}}>EGP labor total</span></div>
    </ReportSection>
    <div style={{background:"#EBF1F8",borderRadius:10,padding:16,marginBottom:16}}>
      <div style={{fontSize:11,fontWeight:800,color:NAVY,textTransform:"uppercase",marginBottom:6}}>Net EGP ({cost.isSilica?"Silica Gel + Rolls + Cartons + Labor":"Plastic + Aluminum + Cartons + Labor − Scrap Credit"})</div>
      <div style={{fontSize:26,fontWeight:900,color:NAVY}}>{fmt(cost.netEGP)} <span style={{fontSize:13,color:"#888",fontWeight:700}}>EGP</span></div>
      <div style={{fontSize:11,color:"#888",marginTop:4}}>{cost.isSilica?"Silica Gel and rolls priced in USD are converted using each lot's own purchase-time rate where set, otherwise Finance's fallback rate.":"Aluminum is converted to EGP using each coil's purchase-time rate where set, otherwise Finance's fallback rate."}</div>
      {!cost.isSilica&&cost.rejectedPcsTotal>0&&<div style={{fontSize:11,color:"#888",marginTop:4}}>⚠️ Includes {fmtN(cost.rejectedPcsTotal)} rejected pcs — that material and labor were already spent and don&apos;t come back, so it&apos;s counted here like any other pcs, not netted out.</div>}
    </div>
    <div style={{background:"#F7F9FC",borderRadius:10,padding:14,fontSize:12,color:"#666",marginBottom:16}}>
      This covers {cost.isSilica?"silica gel, rolls, cartons, and labor":"plastic, aluminum, cartons, and labor"} cost — no overhead applied yet. Add more cost inputs over time to make this more accurate.</div>
    <ReportSection title="Selling Price & Profit">
      <div className="eps-no-print" style={{marginBottom:10}}>
        <button type="button" onClick={()=>setShowPrice(true)} style={{padding:"6px 14px",border:"1.5px solid #E2E8F0",color:"#555",background:"#fff",borderRadius:6,cursor:"pointer",fontSize:12,fontWeight:600}}>✏️ {cost.sellPricePerPc>0||cost.estCostEGP>0?"Edit":"Set"} Selling Price &amp; Cost</button></div>
      {(cost.sellPricePerPc>0||cost.isRejected)?(<>
        <div style={{fontSize:12,color:"#666",marginBottom:10}}>{cost.isRejected?"❌ Rejected — thrown away, no revenue":fmt(cost.sellPricePerPc)+" EGP/pc × "+fmtN(cost.revenuePcs)+" pcs (batch quantity — actual produced: "+fmtN(cost.goodPcsTotal)+" pcs)"}</div>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:10}}>
          <div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Revenue</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{fmt(cost.revenueEGP)}</div></div>
          <div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Cost</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{fmt(cost.costEGP)}</div></div>
          <div style={{background:cost.profitEGP>=0?"#EAF7EC":"#FFF0F0",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Profit</div><div style={{fontSize:17,fontWeight:900,color:cost.profitEGP>=0?"#1A6B2A":"#DC3545",marginTop:2}}>{fmt(cost.profitEGP)}</div></div></div>
        <div style={{fontSize:11,color:"#999",marginBottom:6}}>{cost.estCostEGP>0?"Cost is your own estimate ("+fmt(cost.estCostEGP)+" EGP) — auto-computed materials/labor came to "+fmt(cost.netEGP)+" EGP.":"Cost is auto-computed from materials + labor above."}</div>
        {cost.marginPct!=null&&<div style={{fontSize:12,color:"#666"}}>Margin: <strong style={{color:cost.profitEGP>=0?"#1A6B2A":"#DC3545"}}>{cost.marginPct.toFixed(1)}%</strong></div>}
      </>):(<div style={{color:"#888",fontSize:12}}>No selling price set yet for this batch.</div>)}
    </ReportSection>
    {showPrice&&<SellingPriceModal batch={b} orderPrice={orderPrice} autoCostEGP={cost.netEGP} onSave={f=>{onSaveSellPrice(f);setShowPrice(false);}} onClose={()=>setShowPrice(false)}/>}
  </div>);
}
function LaborRatesModal({rates,onSave,onClose}){
  const [sorting,setSorting]=useState(String(rates.sortingCostPerPc));
  const [injection,setInjection]=useState(String(rates.injectionCostPerShift));
  const [press,setPress]=useState(String(rates.pressCostPerPc));
  const [assembly,setAssembly]=useState(String(rates.assemblyCostPerPc));
  const [assemblyDefault,setAssemblyDefault]=useState(String(rates.assemblyDefaultShiftEGP));
  const [silicaLabor,setSilicaLabor]=useState(String(rates.silicaLaborCostPerShift));
  const [fxRate,setFxRate]=useState(String(rates.usdToEgpFallbackRate));
  const save=()=>onSave({sortingCostPerPc:Number(sorting)||0,injectionCostPerShift:Number(injection)||0,pressCostPerPc:Number(press)||0,assemblyCostPerPc:Number(assembly)||0,assemblyDefaultShiftEGP:Number(assemblyDefault)||0,silicaLaborCostPerShift:Number(silicaLabor)||0,usdToEgpFallbackRate:Number(fxRate)||0});
  return(<div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.55)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
    <div style={{background:"#fff",borderRadius:16,width:"100%",maxWidth:440,overflow:"hidden"}}>
      <div style={{background:NAVY,padding:"20px 24px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
        <div><div style={{color:"#fff",fontWeight:800,fontSize:16}}>⚙️ Finance Settings</div><div style={{color:"rgba(255,255,255,0.6)",fontSize:12}}>Used to cost every batch — change any time</div></div>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"6px 12px",cursor:"pointer",fontSize:16}}>✕</button></div>
      <div style={{padding:24}}>
        <div style={{marginBottom:14}}><Field label="Plastic Sorting (EGP per pc)" value={sorting} onChange={setSorting} type="number" ph="0.015"/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>e.g. 10 girls × 300 EGP/day ÷ 200,000 pcs sorted/day</div></div>
        <div style={{marginBottom:14}}><Field label="Injection (EGP per shift)" value={injection} onChange={setInjection} type="number" ph="519.23"/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>e.g. 27,000 EGP ÷ 26 days ÷ 2 x 12h shifts/day</div></div>
        <div style={{marginBottom:14}}><Field label="Press — stamps coil into caps (EGP per pc)" value={press} onChange={setPress} type="number" ph="0.0027778"/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>e.g. 12,000 EGP salary ÷ 18 visits/month ÷ 240,000 pcs/visit</div></div>
        <div style={{marginBottom:14}}><Field label="Assembly — plastic + caps (EGP per pc)" value={assembly} onChange={setAssembly} type="number" ph="0.003125"/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>Fallback only, for shifts saved before workers were tracked. e.g. 500 EGP paid per visit ÷ 160,000 pcs/visit</div></div>
        <div style={{marginBottom:14}}><Field label="Assembly — unassigned shift (flat EGP)" value={assemblyDefault} onChange={setAssemblyDefault} type="number" ph="500"/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>Used when a shift picks no Assembly worker at all (a sorting girl covered it for free, unrecorded) — the flat cost assumed instead.</div></div>
        <div style={{marginBottom:14}}><Field label="Silica Gel Sachets Labor (EGP per shift)" value={silicaLabor} onChange={setSilicaLabor} type="number" ph="461"/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>One person tending the machine, flat rate per shift regardless of pcs made.</div></div>
        <div style={{marginBottom:18}}><Field label="USD → EGP Fallback Rate" value={fxRate} onChange={setFxRate} type="number" ph="50"/>
          <div style={{fontSize:11,color:"#999",marginTop:3}}>Used only when a coil lot doesn&apos;t have its own purchase-time rate set.</div></div>
        <button type="button" onClick={save} style={{width:"100%",padding:13,background:NAVY,color:"#fff",border:"none",borderRadius:10,fontWeight:800,fontSize:15,cursor:"pointer"}}>💾 Save Settings</button>
      </div></div></div>);
}
const isSilicaProduct=p=>p==="Silica Gel Sachets"||p==="Silica Gel Capsules";
function OrdersProfitReport({orders,onBack}){
  const [filter,setFilter]=useState("all");
  // Tracked here once an order is resolved either way: Shipped (it sold) or Rejected (thrown
  // away — the cost already happened and won't come back, but there's no sale to offset it, so
  // it counts as a pure loss). Anything still in Production/QC Hold/Released isn't final yet.
  const untrackedCount=orders.filter(o=>o.status!=="Shipped"&&o.status!=="Rejected").length;
  const trackedOrders=orders.filter(o=>o.status==="Shipped"||o.status==="Rejected");
  const matches=o=>filter==="all"?true:filter==="silica"?isSilicaProduct(o.product):!isSilicaProduct(o.product);
  const list=trackedOrders.filter(matches).map(o=>Object.assign({order:o},orderFinance(o))).sort((a,b)=>b.order.orderNo.localeCompare(a.order.orderNo));
  const priced=list.filter(x=>x.sellPricePerPc>0||x.totalCostEGP>0);
  const totalRevenue=list.reduce((s,x)=>s+x.revenueEGP,0);
  const totalCost=list.reduce((s,x)=>s+x.totalCostEGP,0);
  const totalProfit=totalRevenue-totalCost;
  const totalMargin=totalRevenue>0?totalProfit/totalRevenue*100:null;
  const maxAbsProfit=Math.max(1,...priced.map(x=>Math.abs(x.profitEGP)));
  return(<div style={{maxWidth:760,margin:"0 auto",background:"#fff",borderRadius:12,padding:24,fontFamily:"'Inter',sans-serif"}}>
    <ReportPrintBar onBack={onBack} backLabel="Back to Finance"/>
    <ReportTitle title="Orders Profit Overview" subtitle="Revenue, cost, and profit across every order"/>
    <div className="eps-no-print" style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
      {[["all","All"],["fo","Flip-Off Caps"],["silica","Silica Gel"]].map(([k,label])=>(
        <button key={k} type="button" onClick={()=>setFilter(k)} style={{padding:"6px 14px",borderRadius:20,border:"1.5px solid "+(filter===k?NAVY:"#E2E8F0"),background:filter===k?NAVY:"#fff",color:filter===k?"#fff":"#555",fontSize:12,fontWeight:700,cursor:"pointer"}}>{label}</button>))}
    </div>
    {untrackedCount>0&&<div style={{fontSize:11,color:"#8A6D00",marginBottom:14}}>📦 {untrackedCount} order{untrackedCount===1?"":"s"} not yet Shipped or Rejected excluded from this report.</div>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:22}}>
      <div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Revenue</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{fmt(totalRevenue)}</div></div>
      <div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Cost</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{fmt(totalCost)}</div></div>
      <div style={{background:totalProfit>=0?"#EAF7EC":"#FFF0F0",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Profit</div><div style={{fontSize:17,fontWeight:900,color:totalProfit>=0?"#1A6B2A":"#DC3545",marginTop:2}}>{fmt(totalProfit)}</div></div>
      {totalMargin!=null&&<div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Margin</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{totalMargin.toFixed(1)}%</div></div>}
    </div>
    {priced.length===0?(<div style={{textAlign:"center",padding:30,color:"#888",fontSize:13}}>No orders with a sale price or cost entered yet.</div>):(<>
      <div style={{fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",marginBottom:10}}>Profit by Order</div>
      <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:24}}>
        {priced.map(x=>(<div key={x.order.id}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#666",marginBottom:3}}>
            <span style={{fontFamily:"monospace"}}>{x.order.orderNo} · {x.order.client}{x.isRejected?" · ❌ Rejected (full loss)":""}</span>
            <span style={{fontWeight:700,color:x.profitEGP>=0?"#1A6B2A":"#DC3545"}}>{fmt(x.profitEGP)} EGP</span></div>
          <div style={{height:8,background:"#F0F0F0",borderRadius:4,overflow:"hidden"}}>
            <div style={{height:"100%",width:Math.max(2,Math.abs(x.profitEGP)/maxAbsProfit*100)+"%",background:x.profitEGP>=0?"#22A03A":"#DC3545",borderRadius:4}}/></div>
        </div>))}
      </div>
    </>)}
    <div style={{fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",marginBottom:10}}>All Orders</div>
    {list.length===0?(<div style={{textAlign:"center",padding:30,color:"#888",fontSize:13}}>No orders in this filter.</div>):(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{textAlign:"left",color:"#999",fontSize:10,textTransform:"uppercase"}}>
          <th style={{padding:"6px 8px"}}>Order</th><th style={{padding:"6px 8px"}}>Client</th><th style={{padding:"6px 8px"}}>Revenue</th><th style={{padding:"6px 8px"}}>Cost</th><th style={{padding:"6px 8px"}}>Profit</th></tr></thead>
        <tbody>{list.map(x=>(<tr key={x.order.id} style={{borderTop:"1px solid #F0F0F0"}}>
          <td style={{padding:"6px 8px",fontFamily:"monospace"}}>{x.order.orderNo}{x.isRejected?" ❌":""}</td>
          <td style={{padding:"6px 8px"}}>{x.order.client||"—"}</td>
          <td style={{padding:"6px 8px"}}>{x.revenueEGP>0?fmt(x.revenueEGP):"—"}</td>
          <td style={{padding:"6px 8px"}}>{x.totalCostEGP>0?fmt(x.totalCostEGP):"—"}</td>
          <td style={{padding:"6px 8px",fontWeight:700,color:x.profitEGP>=0?"#1A6B2A":"#DC3545"}}>{(x.sellPricePerPc>0||x.totalCostEGP>0)?fmt(x.profitEGP):"—"}</td></tr>))}</tbody>
      </table>
    </div>)}
  </div>);
}
function BatchesProfitReport({batches,data,laborRates,onBack}){
  const [filter,setFilter]=useState("all");
  const sampleCount=batches.filter(b=>!b.isSubBatch&&b.isSample).length;
  // Tracked here once a batch is resolved either way: Shipped (it sold) or Rejected (thrown
  // away — the cost already happened and won't come back, but there's no sale to offset it, so
  // it counts as a pure loss). Anything still in Production/QC Hold/Released isn't final yet.
  const notShippedCount=batches.filter(b=>!b.isSubBatch&&!b.isSample&&b.status!=="Shipped"&&b.status!=="Rejected").length;
  const mainBatches=batches.filter(b=>!b.isSubBatch&&!b.isSample&&(b.status==="Shipped"||b.status==="Rejected"));
  const matches=b=>filter==="all"?true:filter==="silica"?isSilicaProduct(b.product):!isSilicaProduct(b.product);
  const list=mainBatches.filter(matches).map(b=>buildBatchCost(b,batches,data,laborRates)).sort((a,b)=>b.batch.batchNo.localeCompare(a.batch.batchNo));
  // Only batches with an actual selling price (or a Rejected batch, which counts on cost alone)
  // count toward profit totals — a batch's material + labor cost is always auto-computed even
  // before it's priced, so including unpriced-and-not-rejected batches here would subtract
  // in-progress production costs from profit before any sale (or write-off) exists for them.
  const priced=list.filter(x=>x.sellPricePerPc>0||x.isRejected);
  const totalRevenue=priced.reduce((s,x)=>s+x.revenueEGP,0);
  const totalCost=priced.reduce((s,x)=>s+x.costEGP,0);
  const totalProfit=totalRevenue-totalCost;
  const totalMargin=totalRevenue>0?totalProfit/totalRevenue*100:null;
  const maxAbsProfit=Math.max(1,...priced.map(x=>Math.abs(x.profitEGP)));
  return(<div style={{maxWidth:760,margin:"0 auto",background:"#fff",borderRadius:12,padding:24,fontFamily:"'Inter',sans-serif"}}>
    <ReportPrintBar onBack={onBack} backLabel="Back to Finance"/>
    <ReportTitle title="Batches Profit Overview" subtitle="Revenue, cost, and profit across every batch"/>
    <div className="eps-no-print" style={{display:"flex",gap:8,marginBottom:10,flexWrap:"wrap"}}>
      {[["all","All"],["fo","Flip-Off Caps"],["silica","Silica Gel"]].map(([k,label])=>(
        <button key={k} type="button" onClick={()=>setFilter(k)} style={{padding:"6px 14px",borderRadius:20,border:"1.5px solid "+(filter===k?NAVY:"#E2E8F0"),background:filter===k?NAVY:"#fff",color:filter===k?"#fff":"#555",fontSize:12,fontWeight:700,cursor:"pointer"}}>{label}</button>))}
    </div>
    {sampleCount>0&&<div style={{fontSize:11,color:"#8A6D00",marginBottom:6}}>🎁 {sampleCount} sample batch{sampleCount===1?"":"es"} excluded from this report.</div>}
    {notShippedCount>0&&<div style={{fontSize:11,color:"#8A6D00",marginBottom:14}}>📦 {notShippedCount} batch{notShippedCount===1?"":"es"} not yet Shipped or Rejected excluded from this report.</div>}
    <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(130px,1fr))",gap:10,marginBottom:22}}>
      <div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Revenue</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{fmt(totalRevenue)}</div></div>
      <div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Cost</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{fmt(totalCost)}</div></div>
      <div style={{background:totalProfit>=0?"#EAF7EC":"#FFF0F0",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Profit</div><div style={{fontSize:17,fontWeight:900,color:totalProfit>=0?"#1A6B2A":"#DC3545",marginTop:2}}>{fmt(totalProfit)}</div></div>
      {totalMargin!=null&&<div style={{background:"#F7F9FC",borderRadius:8,padding:"10px 12px"}}><div style={{fontSize:10,color:"#999",fontWeight:700,textTransform:"uppercase"}}>Margin</div><div style={{fontSize:17,fontWeight:900,color:NAVY,marginTop:2}}>{totalMargin.toFixed(1)}%</div></div>}
    </div>
    {priced.length===0?(<div style={{textAlign:"center",padding:30,color:"#888",fontSize:13}}>No batches with a selling price set (or Rejected) yet.</div>):(<>
      <div style={{fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",marginBottom:10}}>Profit by Batch</div>
      <div style={{display:"flex",flexDirection:"column",gap:9,marginBottom:24}}>
        {priced.map(x=>(<div key={x.batch.id}>
          <div style={{display:"flex",justifyContent:"space-between",fontSize:11,color:"#666",marginBottom:3}}>
            <span style={{fontFamily:"monospace"}}>{x.batch.batchNo}{x.batch.client?" · "+x.batch.client:""}{x.isRejected?" · ❌ Rejected (full loss)":""}</span>
            <span style={{fontWeight:700,color:x.profitEGP>=0?"#1A6B2A":"#DC3545"}}>{fmt(x.profitEGP)} EGP</span></div>
          <div style={{height:8,background:"#F0F0F0",borderRadius:4,overflow:"hidden"}}>
            <div style={{height:"100%",width:Math.max(2,Math.abs(x.profitEGP)/maxAbsProfit*100)+"%",background:x.profitEGP>=0?"#22A03A":"#DC3545",borderRadius:4}}/></div>
        </div>))}
      </div>
    </>)}
    <div style={{fontSize:11,fontWeight:700,color:"#999",textTransform:"uppercase",marginBottom:10}}>All Batches</div>
    {list.length===0?(<div style={{textAlign:"center",padding:30,color:"#888",fontSize:13}}>No batches in this filter.</div>):(
    <div style={{overflowX:"auto"}}>
      <table style={{width:"100%",borderCollapse:"collapse",fontSize:12}}>
        <thead><tr style={{textAlign:"left",color:"#999",fontSize:10,textTransform:"uppercase"}}>
          <th style={{padding:"6px 8px"}}>Batch</th><th style={{padding:"6px 8px"}}>Client</th><th style={{padding:"6px 8px"}}>Revenue</th><th style={{padding:"6px 8px"}}>Cost</th><th style={{padding:"6px 8px"}}>Profit</th></tr></thead>
        <tbody>{list.map(x=>(<tr key={x.batch.id} style={{borderTop:"1px solid #F0F0F0"}}>
          <td style={{padding:"6px 8px",fontFamily:"monospace"}}>{x.batch.batchNo}{x.isRejected?" ❌":""}</td>
          <td style={{padding:"6px 8px"}}>{x.batch.client||"—"}</td>
          <td style={{padding:"6px 8px"}}>{x.revenueEGP>0?fmt(x.revenueEGP):"—"}</td>
          <td style={{padding:"6px 8px"}}>{x.costEGP>0?fmt(x.costEGP):"—"}</td>
          <td style={{padding:"6px 8px",fontWeight:700,color:x.profitEGP>=0?"#1A6B2A":"#DC3545"}}>{(x.sellPricePerPc>0||x.isRejected)?fmt(x.profitEGP):"—"}</td></tr>))}</tbody>
      </table>
    </div>)}
  </div>);
}
function FinanceSection({data,batches,orders,laborRates,onSaveLaborRates,onUpdateBatch,onClose}){
  const [doc,setDoc]=useState(null);
  const [showOrdersReport,setShowOrdersReport]=useState(false);
  const [showBatchesReport,setShowBatchesReport]=useState(false);
  const [pickBatchNo,setPickBatchNo]=useState("");
  const [showRates,setShowRates]=useState(false);
  const mainBatches=batches.filter(b=>!b.isSubBatch).sort((a,b)=>b.batchNo.localeCompare(a.batchNo));
  if(doc)return(<div className="eps-print-page" style={{minHeight:"100vh",background:"#F7F9FC",padding:"20px 16px"}}>
    <BatchCostDoc cost={doc} orders={orders} onBack={()=>setDoc(null)}
      onSaveSellPrice={f=>{
        const updated=Object.assign({},doc.batch,{sellPricePerPc:f.sellPricePerPc,estCostEGP:f.estCostEGP});
        onUpdateBatch(updated);
        setDoc(buildBatchCost(updated,batches,data,laborRates));
      }}/></div>);
  if(showOrdersReport)return(<div className="eps-print-page" style={{minHeight:"100vh",background:"#F7F9FC",padding:"20px 16px"}}>
    <OrdersProfitReport orders={orders} onBack={()=>setShowOrdersReport(false)}/></div>);
  if(showBatchesReport)return(<div className="eps-print-page" style={{minHeight:"100vh",background:"#F7F9FC",padding:"20px 16px"}}>
    <BatchesProfitReport batches={batches} data={data} laborRates={laborRates} onBack={()=>setShowBatchesReport(false)}/></div>);
  return(<div style={{minHeight:"100vh",background:"#F7F9FC",fontFamily:"'Inter',sans-serif"}}>
    <div style={{background:"linear-gradient(135deg,#0D1F3C,"+NAVY+")",position:"sticky",top:0,zIndex:100}}>
      <div style={{maxWidth:700,margin:"0 auto",padding:"14px 16px",display:"flex",alignItems:"center",gap:12}}>
        <button type="button" onClick={onClose} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13}}>← Back</button>
        <div style={{flex:1}}><div style={{color:"#fff",fontWeight:800,fontSize:17}}>💰 Finance</div>
          <div style={{color:"rgba(255,255,255,0.5)",fontSize:11}}>Material + labor cost per batch — testing phase</div></div>
        <button type="button" onClick={()=>setShowRates(true)} style={{background:"rgba(255,255,255,0.15)",border:"none",color:"#fff",borderRadius:8,padding:"7px 13px",cursor:"pointer",fontWeight:700,fontSize:13,whiteSpace:"nowrap"}}>⚙️ Settings</button></div></div>
    <div style={{maxWidth:700,margin:"0 auto",padding:16,display:"flex",flexDirection:"column",gap:16}}>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>🏭 Batch Cost</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Plastic + aluminum + labor cost for one batch, net of an estimated scrap credit.</div>
        <div style={{display:"flex",gap:8}}>
          <select value={pickBatchNo} onChange={e=>setPickBatchNo(e.target.value)} style={{flex:1,border:"1.5px solid #E2E8F0",borderRadius:8,padding:"9px 12px",fontSize:13,background:"#fff"}}>
            <option value="">— select batch —</option>
            {mainBatches.map(b=><option key={b.id} value={b.batchNo}>{b.batchNo} · {b.color}{b.client?" · "+b.client:""}{b.isSample?" · 🎁 Sample":""}</option>)}</select>
          <button type="button" disabled={!pickBatchNo} onClick={()=>{const b=mainBatches.filter(x=>x.batchNo===pickBatchNo)[0];if(b)setDoc(buildBatchCost(b,batches,data,laborRates));}}
            style={{background:pickBatchNo?NAVY:"#E2E8F0",color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontWeight:700,fontSize:13,cursor:pickBatchNo?"pointer":"default",whiteSpace:"nowrap"}}>Generate</button></div>
      {showRates&&<LaborRatesModal rates={laborRates} onClose={()=>setShowRates(false)} onSave={r=>{onSaveLaborRates(r);setShowRates(false);}}/>}
      </div>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>📈 Batches Profit Overview</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Revenue, cost, and profit across every batch — see it all, or split Flip-Off from Silica Gel.</div>
        <button type="button" onClick={()=>setShowBatchesReport(true)} style={{background:NAVY,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontWeight:700,fontSize:13,cursor:"pointer"}}>View Report</button>
      </div>
      <div style={{background:"#fff",borderRadius:12,border:"1.5px solid #EEF2F7",padding:16}}>
        <div style={{fontWeight:800,fontSize:14,color:NAVY,marginBottom:2}}>📊 Orders Profit Overview</div>
        <div style={{fontSize:12,color:"#888",marginBottom:12}}>Revenue, cost, and profit across every order — see it all, or split Flip-Off from Silica Gel.</div>
        <button type="button" onClick={()=>setShowOrdersReport(true)} style={{background:NAVY,color:"#fff",border:"none",borderRadius:8,padding:"9px 18px",fontWeight:700,fontSize:13,cursor:"pointer"}}>View Report</button>
      </div>
    </div></div>);
}

// ══ ROOT ══════════════════════════════════════════════════════════════════
export default function EpsInventoryApp(){
  const router=useRouter();
  const [data,setData]=useState(null);
  const [batches,setBatches]=useState([]),[orders,setOrders]=useState([]);
  const [laborRates,setLaborRates]=useState(DEFAULT_LABOR_RATES);
  const [employees,setEmployees]=useState(INITIAL_EMPLOYEES);
  const [cashLedger,setCashLedger]=useState([]);
  const [cashOpening,setCashOpening]=useState(null);
  const [silicaCommissionEntries,setSilicaCommissionEntries]=useState(INITIAL_SILICA_COMMISSION_ENTRIES);
  const [silicaCommissionSettings,setSilicaCommissionSettings]=useState(DEFAULT_COMMISSION_SETTINGS);
  const [silicaOwnerWithdrawals,setSilicaOwnerWithdrawals]=useState([]);
  const [flipOffCommissionSettings,setFlipOffCommissionSettings]=useState(DEFAULT_COMMISSION_SETTINGS);
  const [flipOffOwnerWithdrawals,setFlipOffOwnerWithdrawals]=useState([]);
  const [activeMat,setActiveMat]=useState(null),[section,setSection]=useState("inventory");
  const [toast,setToast]=useState(null),[lastSync,setLastSync]=useState(null);
  const [dataLoaded,setDataLoaded]=useState(false);
  const skipSave=useRef(null);
  const showToast=(msg,type)=>{setToast({msg:msg,type:type||"ok"});setTimeout(()=>setToast(null),2500);};

  useEffect(()=>{(async()=>{
    let merged={},bs=INITIAL_BATCHES,os=INITIAL_ORDERS,lr=DEFAULT_LABOR_RATES,emps=INITIAL_EMPLOYEES,cl=[],co=null;
    let sce=INITIAL_SILICA_COMMISSION_ENTRIES,scs=DEFAULT_COMMISSION_SETTINGS,sow=[],fcs=DEFAULT_COMMISSION_SETTINGS,fow=[];
    try{
      const supabase=createClient();
      const {data:row,error}=await supabase.from("eps_inventory_data").select("value").eq("key",SHARED_KEY).maybeSingle();
      if(error)throw error;
      if(row&&row.value){
        const p=row.value;
        Object.keys(MATERIAL_META).forEach(k=>{
          const sm=p[k];let lots,coils;
          if(Array.isArray(sm)){lots=sm;coils=INITIAL_COILS[k]||[];}
          else if(sm&&typeof sm==="object"){lots=sm.lots||INITIAL_LOTS[k];coils=sm.coils||INITIAL_COILS[k]||[];}
          else{lots=INITIAL_LOTS[k];coils=INITIAL_COILS[k]||[];}
          const ids={};lots.forEach(l=>{ids[l.id]=1;});
          INITIAL_LOTS[k].forEach(l=>{if(!ids[l.id])lots=lots.concat([l]);});
          if(k==="Aluminum Caps")lots=lots.map(l=>{
            if(!l.bags||!l.bags.length){const init=INITIAL_LOTS[k].filter(x=>x.id===l.id)[0];if(init&&init.bags)return Object.assign({},l,{bags:init.bags});}
            if(l.bags&&l.bags.length){const un=l.bags.filter(b=>!b.used).length;
              return Object.assign({},l,{qtyRemaining:un,status:un===0?"Out of Stock":l.status==="Quarantined"?"Quarantined":un<=l.bags.length*0.15?"Low Stock":"In Stock"});}
            return l;});
          merged[k]=Object.assign({},MATERIAL_META[k],{lots:lots,coils:coils});
        });
        // Once real data has ever been saved, it is the source of truth — do NOT re-merge the
        // original starter batches/orders back in, or a deleted seed record would reappear on
        // every reload (this used to concat back any INITIAL_BATCHES/INITIAL_ORDERS not present
        // in the saved arrays, which silently undid every delete of a starter record).
        bs=p._batches||[];
        os=p._orders||[];
        // Merge any newly-added starter employees (e.g. a fresh seed roster entry) into what's
        // already saved by id, same principle as the material-lot merge above — but never drop
        // a saved employee, since that would silently undo a real edit (e.g. deactivating
        // someone) on every reload.
        if(Array.isArray(p._employees)){
          const ids={};p._employees.forEach(x=>{ids[x.id]=1;});
          emps=p._employees.concat(INITIAL_EMPLOYEES.filter(x=>!ids[x.id]));
        }
        // Cash Ledger — a fully separate real-money tracker from the estimate-based Finance tab
        // and from everything above, so it's loaded/saved independently with no merge-by-id
        // logic needed (there's no starter seed data for it, just whatever the user has logged).
        if(Array.isArray(p._cashLedger))cl=p._cashLedger;
        if(p._cashOpening)co=p._cashOpening;
        // Sales Commission Tracker — the Silica entries seed once from the real spreadsheet
        // history and are never re-merged after that (unlike the employee roster, there's no
        // ongoing "starter list" concept here, just whatever's actually been sold), Flip-Off
        // rows come from the orders array itself so nothing extra to load for those.
        if(Array.isArray(p._silicaCommissionEntries))sce=p._silicaCommissionEntries;
        if(p._silicaCommissionSettings)scs=Object.assign({},DEFAULT_COMMISSION_SETTINGS,p._silicaCommissionSettings);
        if(Array.isArray(p._silicaOwnerWithdrawals))sow=p._silicaOwnerWithdrawals;
        if(p._flipOffCommissionSettings)fcs=Object.assign({},DEFAULT_COMMISSION_SETTINGS,p._flipOffCommissionSettings);
        if(Array.isArray(p._flipOffOwnerWithdrawals))fow=p._flipOffOwnerWithdrawals;
        // pressCostPerPc used to mean the combined "Press/Assembly" rate before they were split
        // into two real machines — a saved rate under that old key is really the Assembly rate,
        // so carry it forward under the new assemblyCostPerPc key instead of misapplying it to
        // the (differently-priced) Press machine, and let Press pick up its own fresh default.
        let savedLr=p._laborRates;
        if(savedLr&&savedLr.pressCostPerPc!=null&&savedLr.assemblyCostPerPc==null){
          savedLr=Object.assign({},savedLr,{assemblyCostPerPc:savedLr.pressCostPerPc,pressCostPerPc:DEFAULT_LABOR_RATES.pressCostPerPc});
        }
        lr=savedLr?Object.assign({},DEFAULT_LABOR_RATES,savedLr):DEFAULT_LABOR_RATES;
        setLastSync(today());
      } else {
        Object.keys(MATERIAL_META).forEach(k=>{merged[k]=Object.assign({},MATERIAL_META[k],{lots:INITIAL_LOTS[k],coils:INITIAL_COILS[k]||[]});});
      }
    }catch(e){console.error("Load failed",e);showToast("⚠️ Couldn't load saved data — showing starter data","error");
      Object.keys(MATERIAL_META).forEach(k=>{merged[k]=Object.assign({},MATERIAL_META[k],{lots:INITIAL_LOTS[k],coils:INITIAL_COILS[k]||[]});});}
    setData(merged);setBatches(bs);setOrders(os);setLaborRates(lr);setEmployees(emps);setCashLedger(cl);setCashOpening(co);
    setSilicaCommissionEntries(sce);setSilicaCommissionSettings(scs);setSilicaOwnerWithdrawals(sow);
    setFlipOffCommissionSettings(fcs);setFlipOffOwnerWithdrawals(fow);
    // Snapshot what we just loaded so the effect doesn't immediately re-write identical data
    const snap={};Object.keys(merged).forEach(k=>{snap[k]={lots:merged[k].lots.map(l=>Object.assign({},l,{image:null})),coils:merged[k].coils||[]};});
    snap._batches=bs;snap._orders=os;snap._laborRates=lr;snap._employees=emps;snap._cashLedger=cl;snap._cashOpening=co;
    snap._silicaCommissionEntries=sce;snap._silicaCommissionSettings=scs;snap._silicaOwnerWithdrawals=sow;
    snap._flipOffCommissionSettings=fcs;snap._flipOffOwnerWithdrawals=fow;
    skipSave.current=JSON.stringify(snap);
    setDataLoaded(true);
  })();},[]);

  useEffect(()=>{
    if(!data||!dataLoaded)return;
    const toSave={};Object.keys(data).forEach(k=>{toSave[k]={lots:data[k].lots.map(l=>Object.assign({},l,{image:null})),coils:data[k].coils||[]};});
    toSave._batches=batches;toSave._orders=orders;toSave._laborRates=laborRates;toSave._employees=employees;
    toSave._cashLedger=cashLedger;toSave._cashOpening=cashOpening;
    toSave._silicaCommissionEntries=silicaCommissionEntries;toSave._silicaCommissionSettings=silicaCommissionSettings;toSave._silicaOwnerWithdrawals=silicaOwnerWithdrawals;
    toSave._flipOffCommissionSettings=flipOffCommissionSettings;toSave._flipOffOwnerWithdrawals=flipOffOwnerWithdrawals;
    const json=JSON.stringify(toSave);
    // Only skip when the payload is byte-identical to what we loaded — never skip a real change
    if(skipSave.current===json){return;}
    skipSave.current=json;
    (async()=>{try{
      if(json.length>8000000){showToast("⚠️ Data too large","error");return;}
      const supabase=createClient();
      let lastErr=null;
      for(let a=1;a<=2;a++){try{
        const {error}=await supabase.from("eps_inventory_data").upsert({key:SHARED_KEY,value:toSave,updated_at:new Date().toISOString()});
        if(error)throw error;
        setLastSync(today());return;
      }catch(e){lastErr=e;if(a<2)await new Promise(r=>setTimeout(r,800));}}
      throw lastErr;
    }catch(e){console.error("Save failed",e);showToast("⚠️ Save failed — check your connection","error");}})();
  },[data,batches,orders,laborRates,employees,cashLedger,cashOpening,
    silicaCommissionEntries,silicaCommissionSettings,silicaOwnerWithdrawals,flipOffCommissionSettings,flipOffOwnerWithdrawals,dataLoaded]);

  const logout=async()=>{const supabase=createClient();await supabase.auth.signOut();router.push("/auth/login");router.refresh();};

  const exportBackup=()=>{
    const payload={exportedAt:new Date().toISOString(),data:data,batches:batches,orders:orders,laborRates:laborRates,employees:employees,cashLedger:cashLedger,cashOpening:cashOpening,
      silicaCommissionEntries:silicaCommissionEntries,silicaCommissionSettings:silicaCommissionSettings,silicaOwnerWithdrawals:silicaOwnerWithdrawals,
      flipOffCommissionSettings:flipOffCommissionSettings,flipOffOwnerWithdrawals:flipOffOwnerWithdrawals};
    const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
    const url=URL.createObjectURL(blob);
    const a=document.createElement("a");
    a.href=url;a.download="eps-inventory-backup-"+new Date().toISOString().slice(0,10)+".json";
    document.body.appendChild(a);a.click();document.body.removeChild(a);
    URL.revokeObjectURL(url);
    showToast("Backup downloaded ✓");
  };
  const importBackup=file=>{
    const r=new FileReader();
    r.onload=ev=>{
      try{
        const p=JSON.parse(ev.target.result);
        if(!p||typeof p!=="object"||!p.data||!Array.isArray(p.batches)||!Array.isArray(p.orders))throw new Error("bad shape");
        setData(p.data);setBatches(p.batches);setOrders(p.orders);
        if(p.laborRates){
          let lr2=p.laborRates;
          if(lr2.pressCostPerPc!=null&&lr2.assemblyCostPerPc==null){
            lr2=Object.assign({},lr2,{assemblyCostPerPc:lr2.pressCostPerPc,pressCostPerPc:DEFAULT_LABOR_RATES.pressCostPerPc});
          }
          setLaborRates(Object.assign({},DEFAULT_LABOR_RATES,lr2));
        }
        if(Array.isArray(p.employees))setEmployees(p.employees);
        if(Array.isArray(p.cashLedger))setCashLedger(p.cashLedger);
        if(p.cashOpening)setCashOpening(p.cashOpening);
        if(Array.isArray(p.silicaCommissionEntries))setSilicaCommissionEntries(p.silicaCommissionEntries);
        if(p.silicaCommissionSettings)setSilicaCommissionSettings(Object.assign({},DEFAULT_COMMISSION_SETTINGS,p.silicaCommissionSettings));
        if(Array.isArray(p.silicaOwnerWithdrawals))setSilicaOwnerWithdrawals(p.silicaOwnerWithdrawals);
        if(p.flipOffCommissionSettings)setFlipOffCommissionSettings(Object.assign({},DEFAULT_COMMISSION_SETTINGS,p.flipOffCommissionSettings));
        if(Array.isArray(p.flipOffOwnerWithdrawals))setFlipOffOwnerWithdrawals(p.flipOffOwnerWithdrawals);
        showToast("Backup restored ✓ — review, then it will auto-save");
      }catch(e){console.error("Import failed",e);showToast("⚠️ That file doesn't look like a valid backup","error");}
    };
    r.readAsText(file);
  };

  const saveEmployee=emp=>{setEmployees(es=>es.some(x=>x.id===emp.id)?es.map(x=>x.id===emp.id?emp:x):es.concat([emp]));showToast("Saved ✓");};
  const deleteEmployee=id=>{setEmployees(es=>es.filter(x=>x.id!==id));showToast("Deleted","error");};
  const saveCashEntry=entry=>{setCashLedger(es=>es.some(x=>x.id===entry.id)?es.map(x=>x.id===entry.id?entry:x):es.concat([entry]));showToast("Saved ✓");};
  const deleteCashEntry=id=>{setCashLedger(es=>es.filter(x=>x.id!==id));showToast("Deleted","error");};
  const setCashOpeningBalance=o=>{setCashOpening(o);showToast("Saved ✓");};
  const saveSilicaCommissionEntry=entry=>{setSilicaCommissionEntries(es=>es.some(x=>x.id===entry.id)?es.map(x=>x.id===entry.id?entry:x):es.concat([entry]));showToast("Saved ✓");};
  const deleteSilicaCommissionEntry=id=>{setSilicaCommissionEntries(es=>es.filter(x=>x.id!==id));showToast("Deleted","error");};
  const saveSilicaCommissionSettings=s=>{setSilicaCommissionSettings(s);showToast("Saved ✓");};
  const addSilicaOwnerWithdrawal=w=>{setSilicaOwnerWithdrawals(ws=>ws.concat([w]));showToast("Saved ✓");};
  const deleteSilicaOwnerWithdrawal=id=>{setSilicaOwnerWithdrawals(ws=>ws.filter(x=>x.id!==id));showToast("Deleted","error");};
  const saveFlipOffCommissionSettings=s=>{setFlipOffCommissionSettings(s);showToast("Saved ✓");};
  const addFlipOffOwnerWithdrawal=w=>{setFlipOffOwnerWithdrawals(ws=>ws.concat([w]));showToast("Saved ✓");};
  const deleteFlipOffOwnerWithdrawal=id=>{setFlipOffOwnerWithdrawals(ws=>ws.filter(x=>x.id!==id));showToast("Deleted","error");};
  const updateLot=(mat,u)=>{setData(d=>Object.assign({},d,{[mat]:Object.assign({},d[mat],{lots:d[mat].lots.map(l=>l.id===u.id?u:l)})}));showToast("Saved ✓");};
  const deleteLot=(mat,id)=>{setData(d=>Object.assign({},d,{[mat]:Object.assign({},d[mat],{lots:d[mat].lots.filter(l=>l.id!==id)})}));showToast("Deleted","error");};
  const addLot=(mat,lot)=>{setData(d=>Object.assign({},d,{[mat]:Object.assign({},d[mat],{lots:d[mat].lots.concat([lot])})}));showToast("Added ✓");};
  // Creates a new Aluminum Caps lot, deducts the coil weight it consumed from the matching
  // Aluminum Coils lot, and credits the scrap byproduct into a running Aluminum Scrap pool —
  // all three materials move together in one update.
  const createAlBatch=(newLot,consumption)=>{
    setData(d=>{
      const caps=Object.assign({},d["Aluminum Caps"],{lots:d["Aluminum Caps"].lots.concat([newLot])});
      const coilLots=d["Aluminum Coils"].lots.map(l=>{
        if(l.id!==consumption.coilLotId)return l;
        const rem=Math.max(0,(Number(l.qtyRemaining)||0)-consumption.weightTaken);
        const rec=Number(l.qtyReceived)||rem;
        const ns=rem<=0?"Out of Stock":rem<=rec*0.15?"Low Stock":l.status;
        return Object.assign({},l,{qtyRemaining:rem,status:ns,usageLog:(l.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:consumption.weightTaken,reason:"Stamped into "+newLot.lotNumber+(consumption.coilNumber?" (Coil "+consumption.coilNumber+")":""),remainingAfter:rem}])});
      });
      const scrapKg=Number(consumption.scrapKg)||0;
      const scrapLots=creditScrap(d["Aluminum Scrap"].lots,scrapKg,"From "+newLot.lotNumber+" ("+fmt(consumption.weightTaken)+" KG coil used)");
      return Object.assign({},d,{"Aluminum Caps":caps,"Aluminum Coils":Object.assign({},d["Aluminum Coils"],{lots:coilLots}),"Aluminum Scrap":Object.assign({},d["Aluminum Scrap"],{lots:scrapLots})});
    });
    showToast(newLot.lotNumber+" created ✓ · "+fmt(consumption.weightTaken)+" KG deducted from coil"+(consumption.scrapKg>0?" · "+fmt(consumption.scrapKg)+" KG scrap":""));
  };
  // Deducting an Aluminum Coils lot directly via "Use Stock" (instead of through New Aluminum
  // Batch) still consumes coil weight, so it must still credit the same 27.4% scrap byproduct —
  // otherwise scrap made this way goes untracked.
  const useCoilStock=(oldLot,newLot)=>{
    const usedKg=Math.max(0,(Number(oldLot.qtyRemaining)||0)-(Number(newLot.qtyRemaining)||0));
    const scrapKg=usedKg*0.274;
    setData(d=>{
      const coilLots=d["Aluminum Coils"].lots.map(l=>l.id===newLot.id?newLot:l);
      const scrapLots=creditScrap(d["Aluminum Scrap"].lots,scrapKg,"From coil "+newLot.lotNumber+" ("+fmt(usedKg)+" KG used — Use Stock)");
      return Object.assign({},d,{"Aluminum Coils":Object.assign({},d["Aluminum Coils"],{lots:coilLots}),"Aluminum Scrap":Object.assign({},d["Aluminum Scrap"],{lots:scrapLots})});
    });
    showToast("Saved ✓"+(scrapKg>0?" · "+fmt(scrapKg)+" KG scrap credited":""));
  };
  const toggleBag=(mat,lotId,bagId)=>{setData(d=>{
    const lots=d[mat].lots.map(lot=>{if(lot.id!==lotId||!lot.bags)return lot;
      const nb=lot.bags.map(b=>b.id===bagId?Object.assign({},b,{used:!b.used,usedDate:!b.used?today():null}):b);
      const un=nb.filter(b=>!b.used).length;
      return Object.assign({},lot,{bags:nb,qtyRemaining:un,status:un===0?"Out of Stock":un<=nb.length*0.15?"Low Stock":"In Stock"});});
    return Object.assign({},d,{[mat]:Object.assign({},d[mat],{lots:lots})});});showToast("Bag updated ✓");};
  const startCoil=(mat,p)=>{setData(d=>{const n=(d[mat].coils||[]).length;
    return Object.assign({},d,{[mat]:Object.assign({},d[mat],{coils:(d[mat].coils||[]).concat([{id:genId(),boxLotId:p.boxLotId,label:"Coil #"+(n+1),coreDiameter:p.coreDiameter,width:p.width,status:"active",weighIns:[{id:genId(),date:today(),weight:p.weight,outerDiameter:p.outerDiameter,delta:null,note:p.note||"Baseline"}]}])})});});showToast("Coil started ✓");};
  const measureCoil=(mat,p)=>{setData(d=>Object.assign({},d,{[mat]:Object.assign({},d[mat],{coils:(d[mat].coils||[]).map(c=>{if(c.status!=="active")return c;
    const l=c.weighIns[c.weighIns.length-1];
    return Object.assign({},c,{weighIns:c.weighIns.concat([{id:genId(),date:today(),weight:p.newWeight,outerDiameter:p.outerDiameter,delta:l.weight-p.newWeight,note:p.note||"Job"}])});})})}));showToast("Reading saved ✓");};
  const finishCoil=mat=>{setData(d=>Object.assign({},d,{[mat]:Object.assign({},d[mat],{coils:(d[mat].coils||[]).map(c=>c.status==="active"?Object.assign({},c,{status:"finished"}):c)})}));showToast("Coil finished");};
  const createBatch=b=>{setBatches(p=>[b].concat(p));showToast(b.batchNo+" created ✓");};
  const updateBatch=u=>{setBatches(p=>p.map(b=>b.id===u.id?u:b));showToast("Updated ✓");};
  // One-time backfill: batches with no price/cost on record (their own or their linked
  // order's) are free samples that just never had money entered — label them as such.
  const markUnpricedAsSamples=()=>{
    const eligible=batches.filter(b=>{
      if(b.isSubBatch||b.isSample)return false;
      if(b.sellPricePerPc||b.estCostEGP)return false;
      const ord=orders.filter(o=>b.orderNo&&o.orderNo===b.orderNo)[0];
      if(ord&&(ord.sellPricePerPc||ord.estCostEGP))return false;
      return true;
    });
    if(!eligible.length){showToast("No un-priced batches found","error");return;}
    const ids=new Set(eligible.map(b=>b.id));
    setBatches(p=>p.map(b=>ids.has(b.id)?Object.assign({},b,{isSample:true}):b));
    showToast(eligible.length+" batches marked as samples ✓");
  };
  const deleteBatch=id=>{setBatches(p=>p.filter(b=>b.id!==id));showToast("Deleted","error");};
  // Deletes a shift/carryover, first returning whatever material it actually drew (plastic
  // bags, aluminum caps bags, WIP Inventory stock) — a carryover from another batch (rather
  // than from WIP stock) never drew fresh material, so those fields are simply absent and
  // nothing is reversed for it.
  const deleteSub=sub=>{
    if(sub.plasticLotId&&sub.virginBags)applyPlastic(sub.plasticLotId,sub.virginBags,null,0,sub.batchNo);
    if(sub.aluminumSelections&&sub.aluminumSelections.length)applyAluminum(sub.aluminumSelections,[]);
    if(sub.silicaLotId&&sub.silicaKg)applyMaterialQty("Silica Gel",sub.silicaLotId,sub.silicaKg,null,0,sub.batchNo);
    if(sub.rollsLotId&&sub.rollsUsed)applyMaterialQty("Sachets Paper",sub.rollsLotId,sub.rollsUsed,null,0,sub.batchNo);
    if(sub.wipLotId&&sub.wipPcsUsed)applyMaterialQty("WIP Inventory",sub.wipLotId,sub.wipPcsUsed,null,0,sub.batchNo);
    if(sub.cartonsLotId&&sub.cartonsUsed)applyMaterialQty("Cartons",sub.cartonsLotId,sub.cartonsUsed,null,0,sub.batchNo);
    deleteBatch(sub.id);
  };
  const createOrder=o=>{setOrders(p=>[o].concat(p));showToast(o.orderNo+" created ✓");};
  const deleteOrder=id=>{setOrders(p=>p.filter(o=>o.id!==id));showToast("Deleted","error");};
  const deleteAllOrders=()=>{setOrders([]);showToast("All orders deleted","error");};
  const updateOrder=updated=>{setOrders(p=>p.map(o=>o.id===updated.id?updated:o));showToast("Order updated ✓");};
  // Applies the DIFFERENCE between the previously recorded aluminum selection and the new one.
  // Bags dropped from the selection are released back to stock; newly added bags are marked used.
  const applyAluminum=(oldSels,newSels)=>{
    const key=(l,b)=>l+"|"+b;
    const oldSet={},newSet={};
    (oldSels||[]).forEach(s=>s.bagIds.forEach(b=>{oldSet[key(s.lotId,b)]=1;}));
    (newSels||[]).forEach(s=>s.bagIds.forEach(b=>{newSet[key(s.lotId,b)]=1;}));
    let freed=0,used=0;
    setData(d=>{
      const lots=d["Aluminum Caps"].lots.map(lot=>{
        if(!lot.bags||!lot.bags.length)return lot;
        let changed=false;
        const nb=lot.bags.map(b=>{
          const k=key(lot.id,b.id);
          if(newSet[k]&&!b.used){changed=true;used++;return Object.assign({},b,{used:true,usedDate:today()});}
          if(oldSet[k]&&!newSet[k]&&b.used){changed=true;freed++;return Object.assign({},b,{used:false,usedDate:null});}
          return b;});
        if(!changed)return lot;
        const un=nb.filter(b=>!b.used).length;
        return Object.assign({},lot,{bags:nb,qtyRemaining:un,status:un===0?"Out of Stock":lot.status==="Quarantined"?"Quarantined":un<=nb.length*0.15?"Low Stock":"In Stock"});});
      return Object.assign({},d,{"Aluminum Caps":Object.assign({},d["Aluminum Caps"],{lots:lots})});});
    setTimeout(()=>{
      if(used||freed)showToast((used?used+" bags used":"")+(used&&freed?" · ":"")+(freed?freed+" bags returned":"")+" ✓");
    },0);
  };
  // Applies the DIFFERENCE in plastic usage. Handles both changing the quantity
  // on the same lot and switching to a different lot entirely.
  const applyPlastic=(oldLotId,oldBags,newLotId,newBags,batchNo)=>{
    const ob=Number(oldBags)||0,nb=Number(newBags)||0;
    if(oldLotId===newLotId&&ob===nb)return;
    let msg="";
    setData(d=>{
      const pm=d["Plastic Material"];if(!pm)return d;
      const lots=pm.lots.map(lot=>{
        const cur=Number(lot.qtyRemaining)||0;const rcv=Number(lot.qtyReceived)||cur;
        const st=v=>v<=0?"Out of Stock":v<=rcv*0.15?"Low Stock":"In Stock";
        if(oldLotId===newLotId&&lot.id===newLotId){
          const delta=nb-ob;const v=Math.max(0,cur-delta);
          msg=(delta>0?delta+" bags deducted":Math.abs(delta)+" bags returned")+" · "+lot.lotNumber+" → "+v+" left";
          return Object.assign({},lot,{qtyRemaining:v,status:st(v),usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:delta,reason:"Edit "+batchNo,remainingAfter:v}])});}
        if(lot.id===oldLotId&&oldLotId!==newLotId){
          const v=cur+ob;
          return Object.assign({},lot,{qtyRemaining:v,status:st(v),usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:-ob,reason:"Returned from "+batchNo,remainingAfter:v}])});}
        if(lot.id===newLotId&&oldLotId!==newLotId){
          const v=Math.max(0,cur-nb);
          msg=nb+" bags deducted · "+lot.lotNumber+" → "+v+" left";
          return Object.assign({},lot,{qtyRemaining:v,status:st(v),usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:nb,reason:"Shift "+batchNo,remainingAfter:v}])});}
        return lot;});
      return Object.assign({},d,{"Plastic Material":Object.assign({},pm,{lots:lots})});});
    setTimeout(()=>{if(msg)showToast(msg+" ✓");},0);
  };
  // Same difference-applying logic as applyPlastic, generalized to any material tracked by a
  // plain qtyRemaining (KG, Rolls, etc.) — used by Silica Gel Sachets shifts, which draw from
  // two different materials (Silica Gel and Sachets Paper) instead of just one.
  const applyMaterialQty=(matName,oldLotId,oldQty,newLotId,newQty,batchNo)=>{
    const oq=Number(oldQty)||0,nq=Number(newQty)||0;
    if(oldLotId===newLotId&&oq===nq)return;
    let msg="";
    setData(d=>{
      const m=d[matName];if(!m)return d;
      const lots=m.lots.map(lot=>{
        const cur=Number(lot.qtyRemaining)||0;const rcv=Number(lot.qtyReceived)||cur;
        const st=v=>v<=0?"Out of Stock":v<=rcv*0.15?"Low Stock":"In Stock";
        if(oldLotId===newLotId&&lot.id===newLotId){
          const delta=nq-oq;const v=Math.max(0,cur-delta);
          msg=(delta>0?fmt(delta)+" "+lot.unit+" deducted":fmt(Math.abs(delta))+" "+lot.unit+" returned")+" · "+lot.lotNumber+" → "+fmt(v)+" left";
          return Object.assign({},lot,{qtyRemaining:v,status:st(v),usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:delta,reason:"Edit "+batchNo,remainingAfter:v}])});}
        if(lot.id===oldLotId&&oldLotId!==newLotId){
          const v=cur+oq;
          return Object.assign({},lot,{qtyRemaining:v,status:st(v),usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:-oq,reason:"Returned from "+batchNo,remainingAfter:v}])});}
        if(lot.id===newLotId&&oldLotId!==newLotId){
          const v=Math.max(0,cur-nq);
          msg=fmt(nq)+" "+lot.unit+" deducted · "+lot.lotNumber+" → "+fmt(v)+" left";
          return Object.assign({},lot,{qtyRemaining:v,status:st(v),usageLog:(lot.usageLog||[]).concat([{id:genId(),date:today(),qtyUsed:nq,reason:"Shift "+batchNo,remainingAfter:v}])});}
        return lot;});
      return Object.assign({},d,{[matName]:Object.assign({},m,{lots:lots})});});
    setTimeout(()=>{if(msg)showToast(msg+" ✓");},0);
  };

  if(!data)return <div style={{minHeight:"100vh",display:"flex",alignItems:"center",justifyContent:"center",background:"#F7F9FC",color:"#888",fontFamily:"sans-serif"}}>Loading inventory…</div>;

  let content;
  if(section==="log")content=<ActivityLog data={data} batches={batches} onClose={()=>setSection("inventory")}/>;
  else if(section==="reports")content=<ReportsSection data={data} batches={batches} orders={orders} onClose={()=>setSection("inventory")}/>;
  else if(section==="finance")content=<FinanceSection data={data} batches={batches} orders={orders} laborRates={laborRates} onSaveLaborRates={setLaborRates} onUpdateBatch={updateBatch} onClose={()=>setSection("inventory")}/>;
  else if(section==="labels")content=<LabelsSection batches={batches} onClose={()=>setSection("inventory")}/>;
  else if(section==="certificates")content=<CertificatesSection batches={batches} onClose={()=>setSection("inventory")}/>;
  else if(section==="employees")content=<EmployeesSection employees={employees} batches={batches} onSave={saveEmployee} onDelete={deleteEmployee} onClose={()=>setSection("inventory")}/>;
  else if(section==="cashledger")content=<CashLedgerSection cashLedger={cashLedger} cashOpening={cashOpening} data={data} laborRates={laborRates} onSaveEntry={saveCashEntry} onDeleteEntry={deleteCashEntry} onSetOpening={setCashOpeningBalance}
    batches={batches} silicaEntries={silicaCommissionEntries} silicaSettings={silicaCommissionSettings} silicaWithdrawals={silicaOwnerWithdrawals}
    flipOffSettings={flipOffCommissionSettings} flipOffWithdrawals={flipOffOwnerWithdrawals}
    onSaveSilicaEntry={saveSilicaCommissionEntry} onDeleteSilicaEntry={deleteSilicaCommissionEntry} onSaveSilicaSettings={saveSilicaCommissionSettings}
    onAddSilicaWithdrawal={addSilicaOwnerWithdrawal} onDeleteSilicaWithdrawal={deleteSilicaOwnerWithdrawal}
    onSaveBatch={updateBatch} onSaveFlipOffSettings={saveFlipOffCommissionSettings}
    onAddFlipOffWithdrawal={addFlipOffOwnerWithdrawal} onDeleteFlipOffWithdrawal={deleteFlipOffOwnerWithdrawal}
    onClose={()=>setSection("inventory")}/>;
  else if(section==="production")content=<div style={{maxWidth:700,margin:"0 auto",padding:16,fontFamily:"'Inter',sans-serif"}}>
    <ProductionSection data={data} batches={batches} orders={orders} employees={employees} onCreateBatch={createBatch} onUpdateBatch={updateBatch} onDeleteBatch={deleteBatch} onApplyAluminum={applyAluminum} onApplyPlastic={applyPlastic} onApplyMaterial={applyMaterialQty} onDeleteSub={deleteSub} onSaveLeftover={lot=>addLot("WIP Inventory",lot)} onMarkUnpricedSamples={markUnpricedAsSamples}/></div>;
  else if(section==="orders")content=<div style={{maxWidth:700,margin:"0 auto",padding:16,fontFamily:"'Inter',sans-serif"}}>
    <OrdersSection batches={batches} orders={orders} onCreateOrder={createOrder} onDeleteOrder={deleteOrder} onDeleteAllOrders={deleteAllOrders} onUpdateOrder={updateOrder}/></div>;
  else if(activeMat)content=<MaterialView matName={activeMat} matConfig={data[activeMat]} lots={data[activeMat].lots} coils={data[activeMat].coils||[]}
    coilLots={(data["Aluminum Coils"]&&data["Aluminum Coils"].lots)||[]}
    batches={batches} employees={employees}
    onUpdate={l=>updateLot(activeMat,l)} onDelete={id=>deleteLot(activeMat,id)} onAdd={l=>addLot(activeMat,l)} onBack={()=>setActiveMat(null)}
    onUseCoilStock={useCoilStock}
    onStartCoil={p=>startCoil(activeMat,p)} onMeasureCoil={p=>measureCoil(activeMat,p)} onFinishCoil={()=>finishCoil(activeMat)}
    onToggleBag={(lid,bid)=>toggleBag(activeMat,lid,bid)} onCreateAlBatch={createAlBatch}/>;
  else content=<Dashboard data={data} batches={batches} orders={orders} onSelect={setActiveMat} onLogout={logout} onExport={exportBackup} onImportFile={importBackup} lastSync={lastSync} onSection={s=>{setSection(s);setActiveMat(null);}}/>;

  const showTabs=section!=="log"&&section!=="reports"&&section!=="finance"&&section!=="labels"&&section!=="certificates"&&section!=="employees"&&section!=="cashledger"&&!activeMat;
  return(<div style={{fontFamily:"'Inter',sans-serif"}}>
    {showTabs&&<div style={{background:"#142540",position:"sticky",top:0,zIndex:200,borderBottom:"1px solid rgba(255,255,255,0.08)"}}>
      <div style={{maxWidth:700,margin:"0 auto",display:"flex"}}>
        {[["📦 Inventory","inventory"],["🏭 Production","production"],["🧾 Reports","reports"],["💰 Finance","finance"],["🏦 EP Finance","cashledger"],["📊 Log","log"]].map(x=>(
          <button type="button" key={x[1]} onClick={()=>{setSection(x[1]);setActiveMat(null);}}
            style={{flex:1,background:"none",border:"none",color:section===x[1]?"#fff":"rgba(255,255,255,0.45)",padding:"11px 8px",fontSize:12,fontWeight:section===x[1]?700:400,cursor:"pointer",borderBottom:"2px solid "+(section===x[1]?ACCENT:"transparent"),fontFamily:"inherit",whiteSpace:"nowrap"}}>{x[0]}</button>))}
      </div></div>}
    {content}
    {toast&&<div style={{position:"fixed",bottom:24,left:"50%",transform:"translateX(-50%)",background:toast.type==="error"?"#DC3545":"#1A7A45",color:"#fff",borderRadius:10,padding:"11px 22px",fontWeight:700,fontSize:13,zIndex:9999,whiteSpace:"nowrap"}}>{toast.msg}</div>}
    <style>{"@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;600;700;800;900&display=swap');*{box-sizing:border-box;}body{margin:0;}"}</style>
  </div>);
}
