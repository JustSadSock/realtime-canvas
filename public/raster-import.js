import extract from "https://esm.sh/png-chunks-extract";
import { inflate } from "https://esm.sh/pako@2.1.0";

function findITXtRt(pngUint8) {
  const chunks = extract(pngUint8);
  for (const c of chunks) if (c.name === "iTXt") {
    const d = c.data;
    let i = 0;
    while (i < d.length && d[i] !== 0) i++;
    const kw = new TextDecoder().decode(d.slice(0, i));
    if (kw !== "rtcanvas") continue;
    const flag = d[i + 1] | 0,
      method = d[i + 2] | 0;
    let j = i + 3;
    while (j < d.length && d[j] !== 0) j++;
    let k = j + 1;
    while (k < d.length && d[k] !== 0) k++;
    const payload = d.slice(k + 1);
    const bytes = flag === 1 && method === 0 ? inflate(payload) : payload;
    return JSON.parse(new TextDecoder().decode(bytes));
  }
  return null;
}

function bboxOfImportedState(state) {
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const s of state?.strokes || []) {
    if (s.mode === "image") {
      minX = Math.min(minX, s.x);
      minY = Math.min(minY, s.y);
      maxX = Math.max(maxX, s.x + s.w);
      maxY = Math.max(maxY, s.y + s.h);
    } else if (s.mode === "raster") {
      const rh = s.rowH ?? 1;
      for (const r of s.runs || []) {
        minX = Math.min(minX, r.x0);
        minY = Math.min(minY, r.y);
        maxX = Math.max(maxX, r.x1 + 1);
        maxY = Math.max(maxY, r.y + rh);
      }
    } else {
      for (const p of s.points || []) {
        minX = Math.min(minX, p.x);
        minY = Math.min(minY, p.y);
        maxX = Math.max(maxX, p.x);
        maxY = Math.max(maxY, p.y);
      }
    }
  }
  if (minX === Infinity) return { x: 0, y: 0, w: 0, h: 0 };
  return { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
}

function translateImportedState(state, dx, dy) {
  for (const s of state?.strokes || []) {
    if (s.mode === "image") {
      s.x += dx;
      s.y += dy;
    } else if (s.mode === "raster") {
      s.runs = (s.runs || []).map((r) => ({
        ...r,
        x0: r.x0 + dx,
        x1: r.x1 + dx,
        y: r.y + dy,
      }));
    } else {
      s.points = (s.points || []).map((p) => ({ x: p.x + dx, y: p.y + dy }));
    }
  }
}

function normalizeStateToOrigin(state) {
  const bb = bboxOfImportedState(state);
  translateImportedState(state, -bb.x, -bb.y);
}

function ensureStyles() {
  if (document.getElementById("raster-import-style")) return;
  const style = document.createElement("style");
  style.id = "raster-import-style";
  style.textContent = `.import-overlay{position:absolute;inset:0;pointer-events:auto;z-index:9999;touch-action:none}
.import-frame{position:absolute;border:2px dashed transparent;--dash:4px;background:
  linear-gradient(#0000,#0000) padding-box,
  repeating-linear-gradient(90deg,#7bd,#7bd var(--dash),#0000 var(--dash),#0000 calc(2*var(--dash))) border-box,
  repeating-linear-gradient(#7bd,#7bd var(--dash),#0000 var(--dash),#0000 calc(2*var(--dash))) border-box;
box-shadow:0 0 0 9999px rgba(0,0,0,.25);pointer-events:auto;cursor:move;touch-action:none}
.handle{position:absolute;width:10px;height:10px;background:#7bd;border:1px solid #124;box-shadow:0 1px 2px rgba(0,0,0,.3)}
.handle.nw{left:-6px;top:-6px;cursor:nwse-resize}
.handle.ne{right:-6px;top:-6px;cursor:nesw-resize}
.handle.sw{left:-6px;bottom:-6px;cursor:nesw-resize}
.handle.se{right:-6px;bottom:-6px;cursor:nwse-resize}
.handle.n{left:50%;top:-6px;transform:translateX(-50%);cursor:ns-resize}
.handle.s{left:50%;bottom:-6px;transform:translateX(-50%);cursor:ns-resize}
.handle.w{left:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize}
.handle.e{right:-6px;top:50%;transform:translateY(-50%);cursor:ew-resize}
.sizebadge{position:absolute;right:8px;bottom:8px;background:#0b1622;color:#cfe9ff;border:1px solid #1e3a55;border-radius:6px;padding:2px 6px;font:12px/1.2 ui-monospace,monospace}
.hint{position:absolute;left:8px;bottom:8px;background:#0b1622;color:#cfe9ff;border:1px solid #1e3a55;border-radius:6px;padding:2px 6px;font:12px/1.2 ui-monospace,monospace}
@media (pointer:coarse){
  .handle{width:16px;height:16px}
  .handle.nw{left:-8px;top:-8px}
  .handle.ne{right:-8px;top:-8px}
  .handle.sw{left:-8px;bottom:-8px}
  .handle.se{right:-8px;bottom:-8px}
  .handle.n{left:50%;top:-8px;transform:translateX(-50%)}
  .handle.s{left:50%;bottom:-8px;transform:translateX(-50%)}
  .handle.w{left:-8px;top:50%;transform:translateY(-50%)}
  .handle.e{right:-8px;top:50%;transform:translateY(-50%)}
}`;
  document.head.appendChild(style);
}

let overlay = null;
let placement = null; // {img,state,x,y,w,h}

function updateFrame() {
  if (!placement || !overlay) return;
  const frame = overlay.querySelector(".import-frame");
  frame.style.left = placement.x + "px";
  frame.style.top = placement.y + "px";
  frame.style.width = placement.w + "px";
  frame.style.height = placement.h + "px";
  const badge = frame.querySelector(".sizebadge");
  badge.textContent = `${Math.round(placement.w)}×${Math.round(placement.h)}`;
}

function cleanup() {
  if (overlay) overlay.remove();
  overlay = null;
  placement = null;
  // Keep the keydown listener; it guards on placement/importActive so it's safe
  window.importActive = false;
  window.requestRender && window.requestRender();
}

function keyHandler(e) {
  if (!placement) return;
  if (e.key === "Escape") {
    e.preventDefault();
    e.stopPropagation();
    cleanup();
  } else if (e.key === "Enter") {
    e.preventDefault();
    e.stopPropagation();
    finalize();
  }
}

document.addEventListener("keydown", keyHandler);

function startOverlay(img, state) {
  ensureStyles();
  window.importActive = true;
  overlay = document.createElement("div");
  overlay.className = "import-overlay";
  overlay.tabIndex = -1;
  document.activeElement && document.activeElement.blur();
  overlay.focus?.();
  overlay.addEventListener("pointerdown", (e) => e.stopPropagation());
  overlay.addEventListener("pointermove", (e) => e.stopPropagation(), {
    passive: true,
  });
  overlay.addEventListener(
    "wheel",
    (e) => {
      e.stopPropagation();
      e.preventDefault();
    },
    { passive: false },
  );
  const frame = document.createElement("div");
  frame.className = "import-frame";
  const canvas = document.createElement("canvas");
  canvas.width = img.naturalWidth;
  canvas.height = img.naturalHeight;
  const ctx = canvas.getContext("2d");
  ctx.imageSmoothingEnabled = false;
  ctx.drawImage(img, 0, 0);
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  frame.appendChild(canvas);
  const handles = ["nw","n","ne","e","se","s","sw","w"];
  for (const h of handles) {
    const d = document.createElement("div");
    d.className = "handle " + h;
    frame.appendChild(d);
  }
  const badge = document.createElement("div");
  badge.className = "sizebadge";
  frame.appendChild(badge);
  overlay.appendChild(frame);
  const stage = document.getElementById("stage");
  stage.appendChild(overlay);
  const vw = innerWidth,
    vh = innerHeight;
  let w = img.naturalWidth,
    h = img.naturalHeight;
  const k = Math.min(1, vw / w, vh / h);
  w *= k;
  h *= k;
  placement = {
    img: canvas,
    state,
    x: (vw - w) / 2,
    y: (vh - h) / 2,
    w,
    h,
    ratio: img.naturalWidth / img.naturalHeight,
  };
  updateFrame();
  let action = null;
  frame.addEventListener("pointerdown", (e) => {
    const target = e.target;
    const mx = e.clientX;
    const my = e.clientY;
    if (target.classList.contains("handle")) {
      action = { type: "resize", dir: [...target.classList].pop(), startX: mx, startY: my, start: { ...placement } };
    } else {
      action = { type: "move", startX: mx, startY: my, start: { ...placement } };
    }
    frame.setPointerCapture(e.pointerId);
  });
  frame.addEventListener("pointermove", (e) => {
    if (!action) return;
    const dx = e.clientX - action.startX;
    const dy = e.clientY - action.startY;
    if (action.type === "move") {
      placement.x = action.start.x + dx;
      placement.y = action.start.y + dy;
      updateFrame();
      return;
    }
    let { x, y, w, h } = action.start;
    const aspect = action.start.ratio;
    const dir = action.dir;
    if (dir.includes("e")) w += dx;
    if (dir.includes("s")) h += dy;
    if (dir.includes("w")) {
      w -= dx;
      x += dx;
    }
    if (dir.includes("n")) {
      h -= dy;
      y += dy;
    }
    if (e.shiftKey) {
      const nw = h * aspect;
      const nh = w / aspect;
      if (dir === "n" || dir === "s") {
        w = nw;
      } else if (dir === "e" || dir === "w") {
        h = nh;
        if (dir === "n") y = action.start.y + action.start.h - h;
      } else {
        if (Math.abs(w / h - aspect) > 0.01) {
          if (Math.abs(dx) > Math.abs(dy)) {
            h = w / aspect;
            if (dir.includes("n")) y = action.start.y + action.start.h - h;
          } else {
            w = h * aspect;
            if (dir.includes("w")) x = action.start.x + action.start.w - w;
          }
        }
      }
    }
    placement.x = x;
    placement.y = y;
    placement.w = Math.max(1, w);
    placement.h = Math.max(1, h);
    updateFrame();
  });
  frame.addEventListener("pointerup", (e) => {
    action = null;
    if (frame.hasPointerCapture?.(e.pointerId))
      frame.releasePointerCapture(e.pointerId);
  });
  frame.addEventListener("pointercancel", (e) => {
    action = null;
    if (frame.hasPointerCapture?.(e.pointerId))
      frame.releasePointerCapture(e.pointerId);
  });
  frame.addEventListener("wheel", (e) => {
    e.preventDefault();
    const ds = Math.exp(-e.deltaY / 500);
    const cx = e.clientX;
    const cy = e.clientY;
    placement.w *= ds;
    placement.h *= ds;
    placement.x = cx - (cx - placement.x) * ds;
    placement.y = cy - (cy - placement.y) * ds;
    updateFrame();
  }, {passive:false});
}

function applyTransformToState(state, tr) {
  if (!state || !state.strokes) return;
  for (const s of state.strokes) {
    if (s.mode === "image") {
      s.x = s.x * tr.scale + tr.x;
      s.y = s.y * tr.scale + tr.y;
      s.w *= tr.scale;
      s.h *= tr.scale;
    } else if (s.mode === "raster") {
      s.runs = s.runs.map((r) => {
        const y = Math.round(r.y * tr.scale + tr.y);
        const x0 = Math.round(r.x0 * tr.scale + tr.x);
        const x1 = Math.round(r.x1 * tr.scale + tr.x);
        return { y, x0, x1, color: r.color };
      });
      s.rowH = (s.rowH ?? 1) * tr.scale;
      s._bbox = computeRasterBBox(s.runs, s.rowH);
    } else {
      s.points = s.points.map((p) => ({
        x: p.x * tr.scale + tr.x,
        y: p.y * tr.scale + tr.y,
      }));
      s.size *= tr.scale;
    }
  }
}
function downscaleCanvas(src, factor) {
  const w = Math.max(1, Math.round(src.width * factor));
  const h = Math.max(1, Math.round(src.height * factor));
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const x = c.getContext("2d");
  x.imageSmoothingEnabled = false;
  x.drawImage(src, 0, 0, w, h);
  return c;
}

function extractRuns(src, step = 16) {
  const { width, height } = src;
  const ctx = src.getContext("2d");
  const img = ctx.getImageData(0, 0, width, height);
  const data = img.data;
  const runs = [];
  const quant = (v) => ((v / step) | 0) * step;
  for (let y = 0; y < height; y++) {
    let x = 0;
    while (x < width) {
      const i = (y * width + x) * 4;
      const a = data[i + 3];
      if (a < 8) {
        x++;
        continue;
      }
      const r = quant(data[i]);
      const g = quant(data[i + 1]);
      const b = quant(data[i + 2]);
      let x0 = x,
        x1 = x;
      for (let xx = x + 1; xx < width; xx++) {
        const j = (y * width + xx) * 4;
        const aa = data[j + 3];
        const rr = quant(data[j]);
        const gg = quant(data[j + 1]);
        const bb = quant(data[j + 2]);
        if (aa < 8 || rr !== r || gg !== g || bb !== b) break;
        x1 = xx;
      }
      const color = `rgb(${r},${g},${b})`;
      runs.push({ y, x0, x1, color });
      x = x1 + 1;
    }
  }
  return runs;
}

function computeRasterBBox(runs, rowH = 1) {
  if (!runs.length) return { x: 0, y: 0, w: 0, h: 0 };
  let minX = Infinity,
    minY = Infinity,
    maxX = -Infinity,
    maxY = -Infinity;
  for (const r of runs) {
    if (r.x0 < minX) minX = r.x0;
    if (r.y < minY) minY = r.y;
    if (r.x1 > maxX) maxX = r.x1;
    if (r.y + rowH > maxY) maxY = r.y + rowH;
  }
  return { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY };
}

function vectorizeToRasterRuns(imgCanvas, worldTransform, opts = {}) {
  const MAX_RUNS = 150000;
  let src = imgCanvas;
  let step = 16;
  let runs = extractRuns(src, step);
  while (runs.length > MAX_RUNS && (src.width > 1 || src.height > 1)) {
    src = downscaleCanvas(src, 0.5);
    runs = extractRuns(src, step);
    if (runs.length > MAX_RUNS && step < 256) {
      step *= 2;
      runs = extractRuns(src, step);
    }
  }
  const pixelScale = imgCanvas.width / src.width;
  const outRuns = runs.map((r) => ({
    y: Math.round(r.y * pixelScale * worldTransform.scale + worldTransform.y),
    x0: Math.round(r.x0 * pixelScale * worldTransform.scale + worldTransform.x),
    x1: Math.round(r.x1 * pixelScale * worldTransform.scale + worldTransform.x),
    color: r.color,
  }));
  const id = window.genId?.() ??
    `imp-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const rowH = pixelScale * worldTransform.scale;
  const stroke = {
    id,
    by: window.meId ?? "local",
    mode: "raster",
    runs: outRuns,
    rowH,
  };
  stroke._bbox = computeRasterBBox(outRuns, rowH);
  return stroke;
}

function vectorizeToBrushStrokes(imgCanvas, worldTransform, opts = {}) {
  const MAX_STROKES = opts.maxStrokes ?? 80000;
  let src = imgCanvas;
  let step = opts.quantStep ?? 16;
  let runs = extractRuns(src, step);

  while (runs.length > MAX_STROKES && (src.width > 1 || src.height > 1)) {
    src = downscaleCanvas(src, 0.5);
    runs = extractRuns(src, step);
    if (runs.length > MAX_STROKES && step < 256) {
      step *= 2;
      runs = extractRuns(src, step);
    }
  }

  const pixelScale = imgCanvas.width / src.width;
  const sizeRaw = pixelScale * worldTransform.scale;
  const size = Math.max(1, Math.round(sizeRaw));
  const chunk = opts.chunk ?? Math.max(2, size - 1);

  const strokes = [];
  for (const r of runs) {
    for (let x = r.x0; x <= r.x1; x += chunk) {
      const xEnd = Math.min(r.x1, x + chunk - 1);
      const x0w = Math.round(x * pixelScale * worldTransform.scale + worldTransform.x);
      const x1w = Math.round((xEnd + 1) * pixelScale * worldTransform.scale + worldTransform.x);
      const yw = Math.round(r.y * pixelScale * worldTransform.scale + worldTransform.y);
      const yCenter = size % 2 === 1 ? yw + 0.5 : yw;

      strokes.push({
        id:
          window.genId?.() ??
          `br-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        by: window.meId ?? "local",
        mode: "draw",
        color: r.color,
        size,
        cap: "butt",
        join: "miter",
        points: [{ x: x0w, y: yCenter }, { x: x1w, y: yCenter }],
      });

      if (strokes.length > MAX_STROKES) break;
    }
    if (strokes.length > MAX_STROKES) break;
  }
  return strokes;
}

async function finalize() {
  if (!placement) return;
  const { img, state } = placement;
  const worldTopLeft = window.screenToWorld(placement.x, placement.y);
  const scale = (placement.w / img.width) / window.camera.scale;
  if (state) {
    // embedded — already normalized to (0,0)
    applyTransformToState(state, { x: worldTopLeft.x, y: worldTopLeft.y, scale });
    window.mergeState(state);
    if (state.strokes)
      for (const s of state.strokes) {
        window.myStack.push(s.id);
        const payload = { ...s };
        if (payload._bbox) delete payload._bbox;
        window.Net.sendReliable({ type: "add", stroke: payload });
      }
  } else {
    // external PNG → brushify
    const strokes = vectorizeToBrushStrokes(
      img,
      {
        x: worldTopLeft.x,
        y: worldTopLeft.y,
        scale,
      },
      { quantStep: 16, maxStrokes: 80000 },
    );

    window.mergeState({ strokes });
    let ops = [];
    for (const s of strokes) {
      window.myStack.push(s.id);
      ops.push({ type: "add", stroke: s });
      if (ops.length >= 1000) {
        window.Net.sendReliable({ type: "batch", ops });
        ops = [];
      }
    }
    if (ops.length) window.Net.sendReliable({ type: "batch", ops });
  }
  window.requestRender();
  window.debounceSave && window.debounceSave();
  cleanup();
}

export async function beginImport(fileOrBlob) {
  if (overlay) cleanup();
  const buf = new Uint8Array(await fileOrBlob.arrayBuffer());
  let state = null;
  try {
    state = findITXtRt(buf);
    if (state?.strokes?.length) normalizeStateToOrigin(state);
  } catch {
    // ignore non-PNG files
  }
  const url = URL.createObjectURL(fileOrBlob);
  const img = new Image();
  try {
    await new Promise((res, rej) => {
      img.onload = () => {
        URL.revokeObjectURL(url);
        res();
      };
      img.onerror = () => {
        URL.revokeObjectURL(url);
        rej(new Error("image load failed"));
      };
      img.src = url;
    });
  } catch {
    cleanup();
    return;
  }
  startOverlay(img, state);
}

window.beginImport = beginImport;
window.vectorizeToRasterRuns = vectorizeToRasterRuns;

