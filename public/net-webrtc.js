/* global window, fetch, RTCPeerConnection, WebSocket */
window.Net = (function(){
  let cfg=null, sws=null, me=null, roomId=null, iAmHost=false;
  const peers = new Map(); // peerId -> { pc, dcR, dcU }
  let onMsg = () => {}, onCursor = () => {};

  async function loadConfig(){
    if (cfg) return cfg;
    const r = await fetch('config.json', { cache: 'no-store' });
    cfg = await r.json();
    return cfg;
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

  function makePeer(peerId, caller){
    if (peers.has(peerId)) return peers.get(peerId);
    const pc = new RTCPeerConnection({ iceServers: [{ urls:'stun:stun.l.google.com:19302' }] });
    const p = { pc, dcR:null, dcU:null };
    peers.set(peerId, p);

    pc.onicecandidate = e => { if (e.candidate) signal(peerId, { ice:e.candidate }); };
    pc.onconnectionstatechange = ()=> console.log('pc', peerId, pc.connectionState);

    if (caller){
      p.dcR = pc.createDataChannel('reliable', { ordered: true });
      p.dcU = pc.createDataChannel('cursor',   { ordered: false, maxRetransmits: 0 });
      wire(peerId, p);
    } else {
      pc.ondatachannel = ev => {
        if (ev.channel.label==='reliable') p.dcR = ev.channel;
        if (ev.channel.label==='cursor')   p.dcU = ev.channel;
        wire(peerId, p);
      };
    }
    return p;
  }

  function wire(peerId, p){
    const bind = (ch, handler) => {
      if (!ch) return;
      ch.onopen = ()=> console.log('dc open', peerId, ch.label);
      ch.onclose = ()=> console.log('dc close', peerId, ch.label);
      ch.onmessage = e => {
        try{
          const payload = JSON.parse(e.data);
          handler({ id: peerId, ...payload });
        }catch{ /* ignore non-JSON */ }
      };
    };
    bind(p.dcR, msg => onMsg(msg));
    bind(p.dcU, cur => onCursor(cur));
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

  async function connect(room, handlers){
    ({ onMsg = ()=>{}, onCursor = ()=>{} } = handlers || {});
    await ensureWS();
    roomId = room;
    sws.onmessage = (e)=>{
      const m = JSON.parse(e.data);
      if (m.type==='hello'){ /* noop */ }
      if (m.type==='joined'){ me=m.id; if (iAmHost) (m.peers||[]).forEach(call); }
      if (m.type==='peer_joined'){ if (iAmHost) call(m.id); }
      if (m.type==='peer_left'){ peers.delete(m.id); }
      if (m.type==='signal'){ onSignal(m.from, m.payload); }
    };
    wsSend({ type:'join', roomId });
  }

  async function rooms(){
    await ensureWS();
    return new Promise(res=>{
      const tmp = new WebSocket(cfg.SIGNAL_URL);
      tmp.onopen = ()=> tmp.send(JSON.stringify({ type:'list' }));
      tmp.onmessage = (e)=>{ const m=JSON.parse(e.data); if(m.type==='rooms'){ tmp.close(); res(m.rooms||[]); } };
    });
  }

  function setHost(v){ iAmHost = !!v; }
  function sendReliable(obj){
    const s = JSON.stringify(obj);
    for (const p of peers.values()) if (p.dcR && p.dcR.readyState==='open') p.dcR.send(s);
  }
  function sendCursor(obj){
    const s = JSON.stringify(obj);
    for (const p of peers.values()) if (p.dcU && p.dcU.readyState==='open') p.dcU.send(s);
  }

  return { connect, rooms, setHost, sendReliable, sendCursor };
})();
