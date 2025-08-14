// net-webrtc.js — P2P DataChannels + WS сигналинг + relay-fallback + TURN-готовность
// Глобальный объект Net с API:
//   Net.connect(roomId, { onJoined, onPeerOpen, onState, onMsg, onCursor })
//   Net.sendReliable(obj)
//   Net.sendReliableTo(peerId, obj)
//   Net.sendCursor({x,y,drawing})
//   Net.requestState()
//   Net.saveState(state)   // state должен включать rev, если используешь ревизии
//   Net.disconnect()
//
// Конфиг берётся из public/config.json:
//   {
//     "SIGNAL_URL": "wss://...",
//     "ICE_SERVERS": [ { "urls": ["stun:stun.l.google.com:19302"] } ],
//     "TURN": [ { "urls": ["turn:host:3478","turns:host:5349"], "username":"u", "credential":"p" } ]
//   }
// ICE_SERVERS/ TURN — опциональны. Если их нет — используем только STUN Google.

(() => {
  const defaultIce = [{ urls: ["stun:stun.l.google.com:19302"] }];

  let cfg = { SIGNAL_URL: "ws://localhost:8090", ICE_SERVERS: defaultIce, TURN: [] };

  // загружаем config.json (без кэша)
  fetch("config.json", { cache: "no-store" })
    .then((r) => {
      if (!r.ok) throw new Error(`config.json HTTP ${r.status}`);
      return r.json();
    })
    .then((j) => {
      console.info("[signal] config.json =", j);
      if (j && j.SIGNAL_URL) cfg.SIGNAL_URL = j.SIGNAL_URL;
      cfg.ICE_SERVERS = Array.isArray(j?.ICE_SERVERS) && j.ICE_SERVERS.length ? j.ICE_SERVERS : defaultIce;
      if (Array.isArray(j?.TURN) && j.TURN.length) cfg.ICE_SERVERS = [...cfg.ICE_SERVERS, ...j.TURN];
    })
    .catch((e) => console.error("[signal] failed to read config.json:", e));

  // ===== Внутреннее состояние =====
  let sws = null;            // WebSocket к сигналингу
  let roomId = null;
  let meId = null;
  let handlers = {};
  const peers = new Map();   // id -> { pc, dcR, dcC }
  let lowPaused = false;

  const WS_SUBPROTOCOL = null; // e.g. 'webrtc'
  let pingTimer = null;
  let retries = 0;
  let lastConnect = { room: null, handlers: {}, url: null };
  let manualClose = false;

  function noop() {}

  // ===== Утилиты =====
  function wsSend(o) {
    try { if (sws && sws.readyState === 1) sws.send(JSON.stringify(o)); } catch {}
  }

  function log(...a) { console.log(...a); }

  function dcOpenCount() {
    let n = 0;
    for (const p of peers.values()) if (p.dcR && p.dcR.readyState === "open") n++;
    return n;
  }

  function startPing(ws) {
    stopPing();
    pingTimer = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        try { ws.send(JSON.stringify({ type: "app_ping", t: Date.now() })); } catch {}
      }
    }, 15000);
  }

  function stopPing() {
    if (pingTimer) clearInterval(pingTimer);
    pingTimer = null;
  }

  function scheduleReconnect() {
    if (manualClose) return;
    const base = Math.min(30000, 1000 * Math.pow(2, retries++));
    const jitter = Math.floor(Math.random() * 300);
    const delay = base + jitter;
    console.info("[signal] reconnect in", delay, "ms");
    setTimeout(() => {
      try {
        connect(lastConnect.room, lastConnect.handlers, lastConnect.url);
      } catch (e) {
        console.error("reconnect failed", e);
        scheduleReconnect();
      }
    }, delay);
  }

  // ===== Основное API =====
  const Net = {
    connect,
    sendReliable,
    sendReliableTo,
    sendCursor,
    requestState,
    saveState,
    disconnect,
    pingServer,
    canSendLow,
  };
  window.Net = Net;

  // ===== Реализация =====

  function connect(targetRoomId, h = {}, signalUrl) {
    handlers = {
      onJoined: h.onJoined || noop,
      onPeerOpen: h.onPeerOpen || noop,
      onState: h.onState || noop,
      onMsg: h.onMsg || noop,
      onCursor: h.onCursor || noop,
      onClose: h.onClose || noop,
      onPong: h.onPong || noop,
    };
    roomId = String(targetRoomId || window.roomId || "public-room");

    lastConnect = { room: roomId, handlers: h, url: signalUrl };

    if (sws) {
      // чтобы onclose старого сокета не запустил scheduleReconnect()
      manualClose = true;
      try { sws.close(1000, "done"); } catch {}
      sws = null;
    }
    manualClose = false; // для нового соединения

    let url = typeof signalUrl === "string" ? signalUrl : cfg.SIGNAL_URL;
    if (typeof location !== "undefined" && location.protocol === "https:" && url.startsWith("ws:")) {
      url = url.replace(/^ws:/, "wss:");
    }

    sws = WS_SUBPROTOCOL ? new WebSocket(url, [WS_SUBPROTOCOL]) : new WebSocket(url);
    sws.addEventListener("open", () => {
      retries = 0;
      console.info("[signal] open", sws.url);
      const hello = { type: "join", roomId };
      try {
        sws.send(JSON.stringify(hello));
        console.debug("[signal] ->", hello);
      } catch (e) {
        console.error("hello send failed", e);
      }
      startPing(sws);
    });
    sws.addEventListener("close", (e) => {
      console.warn("[signal] close", { code: e.code, reason: e.reason, wasClean: e.wasClean });
      stopPing();
      for (const [id, p] of peers) closePeer(id, p);
      peers.clear();
      try { handlers.onClose(e); } catch {}
      scheduleReconnect();
    });
    sws.addEventListener("error", (e) => {
      console.error("[signal] error", e);
    });

    sws.addEventListener("message", (e) => {
      let m = null;
      try { m = JSON.parse(e.data); } catch { return; }

      // отладка:
      // log("ws rx", m);

      if (m.type === "hello") {
        meId = m.id;
        return;
      }
      if (m.type === "joined") {
        meId = m.id;
        log("pc", "joined", roomId, "peers", m.peers);
        handlers.onJoined({ me: meId, peers: m.peers || [] });

        // инициируем коннекты ко всем текущим пирами
        for (const pid of m.peers || []) ensurePeer(pid, /*initiator*/ true);
        return;
      }
      if (m.type === "peer_joined") {
        ensurePeer(m.id, /*initiator*/ true);
        return;
      }
      if (m.type === "peer_left") {
        const p = peers.get(m.id);
        if (p) closePeer(m.id, p);
        peers.delete(m.id);
        return;
      }
      if (m.type === "state_rev") {
        if ((m.rev | 0) > (window.rev | 0)) {
          if (typeof window.schedulePull === "function") window.schedulePull();
        }
        return;
      }
      if (m.type === "state") {
        // серверный снапшот/обновление
        handlers.onState(m.state);
        return;
      }
      if (m.type === "relay") {
        // приём ретранслированной операции (fallback)
        const op = m.op || {};
        routeOpFromPeer(m.from, op);
        return;
      }
      if (m.type === "app_pong") {
        handlers.onPong(m.t);
        return;
      }
      if (m.type === "signal") {
        const from = m.from;
        const payload = m.payload || {};
        if (payload.offer) {
          // входящий оффер -> создаём приёмника
          const pr = ensurePeer(from, /*initiator*/ false);
          onOffer(pr, from, payload.offer);
          return;
        }
        if (payload.answer) {
          const pr = peers.get(from);
          if (pr && pr.pc.signalingState !== "stable") {
            pr.pc.setRemoteDescription(payload.answer).catch((err) => log("setRemote(answer) fail", err));
          }
          return;
        }
        if (payload.ice) {
          const pr = peers.get(from);
          if (pr && payload.ice && payload.ice.candidate) {
            pr.pc.addIceCandidate(payload.ice).catch((err) => log("addIce fail", err));
          }
          return;
        }
      }
        // игнор остального
      });
  }

  function disconnect() {
    manualClose = true;
    stopPing();
    if (sws) { try { wsSend({ type: "leave" }); sws.close(1000, "done"); } catch {} sws = null; }
    for (const [id, p] of peers) closePeer(id, p);
    peers.clear();
    roomId = null;
    meId = null;
  }

  function pingServer(t) {
    wsSend({ type: "app_ping", t });
  }

  function requestState() {
    wsSend({ type: "state_load" });
  }

  function saveState(state) {
    // state желательно должен содержать rev (инкрементируется на клиенте)
    wsSend({ type: "state_save", state });
  }

  // отправка надёжных сообщений всем
  function sendReliable(obj) {
    const s = JSON.stringify(obj);
    let sent = 0;
    for (const [id, p] of peers) {
      if (p.dcR && p.dcR.readyState === "open") {
        try { p.dcR.send(s); sent++; } catch {}
      }
    }
    // relay-fallback: если нет ни одного открытого DC — ретранслируем через сервер
    if (sent === 0) wsSend({ type: "relay", op: obj });
  }

  // адресная отправка надёжного сообщения
  function sendReliableTo(peerId, obj) {
    const p = peers.get(peerId);
    const s = JSON.stringify(obj);
    if (p && p.dcR && p.dcR.readyState === "open") {
      try { p.dcR.send(s); return; } catch {}
    }
    // адресной ретрансляции на сервере нет — пошлём широковещательно (лучше, чем тишина)
    wsSend({ type: "relay", op: obj });
  }

  // курсоры: быстрая рассылка по "легкому" каналу, без гарантии доставки
  function sendCursor({ x, y, drawing }) {
    if (!canSendLow()) return;
    const obj = { type: "cursor", x, y, drawing: !!drawing };
    const s = JSON.stringify(obj);
    let sent = 0;
    for (const p of peers.values()) {
      if (p.dcC && p.dcC.readyState === "open") {
        try { p.dcC.send(s); sent++; } catch {}
      }
    }
    if (sent === 0) {
      wsSend({ type: "relay", op: obj });
    }
  }

  function dcLowBuffersOk() {
    let max = 0;
    for (const p of peers.values()) {
      if (p.dcC && p.dcC.readyState === "open") {
        max = Math.max(max, p.dcC.bufferedAmount || 0);
      }
    }
    // Порог ~256К на самый забитый low-канал
    return max < 262144;
  }

  function canSendLow() {
    // если WS fallback забит — притормаживаем, но не блокируем dcC, если он ок
    const wsBusy = !!(sws && sws.bufferedAmount > 2000000);
    const dcOk = dcLowBuffersOk();
    if (wsBusy && !dcOk) {
      lowPaused = true;
      return false;
    }
    if (lowPaused) {
      const wsRecovered = !sws || sws.bufferedAmount < 500000;
      if (wsRecovered && dcOk) lowPaused = false;
    }
    return true;
  }

  // ===== WebRTC =====

  function iceServers() {
    return cfg.ICE_SERVERS || defaultIce;
  }

  function ensurePeer(peerId, initiator) {
    let pr = peers.get(peerId);
    if (pr) return pr;

    const pc = new RTCPeerConnection({ iceServers: iceServers() });
    const stateLog = () => log("pc", peerId, pc.connectionState);

    pc.onicecandidate = (ev) => {
      if (ev.candidate) {
        wsSend({ type: "signal", to: peerId, payload: { ice: ev.candidate } });
      }
    };
    pc.onconnectionstatechange = () => {
      stateLog();
      if (pc.connectionState === "failed" || pc.connectionState === "disconnected" || pc.connectionState === "closed") {
        // подчищаем
        const p = peers.get(peerId);
        if (p) closePeer(peerId, p);
        peers.delete(peerId);
      }
      if (pc.connectionState === "connected") {
        handlers.onPeerOpen(peerId);
      }
    };
    pc.ondatachannel = (ev) => {
      const ch = ev.channel;
      bindChannel(peerId, ch);
    };

    const prNew = { pc, dcR: null, dcC: null };
    peers.set(peerId, prNew);

    if (initiator) {
      // создаём свои каналы
      const dcR = pc.createDataChannel("reliable", { ordered: true });
      bindChannel(peerId, dcR);

      // "лёгкий" канал для курсоров (без гарантии)
      const dcC = pc.createDataChannel("cursor", { ordered: false, maxRetransmits: 0 });
      bindChannel(peerId, dcC);

      // оффер
      pc.createOffer()
        .then((offer) => pc.setLocalDescription(offer).then(() => offer))
        .then((offer) => {
          wsSend({ type: "signal", to: peerId, payload: { offer } });
        })
        .catch((err) => log("createOffer fail", err));
    }

    log("pc", peerId, "connecting");
    return prNew;
  }

  function onOffer(pr, from, offer) {
    pr.pc
      .setRemoteDescription(offer)
      .then(() => pr.pc.createAnswer())
      .then((ans) => pr.pc.setLocalDescription(ans).then(() => ans))
      .then((ans) => {
        wsSend({ type: "signal", to: from, payload: { answer: ans } });
      })
      .catch((err) => log("offer/answer fail", err));
  }

  function bindChannel(peerId, ch) {
    if (!ch) return;
    const p = peers.get(peerId);
    if (!p) return;

    if (ch.label === "reliable") p.dcR = ch;
    if (ch.label === "cursor") p.dcC = ch;

    ch.onopen = () => log("dc open", peerId, ch.label);
    ch.onclose = () => log("dc close", peerId, ch.label);
    ch.onerror = (e) => log("dc error", peerId, ch.label, e?.message || e);

    ch.onmessage = (ev) => {
      let obj = null;
      try { obj = JSON.parse(ev.data); } catch { return; }
      routeOpFromPeer(peerId, obj);
    };
  }

  function routeOpFromPeer(fromId, obj) {
    // специальный путь для курсоров
    if (obj && obj.type === "cursor") {
      handlers.onCursor({ id: fromId, x: obj.x, y: obj.y, drawing: !!obj.drawing });
      return;
    }
    // состояние (если кто-то прислал снапшот напрямую)
    if (obj && (obj.type === "state" || obj.type === "state_full") && obj.state) {
      handlers.onState(obj.state);
      return;
    }
    // всё остальное — в пользовательский обработчик (штрихи, undo/redo и т.п.)
    handlers.onMsg(obj);
  }

  function closePeer(id, p) {
    try { p.dcR && p.dcR.close(); } catch {}
    try { p.dcC && p.dcC.close(); } catch {}
    try { p.pc && p.pc.close(); } catch {}
    log("pc", id, "closed");
  }
})();
