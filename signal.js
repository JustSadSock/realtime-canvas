// signal.js — HTTP (раздаёт ./public) + WebSocket-сигналинг WebRTC
// + простая персистенция состояния комнаты в памяти процесса

const http = require('http');
const fs = require('fs');
const path = require('path');
const WebSocket = require('ws');

const PORT = process.env.PORT || 8090;

// ---- HTTP: отдаём ./public (для локальной проверки клиента)
const server = http.createServer((req, res) => {
  const reqPath = (req.url || '/').split('?')[0];
  if (reqPath === '/healthz') {
    res.writeHead(200, {'Content-Type':'text/plain'}); return res.end('ok');
  }
  const root = path.join(__dirname, 'public');
  let filePath = path.join(root, reqPath === '/' ? 'index.html' : reqPath);
  if (!filePath.startsWith(root)) { res.writeHead(403); return res.end('Forbidden'); }
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); return res.end('Not found'); }
    const ext = path.extname(filePath).slice(1).toLowerCase();
    const mime = {
      html:'text/html', js:'text/javascript', css:'text/css',
      json:'application/json', png:'image/png', svg:'image/svg+xml'
    }[ext] || 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
});

// ---- WS: сигналинг с комнатами + хранение состояния
const wss = new WebSocket.Server({ server });

/** roomId -> Set<ws> */
const rooms = new Map();
/** roomId -> arbitrary state (например {strokes:[...]}) */
const roomStates = new Map();

const uid = () => Math.random().toString(36).slice(2, 10);
const send = (ws, o) => { try { ws.send(JSON.stringify(o)); } catch {} };

wss.on('connection', (ws) => {
  ws.id = uid();
  ws.roomId = null;
  ws.isAlive = true;

  send(ws, { type: 'hello', id: ws.id });

  ws.on('pong', () => (ws.isAlive = true));

  ws.on('message', (buf) => {
    let m; try { m = JSON.parse(buf); } catch { return; }

    // список комнат
    if (m.type === 'list') {
      const list = [...rooms.entries()].map(([id, set]) => ({ id, users: set.size }));
      return send(ws, { type: 'rooms', rooms: list });
    }

    // вход в комнату
    if (m.type === 'join') {
      const roomId = String(m.roomId || '').trim();
      if (!roomId) return send(ws, { type: 'join_error', reason: 'empty_room' });

      // отцепим от старой
      if (ws.roomId) {
        const old = rooms.get(ws.roomId);
        if (old) {
          old.delete(ws);
          for (const c of old) send(c, { type: 'peer_left', id: ws.id });
          if (!old.size) {
            rooms.delete(ws.roomId);
            // по желанию можно чистить roomStates.delete(ws.roomId)
          }
        }
      }
      ws.roomId = roomId;
      if (!rooms.has(roomId)) rooms.set(roomId, new Set());
      const room = rooms.get(roomId);
      room.add(ws);

      const peers = [...room].filter(c => c !== ws).map(c => c.id);
      send(ws, { type: 'joined', id: ws.id, roomId, peers });

      // inform new client about current revision if exists
      const st = roomStates.get(roomId);
      if (st && st.rev != null) send(ws, { type: 'state_rev', rev: st.rev });

      for (const c of room) if (c !== ws) send(c, { type: 'peer_joined', id: ws.id });
      return;
    }

    // пересылка SDP/ICE
    if (m.type === 'signal') {
      if (!ws.roomId) return;
      const room = rooms.get(ws.roomId); if (!room) return;
      const out = { type: 'signal', from: ws.id, payload: m.payload };
      if (m.to) {
        for (const c of room) if (c.id === m.to && c.readyState === 1) return send(c, out);
      } else {
        for (const c of room) if (c !== ws && c.readyState === 1) send(c, out);
      }
      return;
    }

    if (m.type === 'app_ping') {
      return send(ws, { type: 'app_pong', t: m.t });
    }

    // ===== хранение состояния комнаты (снэпшот холста) =====

    // клиент просит отдать сохранённое состояние комнаты
    if (m.type === 'state_load') {
      const st = ws.roomId ? roomStates.get(ws.roomId) : null;
      return send(ws, { type:'state', state: st || null });
    }

    // клиент присылает состояние, сохранить
    if (m.type === 'state_save') {
      if (ws.roomId) {
        const st = m.state || null;
        roomStates.set(ws.roomId, st);
        if (st && st.rev != null) {
          const room = rooms.get(ws.roomId);
          if (room) {
            for (const c of room) if (c.readyState === 1) send(c, { type: 'state_rev', rev: st.rev });
          }
        }
      }
      return;
    }
  });

  ws.on('close', () => {
    if (!ws.roomId) return;
    const room = rooms.get(ws.roomId);
    if (!room) return;
    room.delete(ws);
    for (const c of room) send(c, { type: 'peer_left', id: ws.id });
    if (!room.size) {
      rooms.delete(ws.roomId);
      // по желанию: roomStates.delete(ws.roomId);
    }
  });
});

// heartbeats, чтобы не висли зомби
setInterval(() => {
  for (const ws of wss.clients) {
    if (!ws.isAlive) { try { ws.terminate(); } catch {} }
    else { ws.isAlive = false; try { ws.ping(); } catch {} }
  }
}, 30000);

server.listen(PORT, () => console.log('Signaling HTTP+WS on :' + PORT));
