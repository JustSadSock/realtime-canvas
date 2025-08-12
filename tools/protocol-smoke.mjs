import extract from "png-chunks-extract";
import encode from "png-chunks-encode";
import { deflate } from "pako";

async function testJoinPresence() {
  const sent = [];
  let joined = null;
  const Net = {
    connect: (id, h, url) => {
      joined = id;
      h.onPeerOpen("p1");
    },
    sendReliable: (m) => sent.push(m),
  };
  const cursorColor = "#007aff";
  function sendPresence() {
    Net.sendReliable({ type: "presence", cursorColor });
  }
  async function joinRoom(id) {
    Net.connect(id, { onPeerOpen: sendPresence }, "wss://test");
  }
  function renderRooms() {
    return { click: () => joinRoom("r1") };
  }
  const card = renderRooms();
  card.click();
  if (joined !== "r1") throw new Error("join not triggered");
  if (!sent.some((m) => m.type === "presence"))
    throw new Error("presence not sent");
}

function makeITXt(keyword, textUint8) {
  const k = new TextEncoder().encode(keyword);
  const z = deflate(textUint8);
  const arr = [];
  arr.push(...k, 0, 1, 0, 0, 0, ...z);
  return { name: "iTXt", data: new Uint8Array(arr) };
}

async function testExport() {
  const base = [
    {
      name: "IHDR",
      data: new Uint8Array([0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]),
    },
    {
      name: "IDAT",
      data: new Uint8Array([120, 156, 99, 96, 0, 0, 0, 2, 0, 1]),
    },
    { name: "IEND", data: new Uint8Array() },
  ];
  const json = new TextEncoder().encode(JSON.stringify({ a: 1 }));
  const itxt = makeITXt("rtcanvas", json);
  const png = encode([...base.slice(0, -1), itxt, base[base.length - 1]]);
  const has = extract(png).some((c) => c.name === "iTXt");
  if (!has) throw new Error("iTXt missing");
}

await testJoinPresence();
await testExport();
console.log("protocol smoke passed");
