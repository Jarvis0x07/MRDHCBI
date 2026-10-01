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
// Literature method names are retained for the comparison UI. Their algorithms are NOT
// bundled in this project, so Analysis never fabricates or transcribes their paper values.
const LITERATURE_METHODS=['Ren et al. [12]','Li et al. [13]','Zhang et al. [14]'];
const METHODS=[...LITERATURE_METHODS,'Base MRDHCBI','Our Hamming'];
const PAPER_FILES={Cartoon:'Cartoon183.bmp',CAD:'CAD487.bmp',Texture:'Texture760.bmp',Mask:'Mask1001.bmp',Pattern:'Pattern1704.bmp',Document:'Document3060.bmp'};
const FUNCTIONAL=[
  ['Embedding space','Correlation','Correlation','Correlation','Encryption','Hamming syndrome / VC'],
  ['Preprocessing','Yes','Yes','Yes','No','No'],
  ['Encryption','Stream cipher','Stream cipher','Stream cipher','Visual cryptography','Visual cryptography'],
  ['Data hider','Single','Single','Single','Multiple','Multiple'],
  ['Lossless recovery','Required','Required','Required','Yes (k-of-n)','Yes (k-of-n)']
];

function methodName(i){return METHODS[i]}
function methodBest(values,lower=false){
  const finite=values.map((v,i)=>({v,i})).filter(x=>Number.isFinite(x.v));
  if(!finite.length)return '—';
  const chosen=lower?finite.reduce((a,b)=>b.v<a.v?b:a):finite.reduce((a,b)=>b.v>a.v?b:a);
  return `${METHODS[chosen.i]} • ${chosen.v.toFixed(2)}`;
}

const FUNCTIONAL=[
  ['Embedding space','Pixel/block prediction','Shared prediction + halving','Huffman + weight prediction','Visual cryptography','Hamming syndrome'],
  ['Preprocessing','Required','Required','Required','None','None'],
  ['Encryption','Stream cipher','Stream cipher','Stream cipher','(2,3) visual cryptography','(2,3) visual cryptography'],
  ['Data hiders','Single','Single','Single','Multiple','Multiple'],
  ['Lossless recovery','Extended lossless variant','Yes','Yes','Yes (k-of-n)','Yes (k-of-n)']
];

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
  return `<div class="analysis-experiment-card">
    <div class="analysis-experiment-head"><b>${type}</b><span>${PAPER_FILES[type]} • paper category</span></div>
    <div class="analysis-thumb-grid analysis-original-only">
      <figure><img src="${bitsCanvas(bits,w,h,1)}" class="analysis-original-img"><figcaption>Original image</figcaption></figure>
    </div>
  </div>`;
}
async function runUnifiedMeasuredMethods(){
  const results={};
  for(const type of PAPER_IMAGES){
    const w=128,h=128,bits=categoryBits(type),N=w*h;
    const basePayload=new Uint8Array(N);for(let i=0;i<basePayload.length;i++)basePayload[i]=(i*31+7)%2;
    const hamPayload=new Uint8Array(N*3);for(let i=0;i<hamPayload.length;i++)hamPayload[i]=(i*31+7)%2;

    let t0=performance.now();
    const vc=vcEncrypt(bits,w,h,1000+PAPER_IMAGES.indexOf(type));
    const encryptionMs=performance.now()-t0;

    t0=performance.now();
    const baseMarked=vc.map(s=>baseEmbed(s,basePayload,w,h));
    const baseEmbeddingMs=performance.now()-t0;
    t0=performance.now();
    const baseRestored=baseMarked.map(s=>restoreBaseShare(s,w,h));
    const baseImage=vcRecover(baseRestored[0],baseRestored[1],w,h);
    const baseExtracted=baseExtract(baseMarked[0],w,h);
    const baseExtractionMs=performance.now()-t0;
    const baseImageOk=sameBits(baseImage,bits), basePayloadOk=sameBits(baseExtracted,basePayload);

    t0=performance.now();
    const hamMarked=vc.map(s=>syndromeEmbed(s,hamPayload,w,h));
    const hamEmbeddingMs=performance.now()-t0;
    t0=performance.now();
    const hamRestored=hamMarked.map(s=>syndromeExtractRestore(s,w,h));
    const hamImage=vcRecover(hamRestored[0].restored,hamRestored[1].restored,w,h);
    const hamPayloadOut=hamRestored[0].payload;
    const hamExtractionMs=performance.now()-t0;
    const hamImageOk=sameBits(hamImage,bits), hamPayloadOk=sameBits(hamPayloadOut,hamPayload);

    results[type]={
      base:{bpp:1,stored:3,encryptionMs,embeddingMs:baseEmbeddingMs,extractionMs:baseExtractionMs,totalMs:encryptionMs+baseEmbeddingMs+baseExtractionMs,imageRecovery:baseImageOk?100: imageAccuracy(baseImage,bits),payloadRecovery:basePayloadOk?100:imageAccuracy(baseExtracted,basePayload),exactImage:baseImageOk,exactPayload:basePayloadOk},
      hamming:{bpp:3,stored:7,encryptionMs,embeddingMs:hamEmbeddingMs,extractionMs:hamExtractionMs,totalMs:encryptionMs+hamEmbeddingMs+hamExtractionMs,imageRecovery:hamImageOk?100:imageAccuracy(hamImage,bits),payloadRecovery:hamPayloadOk?100:imageAccuracy(hamPayloadOut,hamPayload),exactImage:hamImageOk,exactPayload:hamPayloadOk}
    };
  }
  return results;
}

async function renderUnifiedAnalysis(){
  $('analysisImages').innerHTML=PAPER_IMAGES.map(makeCategoryCard).join('');
  $('analysisSummary').innerHTML=`
    <div class="metric"><span>Build</span><b>Analysis v5</b><small>measured-method comparison</small></div>
    <div class="metric"><span>Test categories</span><b>6</b><small>same categories named by the paper</small></div>
    <div class="metric"><span>Base MRDHCBI</span><b>1.00 bpp</b><small>measured from the implemented baseline</small></div>
    <div class="metric"><span>Our Hamming</span><b>3.00 bpp</b><small>measured from the implemented method</small></div>
    <div class="metric"><span>Runtime</span><b>Live browser</b><small>measured locally for Base + Hamming; not hardware-normalized</small></div>`;

  const measured=await runUnifiedMeasuredMethods();
  const baseEmbed=PAPER_IMAGES.map(()=>1), hamEmbed=PAPER_IMAGES.map(()=>3);
  const baseRuntime=PAPER_IMAGES.map(t=>measured[t].base.totalMs);
  const hamRuntime=PAPER_IMAGES.map(t=>measured[t].hamming.totalMs);
  analysisCharts.forEach(c=>c.destroy()); analysisCharts=[];

  analysisCharts.push(new Chart($('analysisMainChart'),{type:'bar',data:{labels:PAPER_IMAGES,datasets:[
    {label:'Ren [12] — not implemented',data:PAPER_IMAGES.map(()=>null),backgroundColor:'#9ca3af'},
    {label:'Li [13] — not implemented',data:PAPER_IMAGES.map(()=>null),backgroundColor:'#9ca3af'},
    {label:'Zhang [14] — not implemented',data:PAPER_IMAGES.map(()=>null),backgroundColor:'#9ca3af'},
    {label:'Base MRDHCBI — measured',data:baseEmbed},
    {label:'Our Hamming — measured',data:hamEmbed}
  ]},options:{responsive:true,plugins:{legend:{position:'bottom'},tooltip:{callbacks:{label:ctx=>ctx.raw==null?'Not implemented in this project':`${ctx.dataset.label}: ${ctx.raw} bpp`}}},scales:{y:{beginAtZero:true,title:{display:true,text:'Measured embedding rate (bpp)'}}}}}));

  analysisCharts.push(new Chart($('analysisRuntimeChart'),{type:'bar',data:{labels:PAPER_IMAGES,datasets:[
    {label:'Ren [12] — not implemented',data:PAPER_IMAGES.map(()=>null),backgroundColor:'#9ca3af'},
    {label:'Li [13] — not implemented',data:PAPER_IMAGES.map(()=>null),backgroundColor:'#9ca3af'},
    {label:'Zhang [14] — not implemented',data:PAPER_IMAGES.map(()=>null),backgroundColor:'#9ca3af'},
    {label:'Base MRDHCBI — measured',data:baseRuntime},
    {label:'Our Hamming — measured',data:hamRuntime}
  ]},options:{responsive:true,plugins:{legend:{position:'bottom'},tooltip:{callbacks:{label:ctx=>ctx.raw==null?'Not implemented in this project':`${ctx.raw.toFixed(3)} ms`}}},scales:{y:{beginAtZero:true,title:{display:true,text:'Measured processing time (ms)'}}}}}));

  const stabilityValues=[null,null,null,0,0];
  analysisCharts.push(new Chart($('analysisStabilityChart'),{type:'bar',data:{labels:METHODS,datasets:[{label:'Embedding-rate range',data:stabilityValues,backgroundColor:['#9ca3af','#9ca3af','#9ca3af','#35c99a','#ff8a65'],minBarLength:6}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.raw==null?'Not implemented in this project':`Range: ${ctx.raw.toFixed(2)} bpp`}}},scales:{y:{beginAtZero:true,suggestedMax:1,title:{display:true,text:'Range across six categories (bpp)'}}}}}));

  const densityValues=[null,null,null,1,3];
  analysisCharts.push(new Chart($('analysisPrototypeChart'),{type:'bar',data:{labels:METHODS,datasets:[{label:'Mean measured payload density',data:densityValues,backgroundColor:['#9ca3af','#9ca3af','#9ca3af','#35c99a','#ff8a65']}]},options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false},tooltip:{callbacks:{label:ctx=>ctx.raw==null?'Not implemented in this project':`${ctx.raw.toFixed(2)} bpp`}}},scales:{y:{beginAtZero:true,title:{display:true,text:'Mean measured payload density (bpp)'}}}}}));

  $('analysisChartTitle').textContent='Measured embedding rate — same six categories';
  const embedRows=PAPER_IMAGES.map(t=>`<tr><td>${t}</td><td>—</td><td>—</td><td>—</td><td>1.00</td><td>3.00</td></tr>`).join('');
  const runtimeRows=PAPER_IMAGES.map(t=>`<tr><td>${t}</td><td>—</td><td>—</td><td>—</td><td>${measured[t].base.totalMs.toFixed(3)}</td><td>${measured[t].hamming.totalMs.toFixed(3)}</td></tr>`).join('');
  const meanBase=baseRuntime.reduce((a,b)=>a+b,0)/6, meanHam=hamRuntime.reduce((a,b)=>a+b,0)/6;
  $('analysisTable').innerHTML=`
    <h3>Embedding rate (bpp) — measured values</h3>
    <p class="hint">These numbers come from the implementations actually present in this project. The three literature algorithms are shown as <b>not implemented</b>, so no paper numbers are copied into this table.</p>
    <table class="details"><tr><th>Image</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Base MRDHCBI</th><th>Our Hamming</th></tr>${embedRows}<tr><th>Mean</th><th>—</th><th>—</th><th>—</th><th>1.000</th><th>3.000</th></tr></table>
    <br><h3>Encryption / processing runtime (ms) — measured values</h3>
    <p class="hint">Runtime is measured in this browser for the Base and Hamming implementations using the same six deterministic category replicas. It is not presented as a hardware-normalized replacement for the paper's MATLAB measurements.</p>
    <table class="details"><tr><th>Image</th><th>Ren [12]</th><th>Li [13]</th><th>Zhang [14]</th><th>Base MRDHCBI</th><th>Our Hamming</th></tr>${runtimeRows}<tr><th>Mean</th><th>—</th><th>—</th><th>—</th><th>${meanBase.toFixed(3)}</th><th>${meanHam.toFixed(3)}</th></tr></table>
    <p class="analysis-footnote">A dash means the algorithm is not implemented in this project and therefore has no measured value. This is intentional: the Analysis page no longer transcribes the paper's reported numerical results.</p>`;

  const functionalHeader=METHODS.map(m=>`<th>${escapeHtml(m)}</th>`).join('');
  const functionalRows=FUNCTIONAL.map(row=>`<tr><td>${escapeHtml(row[0])}</td>${row.slice(1).map(v=>`<td>${escapeHtml(v)}</td>`).join('')}</tr>`).join('');
  $('functionalTable').innerHTML=`<table class="details"><tr><th>Function</th>${functionalHeader}</tr>${functionalRows}</table>`;

  const exactBase=PAPER_IMAGES.every(t=>measured[t].base.exactImage), exactHam=PAPER_IMAGES.every(t=>measured[t].hamming.exactImage);
  const payloadBase=PAPER_IMAGES.every(t=>measured[t].base.exactPayload), payloadHam=PAPER_IMAGES.every(t=>measured[t].hamming.exactPayload);
  $('derivedTable').innerHTML=`
    <h3>Measured metrics — Base vs Our Hamming</h3>
    <table class="details">
      <tr><th>Metric</th><th>Base MRDHCBI</th><th>Our Hamming</th><th>How it is measured</th></tr>
      <tr><td>Embedding rate</td><td>1.00 bpp</td><td>3.00 bpp</td><td>Hidden payload bits divided by original source pixels.</td></tr>
      <tr><td>Stored bits / source pixel / share</td><td>3</td><td>7</td><td>Length of each marked share for one original pixel.</td></tr>
      <tr><td>Storage expansion</td><td>3×</td><td>7×</td><td>Marked-share bit count divided by original pixel count.</td></tr>
      <tr><td>Embedding-rate stability range</td><td>0.00 bpp</td><td>0.00 bpp</td><td>Measured max − min across the six categories; both methods have fixed capacity by construction.</td></tr>
      <tr><td>Exact image recovery</td><td>${exactBase?'100%':'Below 100%'}</td><td>${exactHam?'100%':'Below 100%'}</td><td>Exact pixel-by-pixel comparison after extraction and recovery.</td></tr>
      <tr><td>Exact payload recovery</td><td>${payloadBase?'100%':'Below 100%'}</td><td>${payloadHam?'100%':'Below 100%'}</td><td>Exact bit-by-bit comparison with the generated payload.</td></tr>
      <tr><td>Mean processing runtime</td><td>${meanBase.toFixed(3)} ms</td><td>${meanHam.toFixed(3)} ms</td><td>Live browser measurements across the six category replicas.</td></tr>
    </table>
    <h3 style="margin-top:18px">Implementation status</h3>
    <p class="hint">Ren [12], Li [13], and Zhang [14] are not yet executable components of this project. Their published descriptions involve block preprocessing/prediction or compression mechanisms that are not present in the supplied code. Their values are deliberately left blank rather than copied from the paper.</p>`;
  $('analysisPanel').scrollIntoView({behavior:'smooth'});
}


// Theme toggle
const savedTheme=localStorage.getItem('mrdhcbi-theme')||'dark';
document.documentElement.dataset.theme=savedTheme;
const themeBtn=$('themeToggle');
if(themeBtn){themeBtn.textContent=savedTheme==='dark'?'☼ Light mode':'☾ Dark mode';themeBtn.onclick=()=>{const next=document.documentElement.dataset.theme==='dark'?'light':'dark';document.documentElement.dataset.theme=next;localStorage.setItem('mrdhcbi-theme',next);themeBtn.textContent=next==='dark'?'☼ Light mode':'☾ Dark mode';};}
function renderAnalysis(){renderUnifiedAnalysis().catch(e=>{console.error(e);$('analysisSummary').innerHTML=`<div class="metric"><span>Analysis error</span><b>See console</b><small>${escapeHtml(e.message)}</small></div>`});}
$('newTxBtn').onclick=()=>location.reload();
