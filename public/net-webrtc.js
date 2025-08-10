/* global window, fetch, RTCPeerConnection, WebSocket */
window.Net = (function(){
  let cfg=null, sws=null, me=null;
  const peers = new Map(); // peerId -> { pc, dcR, dcU }
  let handlers = { onMsg:()=>{}, onCursor:()=>{}, onPeerOpen:()=>{}, onJoined:()=>{}, onState:()=>{} };

  async function loadConfig(){
    if (cfg) return cfg;
    const r = await fetch('config.json', { cache: 'no-store' });
    cfg = await r.json(); return cfg;
  }
  async function ensureWS(){
    await loadConfig();
    if (sws && sws.readyState===1) return sws;
    return new Promise(res=>{
      sws = new WebSocket(cfg.SIGNAL_URL);
      sws.onopen = ()=> res(sws);
    });
  }
  function wsSend(o){ if (sws && sws.readyState===1) sws.send(JSON.stringify(o)); }
  function signal(to, payload){ wsSend({ type:'signal', to, payload }); }

  function idLess(a,b){ return String(a) < String(b); } // дет. сравнение

  function makePeer(peerId, caller){
    if (peers.has(peerId)) return peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: [{ urls:'stun:stun.l.google.com:19302' }] });
    const p = { pc, dcR:null, dcU:null, opened:false };
    peers.set(peerId, p);

    pc.onicecandidate = e => { if (e.candidate) signal(peerId, { ice:e.candidate }); };
    pc.onconnectionstatechange = ()=> console.log('pc', peerId, pc.connectionState);

    if (caller){
      p.dcR = pc.createDataChannel('reliable', { ordered:true });
      p.dcU = pc.createDataChannel('cursor',   { ordered:false, maxRetransmits:0 });
      wire(peerId, p);
    } else {
      pc.ondatachannel = ev=>{
        if (ev.channel.label==='reliable') p.dcR = ev.channel;
        if (ev.channel.label==='cursor')   p.dcU = ev.channel;
        wire(peerId, p);
      };
    }
    return p;
  }

  function wire(peerId, p){
    const bind = (ch, handler)=>{
      if (!ch) return;
      ch.onopen = ()=>{
        console.log('dc open', peerId, ch.label);
        if (!p.opened && p.dcR && p.dcR.readyState==='open' && p.dcU && p.dcU.readyState==='open'){
          p.opened = true; handlers.onPeerOpen(peerId);
        }
      };
      ch.onclose = ()=> console.log('dc close', peerId, ch.label);
      ch.onmessage = e=>{
        try{
          const payload = JSON.parse(e.data);
          handler({ id: peerId, ...payload });
        }catch{}
      };
    };
    bind(p.dcR, m=> handlers.onMsg(m));
    bind(p.dcU, c=> handlers.onCursor(c));
  }

  async function call(peerId){
    const p = makePeer(peerId, true);
    const offer = await p.pc.createOffer();
    await p.pc.setLocalDescription(offer);
    signal(peerId, { offer });
  }

  async function onSignal(from, payload){
    if (payload.offer){
      const p = makePeer(from, false);
      await p.pc.setRemoteDescription(payload.offer);
      const ans = await p.pc.createAnswer();
      await p.pc.setLocalDescription(ans);
      signal(from, { answer: ans });
    } else if (payload.answer){
      const p = peers.get(from); if (p) await p.pc.setRemoteDescription(payload.answer);
    } else if (payload.ice){
      const p = peers.get(from); if (p) try{ await p.pc.addIceCandidate(payload.ice); }catch{}
    }
  }

  async function connect(roomId, h){
    handlers = Object.assign({ onMsg:()=>{}, onCursor:()=>{}, onPeerOpen:()=>{}, onJoined:()=>{}, onState:()=>{} }, h||{});
    await ensureWS();
    sws.onmessage = (e)=>{
      const m = JSON.parse(e.data);
      if (m.type==='hello'){ /* noop */ }
      if (m.type==='joined'){
        me = m.id;
        handlers.onJoined({ me, peers: m.peers||[] });
        // дет. дозвон: звоним только тем, чей id больше нашего
        (m.peers||[]).forEach(pid=>{ if (idLess(me, pid)) call(pid); });
      }
      if (m.type==='peer_joined'){
        // новый пир: звоним ему, если наш id меньше
        if (idLess(me, m.id)) call(m.id);
      }
      if (m.type==='peer_left'){ peers.delete(m.id); }
      if (m.type==='signal'){ onSignal(m.from, m.payload); }
      if (m.type==='state'){ handlers.onState(m.state); } // серверная персистенция
    };
    wsSend({ type:'join', roomId });
  }

  // WS-канал для серверного состояния
  function requestState(){ wsSend({ type:'state_load' }); }
  function saveState(state){ wsSend({ type:'state_save', state }); }

  // отправки
  function sendReliable(obj){
    const s = JSON.stringify(obj);
    for (const p of peers.values()) if (p.dcR && p.dcR.readyState==='open') p.dcR.send(s);
  }
  function sendReliableTo(peerId, obj){
    const p = peers.get(peerId);
    if (p && p.dcR && p.dcR.readyState==='open') p.dcR.send(JSON.stringify(obj));
  }
  function sendCursor(obj){
    const s = JSON.stringify(obj);
    for (const p of peers.values()) if (p.dcU && p.dcU.readyState==='open') p.dcU.send(s);
  }

  return { connect, requestState, saveState, sendReliable, sendReliableTo, sendCursor };
})();
