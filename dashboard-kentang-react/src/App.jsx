import React, {useCallback, useEffect, useRef, useState} from 'react'
import {
  Activity, ArrowRight, Camera, CameraOff, Check, CheckCircle2, ChevronDown, CircleAlert,
  Clock3, CloudUpload, Download, Gauge, Image, Layers3, Leaf, Monitor, Play, RefreshCw,
  RotateCcw, Scale, ScanLine, Settings2, ShieldCheck, Square, UploadCloud, Wifi, X, Zap
} from 'lucide-react'
// import ProcessingSteps from './ProcessingSteps.jsx'

const BASE = import.meta.env.VITE_API_BASE || '/api'
const format = (num, digits=1) => Number(num ?? 0).toLocaleString('id-ID',{maximumFractionDigits:digits,minimumFractionDigits:digits})
const stamp = () => new Date().toLocaleTimeString('id-ID',{hour:'2-digit',minute:'2-digit',second:'2-digit'})

function Metric({icon: Icon, label, value, note, tone='green'}) {
  return <div className="metric card"><div className="metric-top"><span className="metric-label">{label}</span><span className={'metric-icon '+tone}><Icon size={18}/></span></div><div className="metric-value">{value}</div><div className="metric-note">{note}</div></div>
}
function Pill({children,kind='neutral'}) {return <span className={'pill '+kind}>{children}</span>}
function Logo(){return <div className="brand"><div className="brand-mark"><Leaf size={22} strokeWidth={2.5}/></div><div><div className="brand-title">poptato<span>.</span></div><div className="brand-subtitle">SMART POTATO GRADING</div></div></div>}
export default function App(){
  const videoRef=useRef(null), streamRef=useRef(null), fileRef=useRef(null), previewRef=useRef(null)
  const [health,setHealth]=useState('checking')
  const [cameraOn,setCameraOn]=useState(false)
  const [cameraError,setCameraError]=useState('')
  const [cameras,setCameras]=useState([])
  const [selectedCameraId,setSelectedCameraId]=useState('')
  const [source,setSource]=useState('camera')
  const [preview,setPreview]=useState('')
  const [file,setFile]=useState(null)
  const [loading,setLoading]=useState(false)
  const [result,setResult]=useState(null)
  const [error,setError]=useState('')
  const [weight,setWeight]=useState('')
  const [threshold,setThreshold]=useState(0.5)
  const [history,setHistory]=useState([])
  const [activeTab,setActiveTab]=useState('dashboard')
  const [gradeMode,setGradeMode]=useState(false)
  const [lastLatency,setLastLatency]=useState(null)
  const [historyLoading,setHistoryLoading]=useState(false)
  const [historyError,setHistoryError]=useState('')

  const normalizeRecord = useCallback((row)=>({
    id: row.id,
    time: row.created_at ? new Date(row.created_at).toLocaleString('id-ID') : '—',
    label: row.kondisi_visual,
    confidence: Number(row.confidence ?? 0),
    weight: row.berat_gram === null || row.berat_gram === undefined ? null : Number(row.berat_gram),
    group: row.golongan_ukuran,
    ms: Number(row.response_ms ?? 0),
    filename: row.filename
  }),[])

  const loadHistory = useCallback(async()=>{
    setHistoryLoading(true)
    try {
      const response = await fetch(`${BASE}/records?limit=500`)
      const data = await response.json()
      if(!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
      setHistory((data.records || []).map(normalizeRecord))
      setHistoryError('')
    } catch(e) {
      setHistoryError(`Tidak dapat memuat riwayat database: ${e.message}`)
    } finally {
      setHistoryLoading(false)
    }
  },[normalizeRecord])

  const checkHealth = useCallback(async()=>{
    try {const r=await fetch(`${BASE}/health`,{signal:AbortSignal.timeout(5000)});const j=await r.json();setHealth(r.ok && j.status==='ready'?'online':'model-offline')}
    catch {setHealth('offline')}
  },[])
  useEffect(()=>{checkHealth();const t=setInterval(checkHealth,12000);return()=>clearInterval(t)},[checkHealth])
  useEffect(()=>{loadHistory()},[loadHistory])
  const stopCamera=useCallback(()=>{streamRef.current?.getTracks().forEach(t=>t.stop());streamRef.current=null;if(videoRef.current)videoRef.current.srcObject=null;setCameraOn(false)},[])
  const refreshCameras=useCallback(async()=>{
    if(!navigator.mediaDevices?.enumerateDevices)return
    try {
      const devices=await navigator.mediaDevices.enumerateDevices()
      setCameras(devices.filter(device=>device.kind==='videoinput'))
    } catch(e) {
      setCameraError(`Daftar webcam tidak dapat dimuat: ${e.message}`)
    }
  },[])
  useEffect(()=>{
    const devices=navigator.mediaDevices
    if(!devices?.enumerateDevices)return
    refreshCameras()
    devices.addEventListener?.('devicechange',refreshCameras)
    return ()=>devices.removeEventListener?.('devicechange',refreshCameras)
  },[refreshCameras])
  useEffect(()=>()=>{stopCamera();if(previewRef.current)URL.revokeObjectURL(previewRef.current)},[stopCamera])
  const startCamera=useCallback(async(deviceId=selectedCameraId)=>{
    setCameraError('')
    if(!navigator.mediaDevices?.getUserMedia){setCameraError('Webcam memerlukan localhost atau HTTPS.');return}
    try {
      stopCamera()
      const video=deviceId
        ? {deviceId:{exact:deviceId},width:{ideal:1280},height:{ideal:720}}
        : {facingMode:'environment',width:{ideal:1280},height:{ideal:720}}
      const stream=await navigator.mediaDevices.getUserMedia({video,audio:false})
      streamRef.current=stream
      if(videoRef.current){videoRef.current.srcObject=stream;await videoRef.current.play()}
      setCameraOn(true)
      const activeDeviceId=stream.getVideoTracks()[0]?.getSettings().deviceId
      if(activeDeviceId)setSelectedCameraId(activeDeviceId)
      await refreshCameras()
    } catch(e){stopCamera();setCameraError(`Kamera tidak dapat dibuka: ${e.message}`)}
  },[refreshCameras,selectedCameraId,stopCamera])
  const replaceFile=useCallback((nextFile)=>{
    if(!nextFile)return
    if(!nextFile.type.startsWith('image/')){setError('Pilih gambar JPG, PNG, atau WEBP.');return}
    if(nextFile.size>10*1024*1024){setError('Maksimal ukuran gambar 10 MB.');return}
    if(previewRef.current) URL.revokeObjectURL(previewRef.current)
    const url=URL.createObjectURL(nextFile)
    previewRef.current=url;setPreview(url);setFile(nextFile);setResult(null);setError('')
  },[])
  const capture=useCallback(()=>{
    const video=videoRef.current
    if(!video?.videoWidth){setError('Kamera belum siap.');return}
    const canvas=document.createElement('canvas');canvas.width=video.videoWidth;canvas.height=video.videoHeight
    canvas.getContext('2d').drawImage(video,0,0,canvas.width,canvas.height)
    canvas.toBlob(blob=>{if(blob)replaceFile(new File([blob],`kentang-${Date.now()}.jpg`,{type:'image/jpeg'}))},'image/jpeg',0.92)
  },[replaceFile])
  const onFile=(e)=>{replaceFile(e.target.files?.[0]);e.target.value=''}
  const predict=async()=>{
    if(!file){setError('Ambil gambar dari kamera atau unggah foto terlebih dahulu.');return}
    if(gradeMode && (!Number.isFinite(Number(weight)) || Number(weight)<=0 || !weight.trim())){setError('Masukkan berat kentang dalam gram (> 0).');return}
    setError('');setLoading(true)
    try {
      const form=new FormData();form.append('file',file);form.append('threshold_bad',String(threshold))
      if(gradeMode)form.append('berat_gram',weight)
      const started=performance.now()
      const response=await fetch(`${BASE}/${gradeMode?'grade':'predict'}`,{method:'POST',body:form})
      const data=await response.json()
      if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:`HTTP ${response.status}`)
      const ms=Math.round(performance.now()-started)
      setResult(data);setLastLatency(ms)
      // Each successful prediction is stored by FastAPI in SQLite.
      await loadHistory()
    }catch(e){setError(`Prediksi gagal: ${e.message}`)}finally{setLoading(false)}
  }
  const clearPhoto=()=>{setFile(null);setPreview('');setResult(null);setError('');if(previewRef.current)URL.revokeObjectURL(previewRef.current);previewRef.current=null}
  const clearHistory=async()=>{
    if(!window.confirm('Hapus seluruh riwayat pemeriksaan dari database SQLite?')) return
    try {
      const response=await fetch(`${BASE}/records`,{method:'DELETE'})
      const data=await response.json()
      if(!response.ok) throw new Error(data.detail || `HTTP ${response.status}`)
      setHistory([]);setLastLatency(null);setHistoryError('')
    } catch(e) { setHistoryError(`Gagal menghapus riwayat: ${e.message}`) }
  }
  const downloadCsv=()=>{
    const rows=[['waktu','nama_file','kondisi_visual','confidence','berat_gram','golongan_ukuran','waktu_respons_ms'],...history.map(x=>[x.time,x.filename??'',x.label,x.confidence,x.weight??'',x.group??'',x.ms])]
    const csv=rows.map(r=>r.map(v=>'"'+String(v).replaceAll('"','""')+'"').join(',')).join('\r\n')
    const url=URL.createObjectURL(new Blob(['\ufeff'+csv],{type:'text/csv;charset=utf-8'}));const a=document.createElement('a');a.href=url;a.download='riwayat_sortasi_kentang.csv';a.click();URL.revokeObjectURL(url)
  }
  const goodCount=history.filter(x=>x.label==='GOOD').length,badCount=history.filter(x=>x.label==='BAD').length
  return <div className="app-shell">
    <aside className="sidebar">
      <Logo/>
      <div className="side-caption">WORKSPACE</div>
      <button className={'nav-item '+(activeTab==='dashboard'?'active':'')} onClick={()=>setActiveTab('dashboard')}><Gauge size={19}/> Dashboard <span className="nav-selection"/></button>
      <button className={'nav-item '+(activeTab==='history'?'active':'')} onClick={()=>setActiveTab('history')}><Layers3 size={19}/> Riwayat Sortasi</button>
      <div className="side-caption second">SISTEM</div>
      <div className="system-card"><div className="system-top"><span className={'dot '+(health==='online'?'live':'')}/><strong>{health==='online'?'Model aktif':health==='checking'?'Memeriksa model...':'Model tidak aktif'}</strong></div><div>ResNet50 · FastAPI</div><button className="system-refresh" onClick={checkHealth}><RefreshCw size={13}/> Periksa koneksi</button></div>
      <div className="sidebar-bottom"><div className="mini-icon"><ShieldCheck size={18}/></div><div><strong>Proyek PBL Kentang</strong><small>Sistem sortir visual & berat</small></div></div>
    </aside>
    <main className="main">
      <header className="topbar"><div className="crumb">Workspace <span>/</span> <b>{activeTab==='dashboard'?'Dashboard':'Riwayat Sortasi'}</b></div><div className="topbar-right"><div className={'connection '+(health==='online'?'on':'off')}><span className="dot"/>{health==='online'?'API Connected':health==='checking'?'Connecting...':'API Offline'}</div><div className="avatar">P</div></div></header>
      <div className="content">
      {activeTab==='dashboard'? <>
        <div className="heading-row"><div><div className="eyebrow"><span className="eyebrow-line"/> SMART SORTING SYSTEM</div><h1>Dashboard Sortasi Kentang<span className="title-dot">.</span></h1><p className="subtitle">Analisis kondisi visual kentang menggunakan AI, terintegrasi dengan sistem grading berat.</p></div><div className="date-chip"><Clock3 size={16}/>{new Date().toLocaleDateString('id-ID',{weekday:'long',day:'numeric',month:'long',year:'numeric'})}</div></div>
        {historyError?<p className="inline-error">{historyError}</p>:null}
        <div className="metrics"><Metric icon={ScanLine} label="Total Pemeriksaan" value={history.length} note="Tersimpan di SQLite"/><Metric icon={CheckCircle2} label="Kentang Good" value={goodCount} note={history.length?`${format(100*goodCount/history.length)}% dari total`:'Belum ada pemeriksaan'}/><Metric icon={CircleAlert} label="Kentang Bad" value={badCount} note={history.length?`${format(100*badCount/history.length)}% dari total`:'Belum ada pemeriksaan'} tone="orange"/><Metric icon={Zap} label="Respons API Terakhir" value={lastLatency===null?'—':`${lastLatency} ms`} note="Termasuk transfer & inferensi" tone="blue"/></div>
        <div className="work-grid">
          <section className="card camera-card"><div className="card-heading"><div><div className="kicker">01 / IMAGE ACQUISITION</div><h2>Monitoring Kamera</h2><p>Ambil foto kentang melalui webcam atau unggah gambar.</p></div><Pill kind={cameraOn?'success':'neutral'}><span className={'statusdot '+(cameraOn?'green':'')}/>{cameraOn?'LIVE CAMERA':'CAMERA OFF'}</Pill></div>
            <div className="camera-input-options">
              <div className="source-tabs"><button className={source==='camera'?'selected':''} onClick={()=>setSource('camera')}><Camera size={16}/> Webcam</button><button className={source==='upload'?'selected':''} onClick={()=>{setSource('upload');stopCamera()}}><UploadCloud size={16}/> Upload Gambar</button></div>
              {source==='camera'?<label className="camera-device-picker"><span><Monitor size={15}/> Pilih webcam</span><select aria-label="Pilih webcam" value={selectedCameraId} onChange={e=>{setSelectedCameraId(e.target.value);if(cameraOn)startCamera(e.target.value)}} disabled={!cameras.length}>
                <option value="">Otomatis (webcam default)</option>
                {cameras.map((device,index)=><option key={device.deviceId||device.label} value={device.deviceId}>{device.label||`Webcam ${index+1}`}</option>)}
              </select></label>:null}
            </div>
            <div className="camera-stage">
              <video ref={videoRef} autoPlay playsInline muted style={{display:source==='camera' && cameraOn?'block':'none'}}/>
              {source==='camera' && !cameraOn?<div className="camera-empty"><div className="empty-ring"><Camera size={34}/></div><strong>Preview kamera belum aktif</strong><span>Klik “Aktifkan Kamera” untuk memulai live preview</span></div>:null}
              {source==='upload'?<div className="camera-empty upload-empty" onClick={()=>fileRef.current?.click()} role="button" tabIndex={0} onKeyDown={e=>e.key==='Enter'&&fileRef.current?.click()}><div className="empty-ring"><Image size={34}/></div><strong>Pilih gambar kentang</strong><span>JPG, PNG, WEBP · Maksimal 10 MB</span></div>:null}
              <div className="corner tl"/><div className="corner tr"/><div className="corner bl"/><div className="corner br"/>
              {cameraOn&&source==='camera'?<span className="live-label"><span/> LIVE</span>:null}
            </div>
            {cameraError?<p className="inline-error">{cameraError}</p>:null}
            <div className="camera-actions">
              {source==='camera'?<><button className="btn secondary" onClick={cameraOn?stopCamera:()=>startCamera()}>{cameraOn?<><CameraOff size={17}/> Matikan Kamera</>:<><Play size={17}/> Aktifkan Kamera</>}</button><button className="btn primary" onClick={capture} disabled={!cameraOn}><Camera size={18}/> Ambil Gambar</button></>:<button className="btn primary" onClick={()=>fileRef.current?.click()}><UploadCloud size={17}/> Pilih Gambar</button>}
              <input ref={fileRef} type="file" accept="image/jpeg,image/png,image/webp,image/bmp" hidden onChange={onFile}/>
            </div>
            <div className="camera-footer"><div><ScanLine size={15}/> Model input 224 × 224</div><div><Wifi size={15}/> Endpoint: /predict</div></div>
          </section>
          <section className="card prediction-card"><div className="card-heading"><div><div className="kicker">02 / AI CLASSIFICATION</div><h2>Hasil Analisis</h2><p>Prediksi kondisi visual menggunakan ResNet50.</p></div><div className="ai-icon"><Activity size={20}/></div></div>
            <div className="selected-photo">{preview?<><img src={preview} alt="Gambar kentang untuk analisis"/><button className="remove-photo" onClick={clearPhoto} aria-label="Hapus gambar"><X size={15}/></button></>:<div className="photo-placeholder"><Image size={27}/><span>Belum ada gambar dipilih</span></div>}</div>
            <div className="predicted-heading">HASIL PREDIKSI</div>
            {result?<div className={'result-block '+(result.kondisi_visual==='GOOD'?'good':'bad')}><div className="result-icon">{result.kondisi_visual==='GOOD'?<Check size={24}/>:<CircleAlert size={24}/>}</div><div><small>KONDISI KENTANG</small><strong>{result.kondisi_visual}</strong><span>Confidence {format(result.confidence*100,2)}%</span></div></div>:<div className="awaiting"><ScanLine size={24}/><strong>Menunggu analisis</strong><span>Ambil gambar dan klik “Analisis Kentang”</span></div>}
            <div className="probabilities"><div className="prob-header"><span>Good Condition</span><b>{result?`${format(result.probabilitas_good*100,2)}%`:'—'}</b></div><div className="track"><div className="fill good-fill" style={{width:`${result?result.probabilitas_good*100:0}%`}}/></div><div className="prob-header"><span>Bad Condition</span><b>{result?`${format(result.probabilitas_bad*100,2)}%`:'—'}</b></div><div className="track"><div className="fill bad-fill" style={{width:`${result?result.probabilitas_bad*100:0}%`}}/></div></div>
            <div className="analysis-settings"><label><input type="checkbox" checked={gradeMode} onChange={e=>{setGradeMode(e.target.checked);setResult(null)}}/><span>Aktifkan simulasi grading berat</span></label>{gradeMode?<div className="weight-row"><Scale size={17}/><input type="number" placeholder="Berat kentang (gram)" value={weight} min="0.1" step="0.1" onChange={e=>setWeight(e.target.value)}/><span>gram</span></div>:null}<div className="threshold-row"><span>Threshold Bad</span><span>{threshold.toFixed(2)}</span></div><input className="range" type="range" min="0.05" max="0.95" step="0.05" value={threshold} onChange={e=>setThreshold(Number(e.target.value))}/></div>
            {result && gradeMode?<div className="grade-response"><span>KEPUTUSAN SORTIR</span><strong>{result.keputusan_sortir}</strong><small>{result.golongan_ukuran?`Golongan ukuran: ${result.golongan_ukuran}`:'Tidak dilanjutkan ke grading berat'}</small></div>:null}
            {error?<p className="inline-error"><CircleAlert size={15}/> {error}</p>:null}
            <button className="btn primary full predict-btn" onClick={predict} disabled={loading||!file||health!=='online'}>{loading?<><RefreshCw className="spin" size={18}/> Menganalisis...</>:<><ScanLine size={18}/> Analisis Kentang <ArrowRight size={17}/></>}</button>
            <p className="disclaimer">Prediksi visual berbasis model. Verifikasi fisik tetap diperlukan sebelum sortasi nyata.</p>
          </section>
        </div>
        {/* {result && file ? <ProcessingSteps file={file} result={result} /> : null} */}
        <div className="bottom-grid"><section className="card history-card"><div className="card-heading compact"><div><div className="kicker">03 / RECENT ACTIVITY</div><h2>Riwayat Pemeriksaan</h2></div><button className="text-button" onClick={()=>setActiveTab('history')}>Lihat semua <ArrowRight size={15}/></button></div><HistoryTable rows={history.slice(0,5)}/></section><section className="card system-info"><div className="kicker">SYSTEM OVERVIEW</div><h2>Alur Pemrosesan</h2><div className="process-list"><div><span className="process-icon"><Camera size={18}/></span><div><b>Image Acquisition</b><small>Webcam / Upload Foto</small></div><Check size={17}/></div><div><span className="process-icon"><Activity size={18}/></span><div><b>AI Classification</b><small>ResNet50 · Good / Bad</small></div><Check size={17}/></div><div><span className="process-icon"><Scale size={18}/></span><div><b>Weight Grading</b><small>Input berat manual · SNI</small></div><Check size={17}/></div></div><div className="system-footnote">Integrasi sensor HX711 dan servo belum diaktifkan pada dashboard ini.</div></section></div>
      </>:<><div className="heading-row"><div><div className="eyebrow">DATA MONITORING</div><h1>Riwayat Sortasi<span className="title-dot">.</span></h1><p className="subtitle">Riwayat pemeriksaan permanen yang tersimpan di database SQLite.</p></div><button className="btn secondary" onClick={downloadCsv} disabled={!history.length}><Download size={17}/> Ekspor CSV</button></div><div className="card history-page"><div className="card-heading compact"><div><h2>Semua Pemeriksaan</h2><p>{historyLoading?'Memuat data...':`${history.length} hasil tersimpan di SQLite`}</p></div><div className="history-actions"><button className="btn subtle" onClick={loadHistory}><RefreshCw size={16}/> Muat ulang</button><button className="btn subtle" onClick={clearHistory} disabled={!history.length}><RotateCcw size={16}/> Hapus semua</button></div></div>{historyError?<p className="inline-error">{historyError}</p>:null}<HistoryTable rows={history}/></div></>}
      <footer><span>© 2026 Poptato — PBL Smart Potato Grading</span><span>Powered by ResNet50 · FastAPI · React</span></footer>
      </div>
    </main>
  </div>
}
function HistoryTable({rows}){return <div className="table-scroll"><table><thead><tr><th>WAKTU</th><th>KONDISI</th><th>CONFIDENCE</th><th>BERAT</th><th>UKURAN</th><th>RESPONS</th></tr></thead><tbody>{rows.length?rows.map(row=><tr key={row.id}><td className="time-col"><Clock3 size={14}/>{row.time}</td><td><Pill kind={row.label==='GOOD'?'success':'danger'}><span className="statusdot"/>{row.label}</Pill></td><td>{format(row.confidence*100,2)}%</td><td>{row.weight===null?'—':`${format(row.weight)} g`}</td><td>{row.group||'—'}</td><td>{row.ms} ms</td></tr>):<tr><td colSpan="6" className="empty-table"><Layers3 size={24}/><span>Belum ada pemeriksaan pada sesi ini.</span></td></tr>}</tbody></table></div>}
