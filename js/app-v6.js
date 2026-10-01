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
      <div class="metric"><span>Image recovery</span><b>${verifiedImagePct.toFixed(2)}%</b><small>reported by sender (pixel-level)</small></div>
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

// ---------------------------------------------------------------------------
// Dashboard (sender + receiver)
// ---------------------------------------------------------------------------

function dashboardPalette(){
  const dark=document.documentElement.dataset.theme==='dark';
  return dark?['#63d6bd','#d59bf6']:['#147d6a','#7b2cbf']; // [Base, Proposed]
}

function drawDashboardCharts(meta){
  const p=meta.proposed||{},b=meta.base;
  const pal=dashboardPalette();
  const ds=(label,data)=>[{label,data,backgroundColor:pal,borderColor:pal,borderWidth:1,borderRadius:6,maxBarThickness:90}];
  charts.forEach(c=>c.destroy());charts=[];
  charts.push(new Chart($('capacityChart'),{
    type:'bar',
    data:{labels:['Base','Proposed'],datasets:ds('Payload capacity (bits/source pixel)',[1,3])},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}
  }));
  charts.push(new Chart($('recoveryChart'),{
    type:'bar',
    // null (not 0) when the base method could not fit the document, so the bar is skipped instead of reading as a failure.
    data:{labels:['Base','Proposed'],datasets:ds('Image recovery %',[b?b.imageRecoveryPct:null,p.imageRecoveryPct??0])},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{min:0,max:100}}}
  }));
  charts.push(new Chart($('storageChart'),{
    type:'bar',
    data:{labels:['Base','Proposed'],datasets:ds('Stored bits / source pixel',[3,7])},
    options:{responsive:true,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true}}}
  }));
}

function renderDashboard(meta,who,noScroll=false){
  window.lastDash={meta,who};
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
  drawDashboardCharts(meta);
  if(!noScroll)$('dashboard').scrollIntoView({behavior:'smooth'});
}


// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

const PAPER_IMAGES=['Cartoon','CAD','Texture','Mask','Pattern','Document'];
const PAPER_FILES={Cartoon:'Cartoon183.bmp',CAD:'CAD487.bmp',Texture:'Texture760.bmp',Mask:'Mask1001.bmp',Pattern:'Pattern1704.bmp',Document:'Document3060.bmp'};
const METHODS=['Ren et al. [12]','Li et al. [13]','Zhang et al. [14]','Base MRDHCBI','Our Hamming'];
const FUNCTIONAL=[
  ['Core mechanism','Uniform/non-uniform blocks + T-pattern prediction','Pure/non-pure blocks + cross segmentation + halving compression','Black/white/mixed blocks + Huffman coding + weight prediction','(2,3) visual cryptography + Hamming-weight extraction','(2,3) visual cryptography + Hamming(7,4) syndrome embedding'],
  ['Preprocessing','Required','Required','Required','None before VC encryption','None before VC encryption'],
  ['Encryption','Stream-cipher XOR model','Stream-cipher XOR model','Stream-cipher XOR model','Visual cryptography','Visual cryptography'],
  ['Data hiders','Single','Single','Single','Multiple','Multiple'],
  ['Recovery target','Prediction-based; lossless extension','Lossless','Lossless','k-of-n lossless','k-of-n lossless']
];

function categoryBits(type,w=128,h=128){
  const b=new Uint8Array(w*h),set=(x,y,v=1)=>{if(x>=0&&x<w&&y>=0&&y<h)b[y*w+x]=v};
  if(type==='Cartoon'){
    const cx=w/2,cy=h/2,r=43;for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(Math.hypot(x-cx,y-cy)<r)set(x,y);
    for(let y=46;y<60;y++)for(let x=43;x<56;x++)set(x,y,0);for(let y=46;y<60;y++)for(let x=72;x<85;x++)set(x,y,0);for(let y=82;y<87;y++)for(let x=52;x<76;x++)set(x,y,0);
  } else if(type==='CAD'){
    for(let x=16;x<112;x++){set(x,18);set(x,109)}for(let y=18;y<110;y++){set(16,y);set(111,y)}for(let t=0;t<96;t++){set(16+t,109-t);set(16+t,18+Math.floor(t*.45))}for(let x=25;x<103;x+=13)for(let y=28;y<100;y+=13)for(let d=0;d<3;d++){set(x+d,y);set(x,y+d)}
  } else if(type==='Texture'){
    for(let y=0;y<h;y++)for(let x=0;x<w;x++)if(((x*37+y*61+x*y)%17)<8)set(x,y);
  } else if(type==='Mask'){
    const cx=w/2,cy=h/2;for(let y=0;y<h;y++)for(let x=0;x<w;x++){const dx=(x-cx)/45,dy=(y-cy)/52;if(dx*dx+dy*dy<1)set(x,y)}for(let y=48;y<59;y++)for(let x=43;x<57;x++)set(x,y,0);for(let y=48;y<59;y++)for(let x=71;x<85;x++)set(x,y,0);
  } else if(type==='Pattern'){
    for(let y=8;y<h;y+=24)for(let x=8;x<w;x+=24)for(let d=0;d<15;d++){set(x+d,y+d);set(x+14-d,y+d)}
  } else {
    for(let y=16;y<116;y+=14){const len=(y%28===16)?90:78;for(let x=18;x<18+len;x++)if(((x*13+y*7)%19)<13)set(x,y)}for(let y=20;y<112;y+=28)for(let x=18;x<36;x+=3)set(x,y,1);
  }
  return b;
}
function bitsCanvas(bits,w,h,scale=1){return binaryToCanvas(bits,w,h,scale).toDataURL()}
function makeCategoryCard(type){const bits=categoryBits(type);return `<div class="analysis-experiment-card"><div class="analysis-experiment-head"><b>${type}</b><span>${PAPER_FILES[type]} • category replica</span></div><figure class="analysis-original-only"><img src="${bitsCanvas(bits,128,128,1)}" class="analysis-original-img" alt="${type} original"><figcaption>Original binary image</figcaption></figure></div>`}

async function runUnifiedMeasuredMethods(){
  const results={};
  for(const type of PAPER_IMAGES){
    const bits=categoryBits(type),w=128,h=128,N=w*h;
    const vc0=performance.now();vcEncrypt(bits,w,h,7000+PAPER_IMAGES.indexOf(type));const vcMs=performance.now()-vc0;
    const basePayload=new Uint8Array(N);for(let i=0;i<N;i++)basePayload[i]=(i*31+7)&1;
    const hamPayload=new Uint8Array(N*3);for(let i=0;i<hamPayload.length;i++)hamPayload[i]=(i*31+7)&1;
    const e0=performance.now();const shares=vcEncrypt(bits,w,h,8000+PAPER_IMAGES.indexOf(type));const encMs=performance.now()-e0;
    const b0=performance.now();const marked=shares.map(s=>baseEmbed(s,basePayload,w,h));const bEmb=performance.now()-b0;
    const bx=performance.now();const restored=marked.map(s=>restoreBaseShare(s,w,h));const rec=vcRecover(restored[0],restored[1],w,h);const out=baseExtract(marked[0],w,h);const bExt=performance.now()-bx;
    const h0=performance.now();const hMarked=shares.map(s=>syndromeEmbed(s,hamPayload,w,h));const hEmb=performance.now()-h0;
    const hx=performance.now();const hRest=hMarked.map(s=>syndromeExtractRestore(s,w,h));const hRec=vcRecover(hRest[0].restored,hRest[1].restored,w,h);const hOut=hRest[0].payload;const hExt=performance.now()-hx;
    results[type]={
      ren:benchmarkRen(bits,w,h),li:benchmarkLi(bits,w,h),zhang:benchmarkZhang(bits,w,h),
      base:{bpp:1,capacityBits:N,stored:3,auxBits:0,encryptionMs:encMs,embeddingMs:bEmb,extractionMs:bExt,totalMs:encMs+bEmb+bExt,imageRecovery:imageAccuracy(rec,bits),payloadRecovery:imageAccuracy(out,basePayload),exactImage:sameBits(rec,bits),exactPayload:sameBits(out,basePayload)},
      hamming:{bpp:3,capacityBits:N*3,stored:7,auxBits:0,encryptionMs:encMs,embeddingMs:hEmb,extractionMs:hExt,totalMs:encMs+hEmb+hExt,imageRecovery:imageAccuracy(hRec,bits),payloadRecovery:imageAccuracy(hOut,hamPayload),exactImage:sameBits(hRec,bits),exactPayload:sameBits(hOut,hamPayload)}
    };
  }
  return results;
}
function mean(a){return a.reduce((x,y)=>x+y,0)/a.length}
function stability(method,measured){const vals=PAPER_IMAGES.map(t=>measured[t][method].bpp);return Math.max(...vals)-Math.min(...vals)}
function statusBadge(r){return r.exactImage&&r.exactPayload?'<span class="ok-badge">Exact</span>':'<span class="warn-badge">Check</span>'}
function renderMeasuredTable(measured){
  const rows=PAPER_IMAGES.map(t=>`<tr><td>${t}</td>${['ren','li','zhang','base','hamming'].map(k=>`<td>${measured[t][k].bpp.toFixed(4)}</td>`).join('')}</tr>`).join('');
  const rtRows=PAPER_IMAGES.map(t=>`<tr><td>${t}</td>${['ren','li','zhang','base','hamming'].map(k=>`<td>${measured[t][k].totalMs.toFixed(3)}</td>`).join('')}</tr>`).join('');
  const capRows=PAPER_IMAGES.map(t=>`<tr><td>${t}</td>${['ren','li','zhang','base','hamming'].map(k=>`<td>${measured[t][k].capacityBits}</td>`).join('')}</tr>`).join('');
  const recRows=PAPER_IMAGES.map(t=>`<tr><td>${t}</td>${['ren','li','zhang','base','hamming'].map(k=>`<td>${measured[t][k].imageRecovery.toFixed(2)}% ${statusBadge(measured[t][k])}</td>`).join('')}</tr>`).join('');
  $('analysisTable').innerHTML=`
    <h3>Embedding rate — measured from implementations</h3><p class="hint">bpp = embedded payload bits ÷ original source pixels. Every value below is generated by executing the corresponding implementation in this project; no paper result is copied into the table.</p>
    <table class="details"><tr><th>Image</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Base MRDHCBI</th><th>Our Hamming</th></tr>${rows}<tr><th>Mean</th>${['ren','li','zhang','base','hamming'].map(k=>`<th>${mean(PAPER_IMAGES.map(t=>measured[t][k].bpp)).toFixed(4)}</th>`).join('')}</tr></table>
    <h3 style="margin-top:24px">Encryption / processing runtime (ms)</h3><p class="hint">Wall-clock time measured in the same browser session. This is a reproducible software-runtime comparison, not the MATLAB/i5 setup used in the paper.</p>
    <table class="details"><tr><th>Image</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Base MRDHCBI</th><th>Our Hamming</th></tr>${rtRows}<tr><th>Mean</th>${['ren','li','zhang','base','hamming'].map(k=>`<th>${mean(PAPER_IMAGES.map(t=>measured[t][k].totalMs)).toFixed(3)}</th>`).join('')}</tr></table>
    <h3 style="margin-top:24px">Payload capacity (bits)</h3><table class="details"><tr><th>Image</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Base MRDHCBI</th><th>Our Hamming</th></tr>${capRows}</table>
    <h3 style="margin-top:24px">Exact image recovery</h3><table class="details"><tr><th>Image</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Base MRDHCBI</th><th>Our Hamming</th></tr>${recRows}</table>`;
}
async function renderUnifiedAnalysis(){
  $('analysisImages').innerHTML=PAPER_IMAGES.map(makeCategoryCard).join('');
  $('analysisSummary').innerHTML=`<div class="metric"><span>Evaluation</span><b>5 executable methods</b><small>all values measured locally</small></div><div class="metric"><span>Categories</span><b>6</b><small>same named categories as the paper</small></div><div class="metric"><span>Base MRDHCBI</span><b>1.00 bpp</b><small>executed VC baseline</small></div><div class="metric"><span>Our Hamming</span><b>3.00 bpp</b><small>executed syndrome method</small></div><div class="metric"><span>Runtime unit</span><b>ms</b><small>browser wall-clock measurement</small></div>`;
  const measured=await runUnifiedMeasuredMethods();
  const key=['ren','li','zhang','base','hamming'];
  analysisCharts.forEach(c=>c.destroy());analysisCharts=[];
  const dark=document.documentElement.dataset.theme==='dark'; const colors=dark?['#d59bf6','#ff8f78','#f4cf70','#63d6bd','#f0e7dc']:['#7b2cbf','#c94f38','#b27a18','#147d6a','#3d342d'];
  const ds=key.map((k,i)=>({label:METHODS[i],data:PAPER_IMAGES.map(t=>measured[t][k].bpp),backgroundColor:colors[i]}));
  analysisCharts.push(new Chart($('analysisMainChart'),{type:'bar',data:{labels:PAPER_IMAGES,datasets:ds},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,title:{display:true,text:'Measured embedding rate (bpp)'}}}}}));
  analysisCharts.push(new Chart($('analysisRuntimeChart'),{type:'bar',data:{labels:PAPER_IMAGES,datasets:key.map((k,i)=>({label:METHODS[i],data:PAPER_IMAGES.map(t=>measured[t][k].totalMs),backgroundColor:colors[i]}))},options:{responsive:true,plugins:{legend:{position:'bottom'}},scales:{y:{beginAtZero:true,title:{display:true,text:'Wall-clock runtime (ms)'}}}}}));
  const st=key.map(k=>stability(k,measured));
  analysisCharts.push(new Chart($('analysisStabilityChart'),{type:'bar',data:{labels:METHODS,datasets:[{label:'Embedding-rate range',data:st,backgroundColor:colors}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,title:{display:true,text:'Max − min across six categories (bpp)'}}}}}));
  const density=key.map(k=>mean(PAPER_IMAGES.map(t=>measured[t][k].bpp)));
  analysisCharts.push(new Chart($('analysisPrototypeChart'),{type:'bar',data:{labels:METHODS,datasets:[{label:'Mean measured payload density',data:density,backgroundColor:colors}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},scales:{y:{beginAtZero:true,title:{display:true,text:'Mean measured payload density (bpp)'}}}}}));
  renderMeasuredTable(measured);
  const functionalHeader=METHODS.map(m=>`<th>${escapeHtml(m)}</th>`).join('');
  const functionalRows=FUNCTIONAL.map(r=>`<tr><td>${escapeHtml(r[0])}</td>${r.slice(1).map(v=>`<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('');
  $('functionalTable').innerHTML=`<table class="details"><tr><th>Feature</th>${functionalHeader}</tr>${functionalRows}</table><p class="hint source-note">Methodology basis: Ren et al. [12] uses uniform/non-uniform blocks and T-pattern prediction; Li et al. [13] uses pure/non-pure blocks, cross segmentation and halving compression; Zhang et al. [14] uses black/white/mixed blocks, Huffman coding and weight prediction. The implementations here are executable reference implementations of those mechanisms, with parameters fixed for a reproducible course-project comparison.</p>`;
  const derivedRows=['bpp','capacityBits','stored','auxBits','imageRecovery','payloadRecovery','totalMs'].map(metric=>{const label={bpp:'Embedding rate',capacityBits:'Payload capacity',stored:'Stored bits / source pixel',auxBits:'Auxiliary bits accounted',imageRecovery:'Exact recovery percentage',payloadRecovery:'Payload recovery percentage',totalMs:'Total processing time'}[metric];return `<tr><td>${label}</td><td>${mean(PAPER_IMAGES.map(t=>measured[t].base[metric])).toFixed(metric==='totalMs'?3:4)}</td><td>${mean(PAPER_IMAGES.map(t=>measured[t].hamming[metric])).toFixed(metric==='totalMs'?3:4)}</td></tr>`}).join('');
  $('derivedTable').innerHTML=`<h3>Measured Base vs Hamming</h3><table class="details"><tr><th>Metric</th><th>Base MRDHCBI</th><th>Our Hamming</th></tr>${derivedRows}</table><p class="hint">No paper benchmark numbers are inserted into these measured tables. The six image inputs are deterministic category replicas because the exact BMP files named in the paper are not included in the project.</p>`;
  $('analysisChartTitle').textContent='Embedding rate — five executable methods';
  $('analysisPanel').scrollIntoView({behavior:'smooth'});
}
function renderAnalysis(){renderUnifiedAnalysis().catch(e=>{console.error(e);$('analysisSummary').innerHTML=`<div class="metric"><span>Analysis error</span><b>See console</b><small>${escapeHtml(e.message)}</small></div>`})}

function applyTheme(theme){
  document.documentElement.dataset.theme=theme;
  localStorage.setItem('mrdhcbi-theme',theme);
  const b=$('themeToggle');
  if(b)b.textContent=theme==='dark'?'Switch to light':'Switch to dark';
  if(typeof Chart!=='undefined'){
    Chart.defaults.color=theme==='dark'?'#d8cfc4':'#5f574e';
    Chart.defaults.borderColor=theme==='dark'?'#493b32':'#d8c9b3';
    Chart.defaults.font.family='Inter, system-ui, sans-serif';
  }
  // Redraw the Analysis charts if that panel is open.
  if(role==='analysis'&&document.getElementById('analysisPanel')&&!document.getElementById('analysisPanel').classList.contains('hidden'))
    setTimeout(()=>renderUnifiedAnalysis(),50);
  // Redraw the sender/receiver dashboard charts (no scroll jump) so bar colours follow the theme.
  if(window.lastDash&&!$('dashboard').classList.contains('hidden'))
    setTimeout(()=>drawDashboardCharts(window.lastDash.meta),50);
}
applyTheme(localStorage.getItem('mrdhcbi-theme')||'light');
$('themeToggle').onclick=()=>applyTheme(document.documentElement.dataset.theme==='dark'?'light':'dark');
$('newTxBtn').onclick=()=>location.reload();
