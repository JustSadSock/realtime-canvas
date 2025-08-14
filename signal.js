#!/usr/bin/env node
/**
 * Minimal-but-robust signaling server for WebRTC.
 * - WS path: /ws (configurable)
 * - Keep-alive: server → ping every 10s, close on 20s silence (sends proper close frame)
 * - Accepts client "ping" messages and replies "pong"
 * - Rooms with relay, optional state cache (state_req/state_save)
 * - Lists rooms: {type:"list"} → {type:"rooms", rooms:[{id,count}]}
 * - Serves /config.json with SIGNAL_URL
 */

const http = require("http");
const { WebSocketServer } = require("ws");
const url = require("url");
const crypto = require("crypto");

// ---------- config ----------
const PORT = +(process.env.PORT || arg("--port", "8090"));
const WS_PATH = process.env.WS_PATH || arg("--path", "/ws") || "/ws";
// PUBLIC_WS_URL влияет на /config.json
const PUBLIC_WS_URL =
  process.env.PUBLIC_WS_URL || arg("--public", "") || "";

// keep-alive: ping раз в 10с, ждём 20с
const KA_INTERVAL_MS = 10_000;
const KA_TIMEOUT_MS = 20_000;

// ---------- state ----------
/** @type {Map<string, Set<WebSocket>>} */
const rooms = new Map();
/** @type {WeakMap<WebSocket, {id:string, roomId?:string, isAlive:boolean, ua?:string, ip?:string}>} */
const peers = new WeakMap();
/** @type {Map<string, any>} */
const roomState = new Map(); // state_save/state_req

// ---------- utils ----------
function arg(name, def) {
  const i = process.argv.indexOf(name);
  return i > -1 ? (process.argv[i + 1] || def) : def;
}
function rid(n = 8) {
  return crypto.randomBytes(n).toString("hex");
}
function nowISO() {
  return new Date().toISOString().replace("T", " ").replace("Z", "");
}
function log(...a) {
  console.log(`[signal] ${nowISO()}`, ...a);
}
function safeSend(ws, obj) {
  if (!ws || ws.readyState !== ws.OPEN) return;
  try { ws.send(JSON.stringify(obj)); } catch {}
}
function addToRoom(roomId, ws) {
  let set = rooms.get(roomId);
  if (!set) rooms.set(roomId, (set = new Set()));
  set.add(ws);
}
function rmFromRoom(roomId, ws) {
  const set = rooms.get(roomId);
  if (!set) return;
  set.delete(ws);
  if (set.size === 0) rooms.delete(roomId);
}

// ---------- HTTP server ----------
const server = http.createServer((req, res) => {
  const u = url.parse(req.url || "", true);
  if (u.pathname === "/config.json") {
    // Формируем SIGNAL_URL: либо PUBLIC_WS_URL, либо локальный ws://host:PORT/WS_PATH
    let wsUrl = PUBLIC_WS_URL.trim();
    if (!wsUrl) {
      const host = req.headers["host"] || `localhost:${PORT}`;
      const scheme = (req.headers["x-forwarded-proto"] || "http") === "https" ? "wss" : "ws";
      const path = WS_PATH.startsWith("/") ? WS_PATH : `/${WS_PATH}`;
      wsUrl = `${scheme}://${host}${path}`;
    }
    const payload = JSON.stringify({ SIGNAL_URL: wsUrl });
    res.writeHead(200, {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
      "Access-Control-Allow-Origin": "*",
    });
    return void res.end(payload);
  }

  // простая диагностика
  if (u.pathname === "/" || u.pathname === "/healthz") {
    res.writeHead(200, { "Content-Type": "text/plain" });
    return void res.end("ok\n");
  }

  res.writeHead(404);
  res.end();
});

// ---------- WS server ----------
const wss = new WebSocketServer({
  server,
  path: WS_PATH,
  // perMessageDeflate можно выключить для простоты через прокси
  perMessageDeflate: false,
  clientTracking: true,
});

wss.on("connection", (ws, req) => {
  const id = rid(6);
  const ip =
    req.headers["x-forwarded-for"]?.toString().split(",")[0].trim() ||
    req.socket.remoteAddress ||
    "";
  const ua = req.headers["user-agent"] || "";
  peers.set(ws, { id, isAlive: true, ua, ip });

  log(`WS connection #${id} ip=${ip} ua="${ua}"`);

  // Бразуер сам отвечает на ping-фреймы "pong". Мы ещё слушаем "pong" явно:
  ws.on("pong", () => {
    const p = peers.get(ws);
    if (p) p.isAlive = true;
  });

  ws.on("message", (data) => {
    let msg = null;
    try { msg = JSON.parse(data.toString("utf8")); } catch {}
    if (!msg || typeof msg !== "object") return;

    const meta = peers.get(ws) || { id };
    // Ответ на прикладной ping/pong
    if (msg.type === "ping") {
      safeSend(ws, { type: "pong", t: msg.t ?? Date.now() });
      return;
    }

    if (msg.type === "join" || msg.type === "hello") {
      const roomId = String(msg.roomId || msg.room || "public-room");
      meta.roomId = roomId;
      peers.set(ws, meta);
      addToRoom(roomId, ws);
      log(`#${id} joined "${roomId}" (size=${rooms.get(roomId)?.size || 0})`);
      // отдадим состояние, если есть
      const st = roomState.get(roomId);
      if (st) safeSend(ws, { type: "state_full", state: st });
      // уведомление о пирах (минимально)
      safeSend(ws, { type: "peers", room: roomId, count: rooms.get(roomId)?.size || 1 });
      return;
    }

    if (msg.type === "relay" && meta.roomId) {
      // ретрансляция в комнату (кроме отправителя)
      const room = rooms.get(meta.roomId);
      if (!room) return;
      for (const client of room) {
        if (client !== ws && client.readyState === client.OPEN) {
          safeSend(client, msg.op);
        }
      }
      return;
    }

    if (msg.type === "state_req" && meta.roomId) {
      const st = roomState.get(meta.roomId);
      if (st) safeSend(ws, { type: "state_full", state: st });
      return;
    }

    if (msg.type === "state_save" && meta.roomId && msg.state) {
      roomState.set(meta.roomId, msg.state);
      return;
    }

    if (msg.type === "list") {
      const out = [...rooms.entries()].map(([id, set]) => ({ id, count: set.size }));
      safeSend(ws, { type: "rooms", rooms: out });
      return;
    }

    // по умолчанию — просто эхо в клиента (для дебага)
    safeSend(ws, { type: "ack", ok: true });
  });

  ws.on("close", (code, reason) => {
    const meta = peers.get(ws);
    const roomId = meta?.roomId;
    if (roomId) rmFromRoom(roomId, ws);
    log(`WS close #${meta?.id || "?"} code=${code} reason="${reason}" room=${roomId || "-"}`);
    peers.delete(ws);
  });

  ws.on("error", (err) => {
    log(`WS error #${peers.get(ws)?.id || "?"}:`, err.message || err);
  });
});

// keep-alive цикл: пингуем, закрываем «зависших»
const ka = setInterval(() => {
  for (const ws of wss.clients) {
    const meta = peers.get(ws);
    if (!meta) continue;
    if (meta.isAlive === false) {
      try { ws.close(1001, "ping timeout"); } catch {}
      continue;
    }
    meta.isAlive = false;
    peers.set(ws, meta);
    try { ws.ping(); } catch {}
  }
}, KA_INTERVAL_MS);

// аккуратно закрыть по SIGINT/SIGTERM
function shutdown() {
  clearInterval(ka);
  for (const ws of wss.clients) {
    try { ws.close(1001, "server shutdown"); } catch {}
  }
  server.close(() => process.exit(0));
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

// ---------- start ----------
server.listen(PORT, () => {
  log(`listening on :${PORT}  WS path: ${WS_PATH}`);
  const fallback = `ws://localhost:${PORT}${WS_PATH.startsWith("/") ? WS_PATH : "/" + WS_PATH}`;
  const announced = PUBLIC_WS_URL || fallback;
  log(`For config.json set: { "SIGNAL_URL": "${announced}" }`);
});
