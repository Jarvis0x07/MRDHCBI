import {
  loadBinaryImage,binaryToCanvas,canvasToBlob,vcEncrypt,baseEmbed,baseExtract,restoreBaseShare,
  syndromeEmbed,syndromeExtractRestore,vcRecover,corruptBits,makePayload,parsePayload,
  fitPayloadToBits,bitsFromBytes,bytesFromBits,sharePngBlob
} from './algorithm.js';

let role=null, peer=null, conn=null, pairingKey='', imageState=null, documentFile=null, charts=[], analysisCharts=[];
const $=id=>document.getElementById(id);
const show=(id,on=true)=>$(id).classList.toggle('hidden',!on);
const status=(s,good=false)=>{ $('connectionStatus').textContent=(good?'● ':'● ')+s; };
const log=(m)=>{ $('senderLog').textContent += `[${new Date().toLocaleTimeString()}] ${m}\n`; };

function simpleHash(s){
  let h=2166136261>>>0; for(let i=0;i<s.length;i++){h^=s.charCodeAt(i);h=Math.imul(h,16777619)}
  return (h>>>0).toString(16).padStart(8,'0');
}
function senderPeerId(key){return 'mrdhcbi-'+simpleHash(key);}
function sameBits(a,b){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true}
function imageAccuracy(a,b){let ok=0;for(let i=0;i<a.length;i++)if(a[i]===b[i])ok++;return ok/a.length*100}
function byteAccuracy(a,b){let n=Math.min(a.length,b.length),ok=0;for(let i=0;i<n;i++)if(a[i]===b[i])ok++;return b.length?ok/b.length*100:0}
function fmtBytes(n){if(n<1024)return `${n} B`;if(n<1048576)return `${(n/1024).toFixed(1)} KB`;return `${(n/1048576).toFixed(2)} MB`}
function downloadBlob(blob,name){const u=URL.createObjectURL(blob),a=document.createElement('a');a.href=u;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(u),1000)}
function escapeHtml(s){return s.replace(/[&<>"']/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))}

document.querySelectorAll('.role-card').forEach(btn=>btn.onclick=()=>{
  role=btn.dataset.role;
  if(role==='analysis'){
    show('landing',false);
    show('pairing',false); show('senderPanel',false); show('receiverPanel',false); show('dashboard',false);
    show('analysisPanel',true);
    renderAnalysis();
    return;
  }
  show('landing',false); show('pairing'); $('pairState').textContent=`Role: ${role}`;
});
$('analysisBackBtn').onclick=()=>{ show('analysisPanel',false); show('landing',true); role=null; };
$('analysisMetric').onchange=renderAnalysis;
$('analysisImage').onchange=renderAnalysis;
$('backBtn').onclick=()=>{if(peer)peer.destroy();peer=null;conn=null;show('pairing',false);show('landing');status('Offline')};
$('corruption').oninput=e=>$('corruptionValue').textContent=e.target.value+'%';
$('imageInput').onchange=async e=>{
  if(!e.target.files[0])return;
  try{
    imageState=await loadBinaryImage(e.target.files[0]);
    const c=binaryToCanvas(imageState.bits,imageState.width,imageState.height,Math.max(1,Math.min(4,512/imageState.width)));
    $('imagePreview').src=c.toDataURL();show('imagePreview');$('imageDrop').classList.add('hidden');
    $('sendBtn').disabled=!documentFile;
  }catch(err){alert('Could not read image: '+err.message)}
};
$('documentInput').onchange=e=>{
  documentFile=e.target.files[0]||null;
  if(documentFile){$('docInfo').innerHTML=`<b>${escapeHtml(documentFile.name)}</b><br>${fmtBytes(documentFile.size)} • ${escapeHtml(documentFile.type||'unknown type')}`;show('docInfo');$('docDrop').classList.add('hidden')}
  $('sendBtn').disabled=!(documentFile&&imageState);
};

async function createPeer(){
  pairingKey=$('pairKey').value.trim();
  if(!pairingKey){alert('Enter a pairing key.');return}
  $('pairBtn').disabled=true; $('pairState').textContent='Connecting…'; $('roomDisplay').textContent=simpleHash(pairingKey).toUpperCase();
  if(role==='sender') await startSenderPeer(); else await startReceiverPeer();
}
$('pairBtn').onclick=createPeer;

function peerPromise(id){
  return new Promise((resolve,reject)=>{
    const p=new Peer(id,{debug:0});
    p.on('open',()=>resolve(p)); p.on('error',reject);
  });
}
async function startSenderPeer(){
  try{
    peer=await peerPromise(senderPeerId(pairingKey));
    status('Waiting for receiver',true);
    $('pairState').textContent='Room open';
    $('pairMessage').textContent='Waiting for the receiver to join with the same key…';
    peer.on('connection',c=>{
      conn=c; setupConnection();
      c.on('open',()=>enterRolePanel());
    });
  }catch(e){
    $('pairMessage').textContent='Could not open this pairing key. Try another key.';
    $('pairBtn').disabled=false; status('Connection error');
    console.error(e);
  }
}
async function startReceiverPeer(){
  try{
    peer=await peerPromise();
    status('Joining room',true);
    conn=peer.connect(senderPeerId(pairingKey),{reliable:true});
    setupConnection();
    conn.on('open',()=>enterRolePanel());
    conn.on('error',e=>{$('pairMessage').textContent='Receiver could not join the sender room.';console.error(e)});
  }catch(e){
    $('pairMessage').textContent='Could not connect. Make sure the sender has opened the same key.';
    $('pairBtn').disabled=false; status('Connection error');console.error(e);
  }
}
function setupConnection(){
  conn.on('close',()=>{status('Disconnected');$('pairMessage').textContent='Peer disconnected.'});
  conn.on('data',onData);
}
function enterRolePanel(){
  status('Paired',true);show('pairing',false);
  show(role==='sender'?'senderPanel':'receiverPanel');
  if(role==='receiver'){$('receiverWait').classList.remove('hidden')}
  else log('Peer paired. Select an image and document.');
}

async function buildTransaction(){
  const {bits,width:w,height:h}=imageState, N=w*h;
  const payload=await makePayload(documentFile,pairingKey);
  const encrypted=payload.encrypted;
  const baseCap=N, propCap=N*3;
  if(encrypted.length*8>propCap) throw new Error(`Document + metadata (${fmtBytes(encrypted.length)}) exceeds proposed capacity (${fmtBytes(Math.floor(propCap/8))}). Use a larger image or smaller document.`);
  const baseFits=encrypted.length*8<=baseCap;
  const plainBytes=payload.plainBytes;
  const vc=vcEncrypt(bits,w,h,2026);
  const proposedBits=fitPayloadToBits(encrypted,propCap);
  const proposedMarked=vc.map(s=>syndromeEmbed(s,proposedBits,w,h));
  let baseMarked=null;
  if(baseFits){
    const baseBits=fitPayloadToBits(encrypted,baseCap);
    baseMarked=vc.map(s=>baseEmbed(s,baseBits,w,h));
  }
  const corruption=Number($('corruption').value);
  const proposedTx=proposedMarked.map((s,i)=>corruption?corruptBits(s,corruption,500+i):s);
  const baseTx=baseMarked?baseMarked.map((s,i)=>corruption?corruptBits(s,corruption,700+i):s):null;
  const propResult=evaluateProposed(proposedTx,bits,w,h,pairingKey,documentFile.size,encrypted.length);
  const baseResult=baseTx?await evaluateBase(baseTx,bits,w,h,pairingKey):null;
  const meta={
    version:1,w,h,corruption,payloadBytes:encrypted.length,documentBytes:documentFile.size,
    documentName:documentFile.name,method:'Hamming syndrome embedding',
    proposed:propResult,base:baseResult,
    originalImageBits:bits.length
  };
  return {meta,shares:proposedTx,encryptedBytes:encrypted};
}

function evaluateProposed(markedShares,original,w,h,key,docSize,encryptedSize){
  const ext=markedShares.map(s=>syndromeExtractRestore(s,w,h));
  const recoveredImage=vcRecover(ext[0].restored,ext[1].restored,w,h);
  const imagePct=imageAccuracy(recoveredImage,original);
  const recoveredEncrypted=bytesFromBits(ext[0].payload);
  const clipped=recoveredEncrypted.slice(0,encryptedSize);
  return {imageRecoveryPct:imagePct,exactImage:sameBits(recoveredImage,original),recoveredPayload:clipped.buffer,
    extractedBits:ext[0].payload.length,correctedCodeErrors:ext.reduce((a,x)=>a+x.correctedCodeErrors,0)};
}
async function evaluateBase(markedShares,original,w,h,key){
  const restored=markedShares.map(s=>restoreBaseShare(s,w,h));
  const rec=vcRecover(restored[0],restored[1],w,h);
  const extracted=baseExtract(markedShares[0],w,h);
  return {imageRecoveryPct:imageAccuracy(rec,original),exactImage:sameBits(rec,original),recoveredPayload:bytesFromBits(extracted).buffer};
}

function sendBuf(data){conn.send(data)}
async function sendTransaction(){
  $('sendBtn').disabled=true;log('Building visual-cryptography shares…');
  try{
    const tx=await buildTransaction();
    // Recover document from proposed payload for the sender dashboard.
    const propPayload=new Uint8Array(tx.meta.proposed.recoveredPayload);
    let propDoc;
    try{propDoc=await parsePayload(propPayload,pairingKey)}catch{propDoc=null}
    tx.meta.proposed.documentRecoveryPct=propDoc?byteAccuracy(propDoc.body,await documentFile.arrayBuffer().then(x=>new Uint8Array(x))):0;
    tx.meta.proposed.documentExact=!!(propDoc&&propDoc.crcOk&&propDoc.body.length===documentFile.size);
    if(tx.meta.base){
      const basePayload=new Uint8Array(tx.meta.base.recoveredPayload);
      try{
        const bd=await parsePayload(basePayload,pairingKey);
        const originalBytes=new Uint8Array(await documentFile.arrayBuffer());
        tx.meta.base.documentRecoveryPct=byteAccuracy(bd.body,originalBytes);
        tx.meta.base.documentExact=bd.crcOk&&bd.body.length===originalBytes.length;
      }catch{tx.meta.base.documentRecoveryPct=0;tx.meta.base.documentExact=false}
    }
    // Do not send the document separately. The marked shares are the hidden-data carrier.
    // Keep binary recovery buffers local; the manifest contains only dashboard data.
    delete tx.meta.proposed.recoveredPayload;
    if(tx.meta.base) delete tx.meta.base.recoveredPayload;
    sendBuf(JSON.stringify({type:'manifest',meta:tx.meta}));
    for(let i=0;i<tx.shares.length;i++)sendBuf(tx.shares[i].buffer);
    renderDashboard(tx.meta,'sender');
    log(`Sent ${tx.shares.length} marked shares. Corruption: ${tx.meta.corruption}%.`);
    log(`Proposed image recovery: ${tx.meta.proposed.imageRecoveryPct.toFixed(2)}%.`);
  }catch(e){alert(e.message);log('ERROR: '+e.message);$('sendBtn').disabled=false}
}
$('sendBtn').onclick=sendTransaction;

let incoming={meta:null,shares:[]};
async function onData(data){
  if(typeof data==='string'){
    try{
      const m=JSON.parse(data);
      if(m.type==='manifest'){incoming={meta:m.meta,shares:[]};}
    }catch{}
    return;
  }
  if(incoming.meta){
    incoming.shares.push(new Uint8Array(data));
    if(incoming.shares.length===3) await receiveComplete();
  }
}
async function receiveComplete(){
  const m=incoming.meta,s=incoming.shares;
  try{
    const ext=s.map(x=>syndromeExtractRestore(x,m.w,m.h));
    const image=vcRecover(ext[0].restored,ext[1].restored,m.w,m.h);
    const payloadBytes=bytesFromBits(ext[0].payload).slice(0,m.payloadBytes);
    const doc=await parsePayload(payloadBytes,pairingKey);
    // Exact original-image comparison is calculated at the sender and included in the manifest.
    const verifiedImagePct=m.proposed.imageRecoveryPct;
    const originalBytes=null;
    const recovery={...m.proposed,receiverCrcOk:doc.crcOk,receiverDocumentName:doc.name,receiverDocumentSize:doc.body.length,
      receiverCorrectedCodeErrors:ext.reduce((a,x)=>a+x.correctedCodeErrors,0),receiverImagePixels:image.length,
      displayedImageRecoveryPct:verifiedImagePct};
    // Make recovered document available.
    const blob=new Blob([doc.body],{type:doc.mime||'application/octet-stream'});

          // Recovered sender image -> data URL
      const imgCanvas=binaryToCanvas(image,m.w,m.h,Math.max(1,Math.min(4,Math.floor(512/m.w))));
      const imgURL=imgCanvas.toDataURL();

      // Optional: preview text documents
      let textPreview='';
      if((doc.mime&&doc.mime.startsWith('text/'))||/\.txt$/i.test(doc.name)){
        textPreview=`<h3 style="margin-top:16px">Document preview</h3>
          <pre class="doc-preview">${escapeHtml(new TextDecoder().decode(doc.body.slice(0,2000)))}</pre>`;
      }

    $('receiverResult').innerHTML=`<div class="metric-grid">
      <div class="metric"><span>Image recovery</span><b>${verifiedImagePct.toFixed(2)}%</b><small>pixel-level</small></div>
      <div class="metric"><span>Document integrity</span><b class="${doc.crcOk?'success':'danger'}">${doc.crcOk?'100%':'FAILED'}</b><small>CRC-32 verification</small></div>
      <div class="metric"><span>Document</span><b>${fmtBytes(doc.body.length)}</b><small>${escapeHtml(doc.name)}</small></div>
      <div class="metric"><span>Corruption</span><b>${m.corruption}%</b><small>simulated before transfer</small></div>
    </div>

 <div class="panel" style="margin-top:16px">
      <h3>Recovered image (sender's input)</h3>
      <img src="${imgURL}" class="recovered-img" alt="Recovered binary image">
    </div>
    
    <div class="panel" style="margin-top:16px">
      <h3>Recovered successfully</h3>
      <p class="${doc.crcOk?'success':'danger'}">${doc.crcOk?'The recovered document passed CRC-32 and is byte-for-byte valid.':'The recovered document failed CRC-32; corruption affected the payload.'}</p>
      ${textPreview}
      <button class="primary" id="downloadRecovered" style="margin-top:14px">Download recovered document</button>
    </div>`;


    show('receiverWait',false);show('receiverResult');
    $('downloadRecovered').onclick=()=>downloadBlob(blob,doc.name);
    renderDashboard(m,'receiver');
  }catch(e){
    $('receiverResult').innerHTML=`<div class="panel"><h3>Recovery failed</h3><p class="danger">${escapeHtml(e.message)}</p></div>`;
    show('receiverWait',false);show('receiverResult');renderDashboard(m,'receiver');
  }
}

function renderDashboard(meta,who){
  show('dashboard');
  const p=meta.proposed||{},b=meta.base;
  const baseCapacity=meta.originalImageBits, propCapacity=meta.originalImageBits*3;
  const baseStored=meta.originalImageBits*3, propStored=meta.originalImageBits*7;
  $('summaryCards').innerHTML=`
    <div class="metric"><span>Proposed capacity</span><b>${(propCapacity/8/1024).toFixed(2)} KB</b><small>3 bits / source pixel</small></div>
    <div class="metric"><span>Base capacity</span><b>${(baseCapacity/8/1024).toFixed(2)} KB</b><small>1 bit / source pixel</small></div>
    <div class="metric"><span>Proposed recovery</span><b>${(p.imageRecoveryPct??0).toFixed(2)}%</b><small>image pixels</small></div>
    <div class="metric"><span>Corruption</span><b>${meta.corruption}%</b><small>simulated channel error</small></div>`;
  $('detailsTable').innerHTML=`<table class="details"><tr><th>Metric</th><th>Base MRDHCBI</th><th>Hamming syndrome</th></tr>
    <tr><td>Payload density</td><td>1 bpp/source px</td><td>3 bpp/source px</td></tr>
    <tr><td>Stored bits / source px</td><td>3</td><td>7</td></tr>
    <tr><td>Stored expansion</td><td>3×</td><td>7×</td></tr>
    <tr><td>Image recovery</td><td>${b?b.imageRecoveryPct.toFixed(2)+'%':'N/A'}</td><td>${(p.imageRecoveryPct??0).toFixed(2)}%</td></tr>
    <tr><td>Document recovery</td><td>${b?(b.documentRecoveryPct??0).toFixed(2)+'%':'N/A — document may exceed base capacity'}</td><td>${(p.documentRecoveryPct??(p.documentExact?100:0)).toFixed(2)}%</td></tr>
    <tr><td>Exact document</td><td>${b?(b.documentExact?'YES':'NO'):'—'}</td><td>${p.documentExact?'YES':'NO'}</td></tr>
    <tr><td>Transaction</td><td colspan="2">${who} • ${meta.w}×${meta.h} • ${fmtBytes(meta.documentBytes)} document</td></tr></table>`;
  charts.forEach(c=>c.destroy());charts=[];
  charts.push(new Chart($('capacityChart'),{type:'bar',data:{labels:['Base','Proposed'],datasets:[{label:'Payload capacity (bits/source pixel)',data:[1,3]}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));
  charts.push(new Chart($('recoveryChart'),{type:'bar',data:{labels:['Base','Proposed'],datasets:[{label:'Image recovery %',data:[b?.imageRecoveryPct??0,p.imageRecoveryPct??0]}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{min:0,max:100}}}}));
  charts.push(new Chart($('storageChart'),{type:'bar',data:{labels:['Base','Proposed'],datasets:[{label:'Stored bits / source pixel',data:[3,7]}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));
  $('dashboard').scrollIntoView({behavior:'smooth'});
}


const PAPER_IMAGES=['Cartoon','CAD','Texture','Mask','Pattern','Document'];
const PAPER_FILES={Cartoon:'183.bmp',CAD:'487.bmp',Texture:'760.bmp',Mask:'1001.bmp',Pattern:'1704.bmp',Document:'3060.bmp'};
const METHODS=['Ren et al. [12]','Li et al. [13]','Zhang et al. [14]','Paper presented'];
const PAPER_EMBED={
  Cartoon:[0.42,0.43,0.39,0.50], CAD:[0.24,0.25,0.22,0.50], Texture:[0.17,0.19,0.15,0.50],
  Mask:[0.80,0.83,0.85,0.50], Pattern:[0.30,0.31,0.24,0.50], Document:[0.46,0.46,0.41,0.50]
};
const PAPER_RUNTIME={
  Cartoon:[71.1064,72.1823,54.8561,60.9352], CAD:[73.7246,75.8646,59.7081,61.1015],
  Texture:[79.0976,79.7218,62.9826,60.3014], Mask:[92.4886,95.6055,66.3101,59.6784],
  Pattern:[71.3982,73.0493,59.5149,60.6579], Document:[71.1297,71.1876,55.3301,60.8692]
};
const FUNCTIONAL=[
  ['Embedding space','Correlation','Correlation','Correlation','Encryption'],
  ['Preprocessing','Yes','Yes','Yes','No'],
  ['Encryption','Stream cipher','Stream cipher','Stream cipher','Visual cryptography'],
  ['Data hider','Single','Single','Single','Multiple']
];
function methodLabels(){return ['Ren [12]','Li [13]','Zhang [14]','Paper'];}
function makeAnalysisThumb(type){
  const c=document.createElement('canvas'); c.width=256;c.height=180; const x=c.getContext('2d');
  x.fillStyle='#080d16';x.fillRect(0,0,256,180);x.fillStyle='#f1f5f9';
  if(type==='Cartoon'){
    x.beginPath();x.arc(128,88,62,0,Math.PI*2);x.fill();x.fillStyle='#080d16';x.fillRect(91,68,18,18);x.fillRect(147,68,18,18);x.fillRect(110,119,36,6);
  } else if(type==='CAD'){
    x.strokeStyle='#f1f5f9';x.lineWidth=5;x.strokeRect(42,30,172,120);x.beginPath();x.moveTo(42,120);x.lineTo(100,60);x.lineTo(145,125);x.lineTo(190,55);x.stroke();
  } else if(type==='Texture'){
    for(let yy=0;yy<180;yy+=8)for(let xx=0;xx<256;xx+=8)if(((xx*17+yy*31)%23)<11)x.fillRect(xx,yy,5,5);
  } else if(type==='Mask'){
    x.beginPath();x.arc(128,88,70,0,Math.PI*2);x.fill();x.fillStyle='#080d16';x.beginPath();x.ellipse(102,84,16,9,0,0,Math.PI*2);x.ellipse(154,84,16,9,0,0,Math.PI*2);x.fill();x.fillRect(110,115,36,7);
  } else if(type==='Pattern'){
    for(let y=20;y<170;y+=30)for(let xx=20;xx<250;xx+=30){x.fillRect(xx,y,16,16);x.clearRect(xx+4,y+4,8,8)}
  } else {
    x.font='bold 15px monospace';let lines=['DOCUMENT','REVERSIBLE','DATA HIDING','BINARY IMAGE'];lines.forEach((t,i)=>x.fillText(t,34,45+i*32));
  }
  return c.toDataURL();
}
function bestText(values,lower=false){
  const idx=lower?values.indexOf(Math.min(...values)):values.indexOf(Math.max(...values));
  return `${methodLabels()[idx]} • ${values[idx].toFixed(2)}`;
}
function renderAnalysis(){
  const metric=$('analysisMetric').value, selected=$('analysisImage').value;
  const images=selected==='all'?PAPER_IMAGES:[selected];
  $('analysisImages').innerHTML=images.map(t=>`<div class="analysis-image-card"><img src="${makeAnalysisThumb(t)}" alt="${t} representative binary preview"><b>${t}</b><span>${PAPER_FILES[t]} • 256×256 paper test image</span></div>`).join('');
  const embedAll=PAPER_IMAGES.flatMap(t=>PAPER_EMBED[t]);
  const runtimeAll=PAPER_IMAGES.flatMap(t=>PAPER_RUNTIME[t]);
  const paperAvgEmbed=embedAll.reduce((a,b)=>a+b,0)/embedAll.length;
  const paperAvgRuntime=runtimeAll.reduce((a,b)=>a+b,0)/runtimeAll.length;
  const proposedRuntime=PAPER_IMAGES.map(t=>PAPER_RUNTIME[t][3]);
  const runtimeRange=Math.max(...proposedRuntime)-Math.min(...proposedRuntime);
  const embedRange=0.50-0.50;
  $('analysisSummary').innerHTML=`
    <div class="metric"><span>Paper test images</span><b>6</b><small>all six categories</small></div>
    <div class="metric"><span>Paper embedding rate</span><b>${paperAvgEmbed.toFixed(3)} bpp</b><small>mean of reported methods</small></div>
    <div class="metric"><span>Paper runtime</span><b>${paperAvgRuntime.toFixed(2)} ms</b><small>mean across all methods/images</small></div>
    <div class="metric"><span>Our prototype</span><b>3 bpp</b><small>Hamming-syndrome payload / source pixel</small></div>`;

  const labels=images;
  const chartData=images.map(t=>metric==='runtime'?PAPER_RUNTIME[t]:PAPER_EMBED[t]);
  const isRuntime=metric==='runtime';
  $('analysisChartTitle').textContent=isRuntime?'Encryption runtime reported in the paper (lower is better)':'Embedding rate reported in the paper (higher is better)';
  analysisCharts.forEach(c=>c.destroy());analysisCharts=[];
  analysisCharts.push(new Chart($('analysisMainChart'),{type:'bar',data:{labels,datasets:METHODS.map((m,i)=>({label:m,data:chartData.map(v=>v[i])}))},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,title:{display:true,text:isRuntime?'milliseconds':'bits per pixel'}}}}}));
  analysisCharts.push(new Chart($('analysisRuntimeChart'),{type:'line',data:{labels:PAPER_IMAGES,datasets:METHODS.map((m,i)=>({label:m,data:PAPER_IMAGES.map(t=>PAPER_RUNTIME[t][i]),tension:.2}))},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true}}}}));
  const stability=PAPER_IMAGES.map(t=>PAPER_EMBED[t]);
  const ranges=METHODS.map((m,i)=>Math.max(...stability.map(v=>v[i]))-Math.min(...stability.map(v=>v[i])));
  analysisCharts.push(new Chart($('analysisStabilityChart'),{type:'bar',data:{labels:methodLabels(),datasets:[{label:'Embedding-rate range across six images (lower = more stable)',data:ranges}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));
  analysisCharts.push(new Chart($('analysisPrototypeChart'),{type:'bar',data:{labels:['Base MRDHCBI','Our Hamming syndrome'],datasets:[{label:'Payload bpp',data:[1,3]},{label:'Stored bits / source pixel / share',data:[3,7]}]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true}}}}));

  $('analysisTable').innerHTML=`<table class="details"><tr><th>Image</th><th>Ren [12] bpp</th><th>Li [13] bpp</th><th>Zhang [14] bpp</th><th>Paper</th><th>Best reported bpp</th></tr>${PAPER_IMAGES.map(t=>{const v=PAPER_EMBED[t];return `<tr><td>${t}</td>${v.map(x=>`<td>${x.toFixed(2)}</td>`).join('')}<td><b>${Math.max(...v).toFixed(2)}</b> • ${methodLabels()[v.indexOf(Math.max(...v))]}</td></tr>`}).join('')}</table><br><table class="details"><tr><th>Image</th><th>Ren ms</th><th>Li ms</th><th>Zhang ms</th><th>Paper ms</th><th>Lowest runtime</th></tr>${PAPER_IMAGES.map(t=>{const v=PAPER_RUNTIME[t];return `<tr><td>${t}</td>${v.map(x=>`<td>${x.toFixed(4)}</td>`).join('')}<td><b>${Math.min(...v).toFixed(4)}</b> • ${methodLabels()[v.indexOf(Math.min(...v))]}</td></tr>`}).join('')}</table>`;
  $('functionalTable').innerHTML=`<table class="details"><tr><th>Function</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Paper presented</th></tr>${FUNCTIONAL.map(r=>`<tr>${r.map((x,j)=>j===0?`<th>${x}</th>`:`<td>${x}</td>`).join('')}</tr>`).join('')}</table>`;
  const runtimeRanges=METHODS.map((m,i)=>{const a=PAPER_IMAGES.map(t=>PAPER_RUNTIME[t][i]);return Math.max(...a)-Math.min(...a)});
  const runtimeMeans=METHODS.map((m,i)=>PAPER_IMAGES.reduce((a,t)=>a+PAPER_RUNTIME[t][i],0)/PAPER_IMAGES.length);
  $('derivedTable').innerHTML=`<table class="details"><tr><th>Derived metric</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Paper presented</th></tr><tr><td>Mean embedding rate (bpp)</td>${METHODS.map((m,i)=>`<td>${(PAPER_IMAGES.reduce((a,t)=>a+PAPER_EMBED[t][i],0)/6).toFixed(3)}</td>`).join('')}</tr><tr><td>Embedding-rate range (lower = more stable)</td>${ranges.map(x=>`<td>${x.toFixed(2)}</td>`).join('')}</tr><tr><td>Mean encryption runtime (ms)</td>${runtimeMeans.map(x=>`<td>${x.toFixed(3)}</td>`).join('')}</tr><tr><td>Runtime range (lower = more stable)</td>${runtimeRanges.map(x=>`<td>${x.toFixed(3)}</td>`).join('')}</tr></table>
      <p class="hint analysis-footnote">Paper-derived values are transcribed from Fig. 3 and Table I. The representative thumbnails are category illustrations; the exact six BMP files named by the paper are not included in the current project ZIP. No unreported experimental result is presented as a paper result.</p>`;
}

$('newTxBtn').onclick=()=>location.reload();

// Live benchmark for the user's proposed Hamming-syndrome method.
async function runHammingBenchmark(){
  const input=$('analysisBenchmarkInput');
  if(!input || !input.files[0]){alert('Choose a binary/grayscale test image first.');return;}
  const btn=$('runHammingBenchmark');
  btn.disabled=true;
  $('hammingBenchmarkStatus').textContent='Running the actual Hamming-syndrome pipeline…';
  try{
    const image=await loadBinaryImage(input.files[0]);
    const N=image.width*image.height;
    // Deterministic 3-bit payload per source pixel, so payload recovery can be measured exactly.
    const payload=new Uint8Array(N*3);
    for(let i=0;i<payload.length;i++) payload[i]=((i*1103515245+12345)>>>16)&1;

    const t0=performance.now();
    const shares=vcEncrypt(image.bits,image.width,image.height,2026);
    const t1=performance.now();
    const marked=shares.map(s=>syndromeEmbed(s,payload,image.width,image.height));
    const t2=performance.now();
    const extracted=marked.map(s=>syndromeExtractRestore(s,image.width,image.height));
    const recovered=vcRecover(extracted[0].restored,extracted[1].restored,image.width,image.height);
    const t3=performance.now();

    const payloadPct=byteAccuracy(payload,extracted[0].payload);
    const imagePct=imageAccuracy(recovered,image.bits);
    const perShareBits=marked[0].length;
    const totalStoredBits=perShareBits*3;
    const basePerShareBits=N*3;
    const metrics={
      image:`${image.width} × ${image.height}`,
      pixels:N,
      capacity:3,
      perShareStored:7,
      totalStoredPerPixel:21,
      storageExpansion:totalStoredBits/N,
      encryptionMs:t1-t0,
      embeddingMs:t2-t1,
      extractionRecoveryMs:t3-t2,
      totalMs:t3-t0,
      imageRecovery:imagePct,
      imageExact:sameBits(recovered,image.bits),
      payloadRecovery:payloadPct,
      payloadExact:sameBits(extracted[0].payload,payload),
      correctedErrors:extracted.reduce((a,x)=>a+x.correctedCodeErrors,0)
    };

    $('hammingBenchmarkSummary').innerHTML=`
      <div class="metric"><span>Embedding capacity</span><b>3.00 bpp</b><small>3 payload bits / source pixel</small></div>
      <div class="metric"><span>Stored per share</span><b>7.00 bits/px</b><small>Hamming(7,4)</small></div>
      <div class="metric"><span>Image recovery</span><b>${metrics.imageRecovery.toFixed(2)}%</b><small>${metrics.imageExact?'exact':'not exact'}</small></div>
      <div class="metric"><span>Payload recovery</span><b>${metrics.payloadRecovery.toFixed(2)}%</b><small>${metrics.payloadExact?'exact':'not exact'}</small></div>
      <div class="metric"><span>Total runtime</span><b>${metrics.totalMs.toFixed(2)} ms</b><small>encryption + embed + extraction/recovery</small></div>
      <div class="metric"><span>Total storage</span><b>${metrics.storageExpansion.toFixed(1)}×</b><small>across 3 marked shares vs source pixels</small></div>`;

    if(window.__hammingRuntimeChart)window.__hammingRuntimeChart.destroy();
    window.__hammingRuntimeChart=new Chart($('hammingRuntimeChart'),{type:'bar',data:{labels:['VC encryption','Hamming embedding','Extraction + recovery','Total'],datasets:[{label:'Runtime (ms)',data:[metrics.encryptionMs,metrics.embeddingMs,metrics.extractionRecoveryMs,metrics.totalMs]}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}});

    const corruptionLevels=[0,1,2,5,10];
    const imgScores=[],payloadScores=[];
    for(let ci=0;ci<corruptionLevels.length;ci++){
      const pct=corruptionLevels[ci];
      const tx=marked.map((s,i)=>pct?corruptBits(s,pct,9000+i):s);
      const ex=tx.map(s=>syndromeExtractRestore(s,image.width,image.height));
      const rec=vcRecover(ex[0].restored,ex[1].restored,image.width,image.height);
      imgScores.push(imageAccuracy(rec,image.bits));
      payloadScores.push(byteAccuracy(payload,ex[0].payload));
    }
    if(window.__hammingCorruptionChart)window.__hammingCorruptionChart.destroy();
    window.__hammingCorruptionChart=new Chart($('hammingCorruptionChart'),{type:'line',data:{labels:corruptionLevels.map(x=>x+'%'),datasets:[{label:'Image recovery %',data:imgScores,tension:.2},{label:'Payload recovery %',data:payloadScores,tension:.2}]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{min:0,max:100}}}});

    $('hammingBenchmarkTable').innerHTML=`<table class="details"><tr><th>Metric</th><th>Measured result</th><th>Interpretation</th></tr>
      <tr><td>Image</td><td>${escapeHtml(input.files[0].name)} (${metrics.image})</td><td>Actual uploaded test image</td></tr>
      <tr><td>Payload capacity</td><td>3 bpp</td><td>3 payload bits per original image pixel</td></tr>
      <tr><td>Marked share width</td><td>7× original width</td><td>Hamming(7,4) codeword per 3-bit VC block</td></tr>
      <tr><td>Storage expansion</td><td>${metrics.storageExpansion.toFixed(1)}×</td><td>Three 7-bit shares per source pixel</td></tr>
      <tr><td>Image recovery</td><td>${metrics.imageRecovery.toFixed(4)}% (${metrics.imageExact?'exact':'not exact'})</td><td>Recovered from two restored shares</td></tr>
      <tr><td>Payload recovery</td><td>${metrics.payloadRecovery.toFixed(4)}% (${metrics.payloadExact?'exact':'not exact'})</td><td>Compared with deterministic 3-bit/pixel payload</td></tr>
      <tr><td>Encryption time</td><td>${metrics.encryptionMs.toFixed(4)} ms</td><td>Browser runtime</td></tr>
      <tr><td>Embedding time</td><td>${metrics.embeddingMs.toFixed(4)} ms</td><td>Browser runtime</td></tr>
      <tr><td>Extraction + recovery</td><td>${metrics.extractionRecoveryMs.toFixed(4)} ms</td><td>Browser runtime</td></tr>
      <tr><td>Corrected Hamming errors</td><td>${metrics.correctedErrors}</td><td>At 0% corruption, expected to be zero</td></tr>
    </table>`;
    $('hammingBenchmarkStatus').textContent=`Benchmark complete for ${input.files[0].name}. These values were measured by running your Hamming-syndrome implementation in this browser; they are not paper-reported values.`;
  }catch(e){
    console.error(e);
    $('hammingBenchmarkStatus').textContent='Benchmark failed: '+e.message;
    alert('Hamming benchmark failed: '+e.message);
  }finally{btn.disabled=false;}
}

if($('runHammingBenchmark'))$('runHammingBenchmark').onclick=runHammingBenchmark;
