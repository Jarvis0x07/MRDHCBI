
// Browser implementation of the same (2,3) VC + MRDHCBI baseline +
// Hamming(7,4) syndrome-state embedding used by the supplied Python prototype.

const B0 = [[1,1,0],[1,1,0],[1,1,0]];
const B1 = [[1,1,0],[1,0,1],[0,1,1]];
const PERMS = [[0,1,2],[0,2,1],[1,0,2],[1,2,0],[2,0,1],[2,1,0]];

function loadBinaryImage(file){
  return new Promise((resolve,reject)=>{
    const img=new Image();
    img.onload=()=>{
      const c=document.createElement('canvas');
      c.width=img.naturalWidth;c.height=img.naturalHeight;
      const ctx=c.getContext('2d',{willReadFrequently:true});
      ctx.drawImage(img,0,0);
      const d=ctx.getImageData(0,0,c.width,c.height).data;
      const bits=new Uint8Array(c.width*c.height);
      for(let i=0;i<bits.length;i++){
        const g=(d[i*4]+d[i*4+1]+d[i*4+2])/3;
        bits[i]=g>=128?1:0;
      }
      resolve({bits,width:c.width,height:c.height});
    };
    img.onerror=reject;
    img.src=URL.createObjectURL(file);
  });
}

function binaryToCanvas(bits,w,h,scale=1){
  const c=document.createElement('canvas');c.width=w*scale;c.height=h*scale;
  const ctx=c.getContext('2d');
  const im=ctx.createImageData(w,h);
  for(let i=0;i<bits.length;i++){
    const v=bits[i]?255:0;
    im.data[i*4]=v;im.data[i*4+1]=v;im.data[i*4+2]=v;im.data[i*4+3]=255;
  }
  if(scale===1)ctx.putImageData(im,0,0);
  else{
    const tmp=document.createElement('canvas');tmp.width=w;tmp.height=h;
    tmp.getContext('2d').putImageData(im,0,0);
    ctx.imageSmoothingEnabled=false;ctx.drawImage(tmp,0,0,w*scale,h*scale);
  }
  return c;
}

function canvasToBlob(canvas){return new Promise(r=>canvas.toBlob(r,'image/png'));}

function rng32(seed){
  let x=(seed>>>0)||0xA341316C;
  return ()=>{x^=x<<13;x^=x>>>17;x^=x<<5;return (x>>>0)/4294967296;};
}

function vcEncrypt(original,w,h,seed=2026){
  const shares=[new Uint8Array(h*3*w),new Uint8Array(h*3*w),new Uint8Array(h*3*w)];
  const rnd=rng32(seed);
  for(let p=0;p<w*h;p++){
    const source=original[p];
    const basis=source?B1:B0;
    const perm=PERMS[Math.floor(rnd()*6)];
    const y=Math.floor(p/w),x=p%w;
    for(let s=0;s<3;s++){
      const base=x*3;
      for(let j=0;j<3;j++) shares[s][y*3*w+base+j]=basis[s][perm[j]];
    }
  }
  return shares;
}

function restoreBaseShare(marked,w,h){
  const out=new Uint8Array(marked.length);
  for(let p=0;p<w*h;p++){
    const off=(Math.floor(p/w)*3*w)+(p%w)*3;
    const a=marked[off],b=marked[off+1],c=marked[off+2];
    const weight=a+b+c;
    out[off]=a ^ (weight!==2?1:0);
    out[off+1]=b;out[off+2]=c;
  }
  return out;
}

function baseEmbed(share,payloadBits,w,h){
  const out=share.slice();
  for(let p=0;p<w*h;p++){
    const off=(Math.floor(p/w)*3*w)+(p%w)*3;
    out[off]^=payloadBits[p]||0;
  }
  return out;
}
function baseExtract(marked,w,h){
  const payload=new Uint8Array(w*h);
  for(let p=0;p<w*h;p++){
    const off=(Math.floor(p/w)*3*w)+(p%w)*3;
    payload[p]=((marked[off]+marked[off+1]+marked[off+2])!==2)?1:0;
  }
  return payload;
}

function hEncode4(d1,d2,d3,d4){
  const p1=d1^d2^d4, p2=d1^d3^d4, p4=d2^d3^d4;
  return [p1,p2,d1,p4,d2,d3,d4];
}
function syndrome(c){
  const s1=c[0]^c[2]^c[4]^c[6];
  const s2=c[1]^c[2]^c[5]^c[6];
  const s4=c[3]^c[4]^c[5]^c[6];
  return s1+(s2<<1)+(s4<<2);
}
function correctHamming(c){
  const s=syndrome(c);
  const out=c.slice();
  if(s>=1&&s<=7) out[s-1]^=1;
  return {data:[out[2],out[4],out[5],out[6]],syndrome:s,corrected:out};
}

// Same proposed method: every 3-bit VC block becomes a 4-bit data word,
// Hamming(7,4) is generated, then a 3-bit desired syndrome is encoded by
// flipping the corresponding codeword position. The receiver reads the
// syndrome, undoes that flip, and Hamming-decodes the original ciphertext.
function syndromeEmbed(share,payloadBits,w,h){
  const out=new Uint8Array(h*7*w);
  for(let p=0;p<w*h;p++){
    const y=Math.floor(p/w),x=p%w;
    const so=y*3*w+x*3, mo=y*7*w+x*7;
    const c1=share[so],c2=share[so+1],c3=share[so+2];
    const d4=c1^c2^c3;
    let code=hEncode4(c1,c2,c3,d4);
    const sym=(payloadBits[p*3]||0)+2*(payloadBits[p*3+1]||0)+4*(payloadBits[p*3+2]||0);
    if(sym>0) code[sym-1]^=1;
    for(let j=0;j<7;j++) out[mo+j]=code[j];
  }
  return out;
}

function syndromeExtractRestore(marked,w,h){
  const restored=new Uint8Array(h*3*w);
  const payload=new Uint8Array(w*h*3);
  let correctedCodeErrors=0;
  for(let p=0;p<w*h;p++){
    const y=Math.floor(p/w),x=p%w,mo=y*7*w+x*7,so=y*3*w+x*3;
    const markedCode=Array.from(marked.slice(mo,mo+7));
    const sym=syndrome(markedCode);
    payload[p*3]=sym&1;
    payload[p*3+1]=(sym>>1)&1;
    payload[p*3+2]=(sym>>2)&1;
    const restoredCode=markedCode.slice();
    if(sym>0) restoredCode[sym-1]^=1;
    const decoded=correctHamming(restoredCode);
    if(decoded.syndrome!==0) correctedCodeErrors++;
    restored[so]=decoded.data[0];restored[so+1]=decoded.data[1];restored[so+2]=decoded.data[2];
  }
  return {restored,payload,correctedCodeErrors};
}

function vcRecover(shareA,shareB,w,h){
  const rec=new Uint8Array(w*h);
  for(let p=0;p<w*h;p++){
    const y=Math.floor(p/w),x=p%w,off=y*3*w+x*3;
    const weight=(shareA[off]|shareB[off])+(shareA[off+1]|shareB[off+1])+(shareA[off+2]|shareB[off+2]);
    rec[p]=weight>=3?1:0;
  }
  return rec;
}

function corruptBits(data,percent,seed=98765){
  const out=data.slice(), n=Math.floor(out.length*percent/100);
  const rnd=rng32(seed);
  // Fisher-Yates partial sample without requiring a huge index array.
  const positions=Array.from({length:out.length},(_,i)=>i);
  for(let i=0;i<n;i++){
    const j=i+Math.floor(rnd()*(out.length-i));
    [positions[i],positions[j]]=[positions[j],positions[i]];
    out[positions[i]]^=1;
  }
  return out;
}

function bitsFromBytes(bytes){
  const out=new Uint8Array(bytes.length*8);
  for(let i=0;i<bytes.length;i++)for(let b=0;b<8;b++)out[i*8+b]=(bytes[i]>>(7-b))&1;
  return out;
}
function bytesFromBits(bits){
  const n=Math.floor(bits.length/8),out=new Uint8Array(n);
  for(let i=0;i<n;i++){let v=0;for(let b=0;b<8;b++)v=(v<<1)|bits[i*8+b];out[i]=v;}
  return out;
}

async function sha256(data){return new Uint8Array(await crypto.subtle.digest('SHA-256',data));}
async function xorKeyBytes(bytes,key){
  const out=new Uint8Array(bytes), keyBytes=new TextEncoder().encode(key);
  let offset=0,counter=0;
  while(offset<bytes.length){
    const ctr=new TextEncoder().encode(key+'|'+counter++);
    const block=await sha256(ctr);
    for(let i=0;i<block.length&&offset<bytes.length;i++,offset++)out[offset]^=block[i];
  }
  return out;
}

function crc32(bytes){
  let crc=0xFFFFFFFF;
  for(const b of bytes){
    crc^=b;
    for(let i=0;i<8;i++) crc=(crc>>>1)^((crc&1)?0xEDB88320:0);
  }
  return (crc^0xFFFFFFFF)>>>0;
}
function u16(v){return new Uint8Array([v&255,(v>>>8)&255])}
function u32(v){return new Uint8Array([v&255,(v>>>8)&255,(v>>>16)&255,(v>>>24)&255])}
function read16(a,o){return a[o]|(a[o+1]<<8)}
function read32(a,o){return (a[o]|(a[o+1]<<8)|(a[o+2]<<16)|(a[o+3]<<24))>>>0}

async function makePayload(file,key){
  const name=new TextEncoder().encode(file.name);
  const mime=new TextEncoder().encode(file.type||'application/octet-stream');
  if(name.length>65535||mime.length>65535)throw new Error('File metadata is too long.');
  const body=new Uint8Array(await file.arrayBuffer());
  const header=new Uint8Array(12+name.length+mime.length);
  header.set(u16(name.length),0);header.set(u16(mime.length),2);header.set(u32(body.length),4);header.set(u32(crc32(body)),8);
  header.set(name,12);header.set(mime,12+name.length);
  const plain=new Uint8Array(header.length+body.length);plain.set(header);plain.set(body,header.length);
  return {encrypted:await xorKeyBytes(plain,key),plainBytes:plain.length};
}

async function parsePayload(encrypted,key){
  const plain=await xorKeyBytes(encrypted,key);
  if(plain.length<12)throw new Error('Recovered payload is too short.');
  const nl=read16(plain,0),ml=read16(plain,2),size=read32(plain,4),expected=read32(plain,8);
  const bodyStart=12+nl+ml;
  if(bodyStart+size>plain.length)throw new Error('Recovered payload header is inconsistent.');
  const name=new TextDecoder().decode(plain.slice(12,12+nl));
  const mime=new TextDecoder().decode(plain.slice(12+nl,bodyStart));
  const body=plain.slice(bodyStart,bodyStart+size);
  const actual=crc32(body);
  return {name,mime,body,expectedCrc:expected,actualCrc:actual,crcOk:actual===expected};
}

function fitPayloadToBits(payloadBytes,capacityBits){
  const bits=bitsFromBytes(payloadBytes);
  if(bits.length>capacityBits)throw new Error(`Document is too large. Need ${Math.ceil(bits.length/8)} bytes but the selected image provides about ${Math.floor(capacityBits/8)} bytes.`);
  const padded=new Uint8Array(capacityBits);
  padded.set(bits);
  return padded;
}

function sharePngBlob(bits,w,h,method='base'){
  const width=method==='base'?3*w:7*w;
  const c=binaryToCanvas(bits,width,h,1);
  return canvasToBlob(c);
}


// ---------------------------------------------------------------------------
// Reference implementations of the three RDHCBI comparison families.
// These are executable implementations of the mechanisms described in the
// cited papers: block classification, prediction, and auxiliary-map coding.
// They deliberately report only values produced by this code; no published
// numerical results are hard-coded into the analysis.
// ---------------------------------------------------------------------------

function xorBits(bits,seed=0x13579BDF){
  const out=new Uint8Array(bits.length); let x=seed>>>0;
  for(let i=0;i<bits.length;i++){
    x^=x<<13;x^=x>>>17;x^=x<<5;x>>>=0;
    out[i]=bits[i]^((x>>>31)&1);
  }
  return out;
}
function bitMajority(bits,idxs){let s=0;for(const i of idxs)if(i>=0)s+=bits[i];return s*2>=idxs.length?1:0;}
function same(a,b){if(a.length!==b.length)return false;for(let i=0;i<a.length;i++)if(a[i]!==b[i])return false;return true;}
function accuracy(a,b){let n=Math.min(a.length,b.length),ok=0;for(let i=0;i<n;i++)if(a[i]===b[i])ok++;return b.length?100*ok/b.length:0;}
function huffLengths(freq){
  const nodes=Object.entries(freq).filter(([,v])=>v>0).map(([sym,w])=>({sym:+sym,w,depth:0,left:null,right:null}));
  if(nodes.length<=1)return {[nodes[0]?.sym??0]:1};
  let q=nodes.slice();
  while(q.length>1){q.sort((a,b)=>a.w-b.w);const a=q.shift(),b=q.shift();q.push({sym:null,w:a.w+b.w,depth:0,left:a,right:b});}
  const out={};const walk=(n,d)=>{if(n.sym!==null){out[n.sym]=Math.max(1,d);return;}walk(n.left,d+1);walk(n.right,d+1)};walk(q[0],0);return out;
}
function halvingCompressedLength(bits,T0=2,T1=2){
  if(!bits.length)return 0; let q=[];let r=[];let i=0;
  while(i<bits.length){const v=bits[i],T=v?T1:T0;let j=i;while(j<bits.length&&bits[j]===v)j++;let L=j-i;
    let quotient=L<T?L:Math.floor((L+T)/2),rem=L<T?0:(L+T)%2;
    for(let k=0;k<quotient;k++)q.push(v); if(L>=T)r.push(rem); i=j;
  }
  return q.length+r.length;
}
function blockInfo(bits,w,h,N,mode){
  const blocks=[];const typeBits=[];const eligible=new Uint8Array(bits.length);const pred=new Uint8Array(bits.length);
  for(let by=0;by<h;by+=N)for(let bx=0;bx<w;bx+=N){
    const cells=[];for(let y=by;y<Math.min(by+N,h);y++)for(let x=bx;x<Math.min(bx+N,w);x++)cells.push(y*w+x);
    const ones=cells.reduce((s,i)=>s+bits[i],0);const pure=ones===0||ones===cells.length;
    const typ=pure?(ones?'white':'black'):'mixed';typeBits.push(pure?1:0);blocks.push({cells,pure,type:typ,anchor:cells[cells.length-1]});
    if(pure){for(const idx of cells)if(idx!==cells[cells.length-1])eligible[idx]=1;}
    else {
      // Cross/checker segmentation: one parity is embeddable, the other is
      // retained as shared prediction pixels.
      for(const idx of cells){const y=Math.floor(idx/w),x=idx%w;if(((x+y)&1)!==0)continue;
        const neigh=[];
        for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){const nx=x+dx,ny=y+dy;if(nx>=bx&&nx<bx+N&&ny>=by&&ny<by+N&&nx<w&&ny<h)neigh.push(ny*w+nx)}
        if(!neigh.length)continue;
        const p=bitMajority(bits,neigh);pred[idx]=p;
        if(p===bits[idx])eligible[idx]=1;
      }
    }
  }
  return {blocks,typeBits,eligible,pred};
}
function executePredictionMethod(bits,w,h,{kind,N=4,T0=2,T1=2,seed=1}){
  const t0=performance.now();
  const info=blockInfo(bits,w,h,N,kind);
  const typeLen=kind==='ren'?info.typeBits.length:kind==='li'?halvingCompressedLength(info.typeBits,T0,T1):0;
  let auxLen=typeLen;
  if(kind==='zhang'){
    const freq={0:0,1:0,2:0};for(const b of info.blocks)freq[b.type==='black'?0:b.type==='white'?1:2]++;
    const lens=huffLengths(freq);auxLen=Object.entries(freq).reduce((s,[k,v])=>s+(v*(lens[k]||1)),0);
  }
  const encryptionInput=xorBits(bits,seed);
  const encryptionMs=performance.now()-t0;
  const positions=[];for(let i=0;i<info.eligible.length;i++)if(info.eligible[i])positions.push(i);
  const capacity=Math.max(0,positions.length-auxLen);
  const payload=new Uint8Array(capacity);for(let i=0;i<capacity;i++)payload[i]=(i*73+kind.length*11+7)&1;
  const e0=performance.now();const marked=encryptionInput.slice();for(let i=0;i<capacity;i++)marked[positions[i+auxLen]]=payload[i];const embeddingMs=performance.now()-e0;
  const x0=performance.now();const extracted=new Uint8Array(capacity);for(let i=0;i<capacity;i++)extracted[i]=marked[positions[i+auxLen]];
  const decrypted=xorBits(marked,seed);
  const recovered=decrypted.slice();
  for(const block of info.blocks){
    if(block.pure){const a=decrypted[block.anchor];for(const idx of block.cells)recovered[idx]=a;}
    else {for(const idx of block.cells){if(!info.eligible[idx])continue;const y=Math.floor(idx/w),x=idx%w;const neigh=[];for(const [dx,dy] of [[-1,0],[1,0],[0,-1],[0,1]]){const nx=x+dx,ny=y+dy;if(nx>=0&&nx<w&&ny>=0&&ny<h&&Math.floor(nx/N)===Math.floor(x/N)&&Math.floor(ny/N)===Math.floor(y/N))neigh.push(ny*w+nx)}recovered[idx]=bitMajority(decrypted,neigh);}}
  }
  const extractionMs=performance.now()-x0;
  return {bpp:capacity/(w*h),capacityBits:capacity,stored:1,auxBits:auxLen,encryptionMs,embeddingMs,extractionMs,totalMs:encryptionMs+embeddingMs+extractionMs,imageRecovery:accuracy(recovered,bits),payloadRecovery:accuracy(extracted,payload),exactImage:same(recovered,bits),exactPayload:same(extracted,payload)};
}

function benchmarkRen(bits,w,h){return executePredictionMethod(bits,w,h,{kind:'ren',N:4,seed:0x52454E});}
function benchmarkLi(bits,w,h){return executePredictionMethod(bits,w,h,{kind:'li',N:4,T0:2,T1:2,seed:0x4C4954});}
function benchmarkZhang(bits,w,h){return executePredictionMethod(bits,w,h,{kind:'zhang',N:4,seed:0x5A4847});}
