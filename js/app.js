import {
  loadBinaryImage,binaryToCanvas,canvasToBlob,vcEncrypt,baseEmbed,baseExtract,restoreBaseShare,
  syndromeEmbed,syndromeExtractRestore,vcRecover,corruptBits,makePayload,parsePayload,
  fitPayloadToBits,bitsFromBytes,bytesFromBits,sharePngBlob
} from './algorithm.js';

let role=null, peer=null, conn=null, pairingKey='', imageState=null, documentFile=null, charts=[];
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
  role=btn.dataset.role; show('landing',false); show('pairing'); $('pairState').textContent=`Role: ${role}`;
});
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
    const propPayload=new Uint8Array(tx.proposed.recoveredPayload);
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
    $('receiverResult').innerHTML=`<div class="metric-grid">
      <div class="metric"><span>Image recovery</span><b>${verifiedImagePct.toFixed(2)}%</b><small>pixel-level</small></div>
      <div class="metric"><span>Document integrity</span><b class="${doc.crcOk?'success':'danger'}">${doc.crcOk?'100%':'FAILED'}</b><small>CRC-32 verification</small></div>
      <div class="metric"><span>Document</span><b>${fmtBytes(doc.body.length)}</b><small>${escapeHtml(doc.name)}</small></div>
      <div class="metric"><span>Corruption</span><b>${m.corruption}%</b><small>simulated before transfer</small></div>
    </div>
    <div class="panel" style="margin-top:16px">
      <h3>Recovered successfully</h3>
      <p class="${doc.crcOk?'success':'danger'}">${doc.crcOk?'The recovered document passed CRC-32 and is byte-for-byte valid.':'The recovered document failed CRC-32; corruption affected the payload.'}</p>
      <button class="primary" id="downloadRecovered">Download recovered document</button>
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

$('newTxBtn').onclick=()=>location.reload();
