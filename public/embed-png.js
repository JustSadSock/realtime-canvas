import extract from "https://esm.sh/png-chunks-extract";
import encode from "https://esm.sh/png-chunks-encode";
import { deflate, inflate } from "https://esm.sh/pako@2.1.0";

function makeITXt(keyword, textUint8, compressed = true) {
  const k = new TextEncoder().encode(keyword);
  const z = compressed ? deflate(textUint8) : textUint8;
  const arr = [];
  arr.push(...k, 0, compressed ? 1 : 0, 0, 0, 0, ...z);
  return { name: "iTXt", data: new Uint8Array(arr) };
}

function parseITXt(data) {
  let i = 0;
  while (i < data.length && data[i] !== 0) i++;
  const keyword = new TextDecoder().decode(data.slice(0, i));
  const compressed = data[i + 1] === 1;
  let p = i + 5; // skip keyword, 0, compression, method, language (0)
  while (p < data.length && data[p] !== 0) p++;
  p++;
  while (p < data.length && data[p] !== 0) p++;
  p++;
  const text = data.slice(p);
  const textUint8 = compressed ? inflate(text) : text;
  return { keyword, compressed, textUint8 };
}

async function renderPNGTransparentBlob() {
  const cvs = window.cvs;
  const DPR = window.DPR || 1;
  const off = document.createElement("canvas");
  off.width = cvs.width;
  off.height = cvs.height;
  const ox = off.getContext("2d");
  ox.setTransform(DPR, 0, 0, DPR, 0, 0);
  for (const s of window.strokes.values()) {
    if (s.mode === "image") {
      if (s._img)
        ox.drawImage(
          s._img,
          (s.x - window.camera.x) * window.camera.scale,
          (s.y - window.camera.y) * window.camera.scale,
          s.w * window.camera.scale,
          s.h * window.camera.scale,
        );
      continue;
    }
    ox.save();
    ox.lineJoin = "round";
    ox.lineCap = "round";
    ox.globalCompositeOperation =
      s.mode === "erase" ? "destination-out" : "source-over";
    ox.strokeStyle = s.color;
    ox.lineWidth = s.size * window.camera.scale;
    ox.beginPath();
    s.points.forEach((p, i) => {
      const x = (p.x - window.camera.x) * window.camera.scale;
      const y = (p.y - window.camera.y) * window.camera.scale;
      if (i === 0) ox.moveTo(x, y);
      else ox.lineTo(x, y);
    });
    ox.stroke();
    ox.restore();
  }
  return await new Promise((res) => off.toBlob(res, "image/png"));
}

export async function exportEmbeddedPNG() {
  const blob = await renderPNGTransparentBlob();
  const pngBuf = new Uint8Array(await blob.arrayBuffer());
  const chunks = extract(pngBuf);
  const state = window.serializeState();
  const json = new TextEncoder().encode(JSON.stringify(state));
  const itxt = makeITXt("rtcanvas", json, true);
  const out = encode([...chunks.slice(0, -1), itxt, chunks[chunks.length - 1]]);
  return new Blob([out], { type: "image/png" });
}

function vectorizeImageToStrokes(imgCanvas, toWorld, sizeScale) {
  const { width, height } = imgCanvas;
  const ix = imgCanvas.getContext("2d").getImageData(0, 0, width, height);
  const data = ix.data;
  const quant = (v) => ((v / 16) | 0) * 16;
  const out = [];
  const MAX = 50000;
  let stepY = 1;
  let idn = 0;
  while (true) {
    out.length = 0;
    for (let y = 0; y < height; y += stepY) {
      let x = 0;
      while (x < width) {
        const i = (y * width + x) * 4;
        const a = data[i + 3];
        if (a < 8) {
          x++;
          continue;
        }
        const r = quant(data[i + 0]);
        const g = quant(data[i + 1]);
        const b = quant(data[i + 2]);
        let x0 = x;
        let x1 = x;
        for (let xx = x + 1; xx < width; xx++) {
          const j = (y * width + xx) * 4;
          const aa = data[j + 3];
          const rr = quant(data[j + 0]);
          const gg = quant(data[j + 1]);
          const bb = quant(data[j + 2]);
          if (aa < 8 || rr !== r || gg !== g || bb !== b) break;
          x1 = xx;
        }
        if (x1 > x0) {
          const p0 = toWorld(x0, y);
          const p1 = toWorld(x1, y);
          out.push({
            id: `imp-${Date.now()}-${idn++}`,
            by: window.meId,
            mode: "draw",
            color: `rgb(${r},${g},${b})`,
            size: sizeScale,
            points: [p0, p1],
          });
          if (out.length > MAX) break;
        }
        x = x1 + 1;
      }
      if (out.length > MAX) break;
    }
    if (out.length <= MAX || stepY > 8) break;
    stepY *= 2;
  }
  return out;
}

let placement = null;
let overlay = null;

function updatePlacement() {
  if (!placement) return;
  const img = placement.img;
  img.style.transform = `translate(${placement.x}px,${placement.y}px) scale(${placement.scale})`;
}

function cleanupPlacement() {
  if (overlay) overlay.remove();
  overlay = null;
  placement = null;
  window.requestRender();
  document.removeEventListener("keydown", keyHandler);
}

function keyHandler(e) {
  if (!placement) return;
  if (e.key === "Escape") {
    cleanupPlacement();
  } else if (e.key === "Enter") {
    finalizePlacement();
  }
}

document.addEventListener("keydown", keyHandler);

async function finalizePlacement() {
  if (!placement) return;
  const imgEl = placement.img;
  let w = imgEl.naturalWidth;
  let h = imgEl.naturalHeight;
  let scaleImg = 1;
  if (w > 2048) {
    scaleImg = 2048 / w;
    w = 2048;
    h = Math.round(h * scaleImg);
  }
  const off = document.createElement("canvas");
  off.width = w;
  off.height = h;
  off.getContext("2d").drawImage(imgEl, 0, 0, w, h);
  const toWorld = (x, y) => {
    const sx = placement.x + (x * placement.scale) / scaleImg;
    const sy = placement.y + (y * placement.scale) / scaleImg;
    return window.screenToWorld(sx, sy);
  };
  const sizeScale = placement.scale / window.camera.scale / scaleImg;
  const strokes = vectorizeImageToStrokes(off, toWorld, sizeScale);
  const added = window.mergeState({ strokes }, { setBg: false });
  for (const id of added) {
    window.myStack.push(id);
    const s = window.strokes.get(id);
    window.Net.sendReliable({ type: "add", stroke: { ...s } });
  }
  cleanupPlacement();
}

async function startPlacement(imgBlob) {
  const url = URL.createObjectURL(imgBlob);
  const img = new Image();
  await new Promise((res) => {
    img.onload = res;
    img.src = url;
  });
  placement = {
    img,
    x: (innerWidth - img.width) / 2,
    y: (innerHeight - img.height) / 2,
    scale: 1,
  };
  overlay = document.createElement("div");
  overlay.style.position = "fixed";
  overlay.style.left = "0";
  overlay.style.top = "0";
  overlay.style.right = "0";
  overlay.style.bottom = "0";
  overlay.style.zIndex = "100";
  overlay.style.cursor = "move";
  overlay.appendChild(img);
  const panel = document.createElement("div");
  panel.style.position = "absolute";
  panel.style.left = "50%";
  panel.style.top = "10px";
  panel.style.transform = "translateX(-50%)";
  panel.style.background = "rgba(255,255,255,0.8)";
  panel.style.border = "1px solid #ccc";
  panel.style.borderRadius = "8px";
  panel.style.padding = "6px";
  panel.style.display = "flex";
  panel.style.gap = "8px";
  const placeBtn = document.createElement("button");
  placeBtn.textContent = "Place";
  const cancelBtn = document.createElement("button");
  cancelBtn.textContent = "Cancel";
  panel.appendChild(placeBtn);
  panel.appendChild(cancelBtn);
  overlay.appendChild(panel);
  document.body.appendChild(overlay);
  updatePlacement();
  let dragging = false;
  let lx = 0;
  let ly = 0;
  overlay.addEventListener("pointerdown", (e) => {
    if (e.target !== overlay && e.target !== img) return;
    dragging = true;
    lx = e.clientX;
    ly = e.clientY;
  });
  overlay.addEventListener("pointermove", (e) => {
    if (!dragging) return;
    placement.x += e.clientX - lx;
    placement.y += e.clientY - ly;
    lx = e.clientX;
    ly = e.clientY;
    updatePlacement();
  });
  overlay.addEventListener("pointerup", () => {
    dragging = false;
  });
  overlay.addEventListener("pointerleave", () => {
    dragging = false;
  });
  overlay.addEventListener(
    "wheel",
    (e) => {
      e.preventDefault();
      const ds = Math.exp(-e.deltaY / 500);
      const cx = e.clientX;
      const cy = e.clientY;
      placement.scale *= ds;
      placement.x = cx - (cx - placement.x) * ds;
      placement.y = cy - (cy - placement.y) * ds;
      updatePlacement();
    },
    { passive: false },
  );
  placeBtn.onclick = (e) => {
    e.stopPropagation();
    finalizePlacement();
  };
  cancelBtn.onclick = (e) => {
    e.stopPropagation();
    cleanupPlacement();
  };
}

export async function importPNG(fileOrBlob) {
  const buf = new Uint8Array(await fileOrBlob.arrayBuffer());
  const chunks = extract(buf);
  const itxt = chunks.find((c) => c.name === "iTXt");
  if (itxt) {
    const meta = parseITXt(itxt.data);
    if (meta.keyword === "rtcanvas") {
      const json = new TextDecoder().decode(meta.textUint8);
      const state = JSON.parse(json);
      const added = window.mergeState(state, { setBg: false });
      for (const id of added) {
        window.myStack.push(id);
        const s = window.strokes.get(id);
        window.Net.sendReliable({ type: "add", stroke: { ...s } });
      }
      return;
    }
  }
  await startPlacement(fileOrBlob);
}

export function hasEmbeddedState(pngUint8) {
  const chunks = extract(pngUint8);
  const itxt = chunks.find((c) => c.name === "iTXt");
  if (!itxt) return false;
  try {
    const meta = parseITXt(itxt.data);
    return meta.keyword === "rtcanvas";
  } catch {
    return false;
  }
}
