import extract from 'https://esm.sh/png-chunks-extract';
import encode from 'https://esm.sh/png-chunks-encode';
import { deflate, inflate } from 'https://esm.sh/pako@2.1.0';

export function makeITXt(keyword, textUint8, compressed=true){
  const k = new TextEncoder().encode(keyword);
  const z = compressed ? deflate(textUint8) : textUint8;
  const arr = [];
  arr.push(...k, 0, compressed?1:0, 0, 0, 0, ...z);
  return { name: 'iTXt', data: new Uint8Array(arr) };
}

export function parseITXt(data){
  let i = 0; const u8 = data;
  while(i<u8.length && u8[i]!==0) i++; const keyword = new TextDecoder().decode(u8.slice(0,i));
  i++; const compressed = u8[i++]===1; i++; // compression method
  while(i<u8.length && u8[i]!==0) i++; i++; // lang
  while(i<u8.length && u8[i]!==0) i++; i++; // translated
  const textUint8 = u8.slice(i);
  return { keyword, compressed, textUint8 };
}

export function encodeWithITXt(pngBuf, keyword, text){
  const chunks = extract(pngBuf);
  const json = new TextEncoder().encode(text);
  const itxt = makeITXt(keyword, json, true);
  return encode([...chunks.slice(0,-1), itxt, chunks[chunks.length-1]]);
}

export function extractITXt(pngBuf, keyword){
  const chunks = extract(pngBuf);
  for(const ch of chunks){
    if(ch.name==='iTXt'){
      const {keyword:kw, compressed, textUint8} = parseITXt(ch.data);
      if(kw===keyword){
        const data = compressed ? inflate(textUint8) : textUint8;
        return new TextDecoder().decode(data);
      }
    }
  }
  return null;
}

export function vectorizeImageToStrokes(imgCanvas, toWorld, meId, size, limit=50000){
  const {width, height} = imgCanvas;
  const ix = imgCanvas.getContext('2d').getImageData(0,0,width,height);
  const data = ix.data;
  const quant = v => (v/16|0)*16;
  let idn = 0;
  let step = 1;
  while(true){
    const out = [];
    for(let y=0; y<height; y+=step){
      let x=0;
      while(x<width){
        const i=(y*width+x)*4;
        const a=data[i+3]; if(a<8){ x++; continue; }
        const r=quant(data[i]), g=quant(data[i+1]), b=quant(data[i+2]);
        const color=`rgb(${r},${g},${b})`;
        let x0=x, x1=x;
        for(let xx=x+1; xx<width; xx++){
          const j=(y*width+xx)*4;
          const aa=data[j+3];
          const rr=quant(data[j]), gg=quant(data[j+1]), bb=quant(data[j+2]);
          if(aa<8 || rr!==r || gg!==g || bb!==b) break;
          x1=xx;
        }
        if(x1-x0>=1){
          const p0=toWorld(x0,y);
          const p1=toWorld(x1,y);
          out.push({ id:`imp-${Date.now()}-${idn++}`, by:meId, mode:'draw', color, size, points:[p0,p1] });
        }
        x=x1+1;
      }
    }
    if(out.length<=limit || step>=height) return out;
    step*=2;
  }
}
