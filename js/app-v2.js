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
const METHODS=['Ren et al. [12]','Li et al. [13]','Zhang et al. [14]','Base MRDHCBI (paper)','Our Hamming'];
// Fig. 3 values are read from the paper; Table I values are transcribed exactly.
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
  ['Embedding space','Correlation','Correlation','Correlation','Encryption','Hamming syndrome / VC'],
  ['Preprocessing','Yes','Yes','Yes','No','No'],
  ['Encryption','Stream cipher','Stream cipher','Stream cipher','Visual cryptography','Visual cryptography'],
  ['Data hider','Single','Single','Single','Multiple','Multiple'],
  ['Lossless recovery','Required','Required','Required','Yes (k-of-n)','Yes (k-of-n)']
];

function methodName(i){return METHODS[i]}
function methodBest(values,lower=false){
  const idx=lower?values.indexOf(Math.min(...values)):values.indexOf(Math.max(...values));
  return `${METHODS[idx]} • ${values[idx].toFixed(2)}`;
}

// The supplied project does not contain the six original BMP files.  To keep Analysis
// completely automatic (no upload/key), these are deterministic binary category replicas.
// The literature values remain the paper's reported values; our/base results are executed live.
function categoryBits(type,w=128,h=128){
  const b=new Uint8Array(w*h);
  const set=(x,y,v=1)=>{if(x>=0&&x<w&&y>=0&&y<h)b[y*w+x]=v};
  if(type==='Cartoon'){
    const cx=w/2,cy=h/2,r=43;
    for(let y=0;y<h;y++)for(let x=0;x<w;x++){const d=Math.hypot(x-cx,y-cy);if(d<r)set(x,y);}
    for(let y=46;y<60;y++)for(let x=43;x<56;x++)set(x,y,0); for(let y=46;y<60;y++)for(let x=72;x<85;x++)set(x,y,0);
    for(let y=82;y<87;y++)for(let x=52;x<76;x++)set(x,y,0);
  } else if(type==='CAD'){
    for(let x=16;x<112;x++){set(x,18);set(x,109)} for(let y=18;y<110;y++){set(16,y);set(111,y)}
    for(let t=0;t<96;t++){set(16+t,109-t);set(16+t,18+Math.floor(t*.45));}
    for(let x=25;x<103;x+=13)for(let y=28;y<100;y+=13)for(let d=0;d<3;d++){set(x+d,y);set(x,y+d)}
  } else if(type==='Texture'){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(((x*37+y*61+x*y)%17)<8)set(x,y);
  } else if(type==='Mask'){
    const cx=w/2,cy=h/2;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const dx=(x-cx)/45,dy=(y-cy)/52;if(dx*dx+dy*dy<1)set(x,y);}
    for(let y=48;y<59;y++)for(let x=43;x<57;x++)set(x,y,0);for(let y=48;y<59;y++)for(let x=71;x<85;x++)set(x,y,0);
  } else if(type==='Pattern'){
    for(let y=8;y<h;y+=24)for(let x=8;x<w;x+=24){for(let d=0;d<15;d++){set(x+d,y+d);set(x+14-d,y+d);}}
  } else {
    // document-like text lines
    for(let y=16;y<116;y+=14){let len=(y%28===16)?90:78;for(let x=18;x<18+len;x++){if(((x*13+y*7)%19)<13)set(x,y);}}
    for(let y=20;y<112;y+=28)for(let x=18;x<36;x+=3)set(x,y,1);
  }
  return b;
}
function bitsCanvas(bits,w,h,scale=1){return binaryToCanvas(bits,w,h,scale).toDataURL()}
function makeCategoryCard(type){
  const bits=categoryBits(type); const w=128,h=128;
  const shares=vcEncrypt(bits,w,h,1000+PAPER_IMAGES.indexOf(type));
  const basePayload=new Uint8Array(w*h);for(let i=0;i<basePayload.length;i++)basePayload[i]=(i*17+PAPER_IMAGES.indexOf(type))%2;
  const baseMarked=baseEmbed(shares[0],basePayload,w,h);
  const hamPayload=new Uint8Array(w*h*3);for(let i=0;i<hamPayload.length;i++)hamPayload[i]=(i*31+7)%2;
  const hamMarked=syndromeEmbed(shares[0],hamPayload,w,h);
  return `<div class="analysis-experiment-card">
    <div class="analysis-experiment-head"><b>${type}</b><span>${PAPER_FILES[type]} • paper category</span></div>
    <div class="analysis-thumb-grid">
      <figure><img src="${bitsCanvas(bits,w,h,1)}"><figcaption>Original</figcaption></figure>
      <figure><img src="${bitsCanvas(baseMarked, w*3,h,1)}"><figcaption>Base MRDHCBI<br>1 bpp</figcaption></figure>
      <figure><img src="${bitsCanvas(hamMarked,w*7,h,1)}"><figcaption>Our Hamming<br>3 bpp</figcaption></figure>
    </div>
    <div class="analysis-experiment-stats"><span>Base payload: ${(w*h/8/1024).toFixed(2)} KB</span><span>Hamming payload: ${(w*h*3/8/1024).toFixed(2)} KB</span><span>Shares: 3</span></div>
  </div>`;
}
async function runUnifiedOurMethod(){
  const results={};
  for(const type of PAPER_IMAGES){
    const w=128,h=128,bits=categoryBits(type),N=w*h;
    const payload=new Uint8Array(N*3);for(let i=0;i<payload.length;i++)payload[i]=(i*31+7)%2;
    const t0=performance.now();const shares=vcEncrypt(bits,w,h,1000+PAPER_IMAGES.indexOf(type));const enc=performance.now()-t0;
    const t1=performance.now();const marked=shares.map(s=>syndromeEmbed(s,payload,w,h));const embed=performance.now()-t1;
    const t2=performance.now();const restored=marked.map(s=>syndromeExtractRestore(s,w,h));const rec=vcRecover(restored[0].restored,restored[1].restored,w,h);const ext=performance.now()-t2;
    let exact=0;for(let i=0;i<N;i++)if(rec[i]===bits[i])exact++;
    let pexact=0;for(let i=0;i<payload.length;i++)if(restored[0].payload[i]===payload[i])pexact++;
    results[type]={bpp:3,stored:7,encryptionMs:enc,embeddingMs:embed,extractionMs:ext,totalMs:enc+embed+ext,imageRecovery:exact/N*100,payloadRecovery:pexact/payload.length*100,exactImage:exact===N,exactPayload:pexact===payload.length};
  }
  return results;
}
async function renderUnifiedAnalysis(){
  $('analysisImages').innerHTML=PAPER_IMAGES.map(makeCategoryCard).join('');
  $('analysisSummary').innerHTML=`
    <div class="metric"><span>Test categories</span><b>6</b><small>same six categories named by the paper</small></div>
    <div class="metric"><span>Base MRDHCBI</span><b>1.00 bpp</b><small>paper method</small></div>
    <div class="metric"><span>Our Hamming</span><b>3.00 bpp</b><small>3 payload bits / source pixel</small></div>
    <div class="metric"><span>Recovery target</span><b>100%</b><small>exact reversible recovery</small></div>`;
  const our=await runUnifiedOurMethod();
  const ourEmbed=PAPER_IMAGES.map(()=>3);
  const ourRuntime=PAPER_IMAGES.map(t=>our[t].totalMs);
  const baseEmbed=PAPER_IMAGES.map(()=>1);
  const baseRuntime=PAPER_IMAGES.map(t=>PAPER_RUNTIME[t][3]);
  analysisCharts.forEach(c=>c.destroy());analysisCharts=[];
  analysisCharts.push(new Chart($('analysisMainChart'),{type:'bar',data:{labels:PAPER_IMAGES,datasets:[
    {label:'Ren [12] (paper)',data:PAPER_IMAGES.map(t=>PAPER_EMBED[t][0])},{label:'Li [13] (paper)',data:PAPER_IMAGES.map(t=>PAPER_EMBED[t][1])},{label:'Zhang [14] (paper)',data:PAPER_IMAGES.map(t=>PAPER_EMBED[t][2])},{label:'Base MRDHCBI (paper)',data:baseEmbed},{label:'Our Hamming (implemented)',data:ourEmbed}
  ]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,title:{display:true,text:'Embedding rate (bpp)'}}}}}));
  analysisCharts.push(new Chart($('analysisRuntimeChart'),{type:'bar',data:{labels:PAPER_IMAGES,datasets:[
    {label:'Ren [12]',data:PAPER_IMAGES.map(t=>PAPER_RUNTIME[t][0])},{label:'Li [13]',data:PAPER_IMAGES.map(t=>PAPER_RUNTIME[t][1])},{label:'Zhang [14]',data:PAPER_RUNTIME[t][2]},{label:'Base MRDHCBI',data:baseRuntime},{label:'Our Hamming — browser run',data:ourRuntime}
  ]},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,title:{display:true,text:'Runtime (ms)'}}}}}));
  const embedRanges=[...Array(3)].map(i=>{const v=PAPER_IMAGES.map(t=>PAPER_EMBED[t][i]);return Math.max(...v)-Math.min(...v)}).concat(0,0);
  analysisCharts.push(new Chart($('analysisStabilityChart'),{type:'bar',data:{labels:METHODS,datasets:[{label:'Embedding-rate range across six categories (lower = more stable)',data:embedRanges}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));
  analysisCharts.push(new Chart($('analysisPrototypeChart'),{type:'bar',data:{labels:METHODS,datasets:[{label:'Payload density (bpp)',data:[...PAPER_IMAGES.map(()=>0),1,3]}]},options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}}));
  $('analysisChartTitle').textContent='Embedding rate — all methods on the same six paper categories';
  $('analysisTable').innerHTML=`<table class="details"><tr><th>Image</th>${METHODS.map(m=>`<th>${m}</th>`).join('')}<th>Best bpp</th></tr>${PAPER_IMAGES.map(t=>{const v=[...PAPER_EMBED[t],3];return `<tr><td>${t}</td>${v.map(x=>`<td>${x.toFixed(2)}</td>`).join('')}<td>${Math.max(...v).toFixed(2)} • ${METHODS[v.indexOf(Math.max(...v))]}</td></tr>`}).join('')}</table>
  <br><table class="details"><tr><th>Image</th>${METHODS.map(m=>`<th>${m}</th>`).join('')}</tr>${PAPER_IMAGES.map(t=>{const v=[...PAPER_RUNTIME[t],our[t].totalMs];return `<tr><td>${t}</td>${v.map((x,i)=>`<td>${x.toFixed(3)}${i===4?'*':''}</td>`).join('')}</tr>`}).join('')}</table>`;
  $('functionalTable').innerHTML=`<table class="details"><tr><th>Function</th>${METHODS.map(m=>`<th>${m}</th>`).join('')}</tr>${FUNCTIONAL.map(r=>`<tr><td>${r[0]}</td>${r.slice(1).map(x=>`<td>${x}</td>`).join('')}</tr>`).join('')}</table>`;
  const avgOurRuntime=ourRuntime.reduce((a,b)=>a+b,0)/ourRuntime.length;
  $('derivedTable').innerHTML=`<table class="details"><tr><th>Metric</th><th>Base MRDHCBI</th><th>Our Hamming</th><th>Interpretation</th></tr>
  <tr><td>Payload density</td><td>1.00 bpp</td><td>3.00 bpp</td><td>Higher payload density for our method</td></tr>
  <tr><td>Stored bits / source pixel / share</td><td>3</td><td>7</td><td>Our method trades storage expansion for capacity</td></tr>
  <tr><td>Storage expansion</td><td>3×</td><td>7×</td><td>Lower is preferable when capacity is held constant</td></tr>
  <tr><td>Exact image recovery</td><td>100% by design</td><td>${PAPER_IMAGES.every(t=>our[t].exactImage)?'100%':'Measured below 100%'}</td><td>Measured on the six automatic category replicas</td></tr>
  <tr><td>Exact payload recovery</td><td>100% under valid channel</td><td>${PAPER_IMAGES.every(t=>our[t].exactPayload)?'100%':'Measured below 100%'}</td><td>Measured on the three-bit payload</td></tr>
  <tr><td>Our mean browser runtime</td><td>Paper reported: ${(PAPER_IMAGES.map(t=>PAPER_RUNTIME[t][3]).reduce((a,b)=>a+b,0)/6).toFixed(3)} ms</td><td>${avgOurRuntime.toFixed(3)} ms*</td><td>*Different runtime environment; not a fair hardware-normalized comparison</td></tr></table>
  <p class="hint analysis-footnote">Paper values are reported/transcribed from Fig. 3 and Table I. Ren/Li/Zhang are not reimplemented in this browser; their values are literature results. Base MRDHCBI uses the paper's 1 bpp design. Our Hamming method is executed automatically on deterministic binary replicas of the six paper categories because the exact six BMP files are not contained in the supplied project. No pairing key or user-uploaded image is required.</p>`;
  $('analysisPanel').scrollIntoView({behavior:'smooth'});
}
function renderAnalysis(){renderUnifiedAnalysis().catch(e=>{console.error(e);$('analysisSummary').innerHTML=`<div class="metric"><span>Analysis error</span><b>See console</b><small>${escapeHtml(e.message)}</small></div>`});}
$('newTxBtn').onclick=()=>location.reload();
