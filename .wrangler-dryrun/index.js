var __defProp = Object.defineProperty;
var __name = (target, value) => __defProp(target, "name", { value, configurable: true });

// src/relay.ts
var EMPTY_SCENE = JSON.stringify({ type: "scene", nodes: [], variables: [], ts: 0 });
var ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1e3;
var cors = /* @__PURE__ */ __name((res) => {
  res.headers.set("Access-Control-Allow-Origin", "*");
  res.headers.set("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.headers.set("Access-Control-Allow-Headers", "content-type");
  return res;
}, "cors");
var json = /* @__PURE__ */ __name((obj) => new Response(JSON.stringify(obj), { headers: { "content-type": "application/json" } }), "json");
var Relay = class {
  state;
  env;
  // Big base64 textures live in memory only; re-streamed by the plugin on
  // connect. scene/library persist to storage (see brief §2).
  assets;
  assetsLoaded;
  // Player builds, namespaced PER LAND so separate ?land=<id> worlds don't mix
  // while CONTENT (scene/library/assets) stays shared in this one DO. lands:
  // landId -> (cell "x,y,z" -> {val,ts}); persisted as "b:<land>:<cell>". Lazy.
  lands;
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this.assets = /* @__PURE__ */ new Map();
    this.assetsLoaded = false;
    this.lands = /* @__PURE__ */ new Map();
  }
  // Lazily hydrate textures from DO storage so CONTENT survives eviction / days
  // with no plugin connected (small pixel-art PNGs are well under the value limit).
  async ensureAssets() {
    if (this.assetsLoaded)
      return;
    this.assetsLoaded = true;
    const rows = await this.state.storage.list({ prefix: "a:" });
    for (const [k, v] of rows) {
      const key = k.slice(2);
      if (!this.assets.has(key))
        this.assets.set(key, v);
    }
  }
  static landId(raw) {
    return (raw || "home").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48) || "home";
  }
  // Lazily hydrate ONE land from DO storage (survives hibernation/cold start).
  async ensureLand(landId) {
    let m = this.lands.get(landId);
    if (m)
      return m;
    m = /* @__PURE__ */ new Map();
    const pre = "b:" + landId + ":";
    const rows = await this.state.storage.list({ prefix: pre });
    for (const [k, v] of rows)
      m.set(k.slice(pre.length), v);
    this.lands.set(landId, m);
    return m;
  }
  // Mark the room as alive NOW. Called on every connect and every inbound message, so a
  // room only goes stale after a continuous TTL window with zero traffic. Persisted (the
  // wipe check on a later cold start reads it from storage, not an instance field).
  async touch() {
    try {
      await this.state.storage.put("lastSeen", Date.now());
    } catch {
    }
  }
  // Inactivity rebirth. If this room has had NO traffic for longer than ROOM_TTL_MS and is
  // not the lobby (figager), erase its whole world so it is reborn empty: builds (b:*),
  // assets (a:*), scene, library, race, owner, destroyable, published, thumb — everything
  // except we re-stamp roomName + lastSeen. We deleteAll() (simplest + covers every key,
  // incl. directory keys which only live on the singleton DO anyway) then restore identity.
  // First-ever connect (no lastSeen yet) is NOT a wipe — touch() will stamp it.
  async maybeWipeStale(roomName) {
    if (roomName === "figager")
      return;
    let lastSeen;
    try {
      lastSeen = await this.state.storage.get("lastSeen");
    } catch {
    }
    if (typeof lastSeen !== "number")
      return;
    if (Date.now() - lastSeen <= ROOM_TTL_MS)
      return;
    try {
      await this.state.storage.deleteAll();
    } catch {
    }
    this.lands.clear();
    this.assets.clear();
    this.assetsLoaded = false;
    try {
      await this.state.storage.put("roomName", roomName);
    } catch {
    }
    try {
      await this.state.storage.put("lastSeen", Date.now());
    } catch {
    }
  }
  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "OPTIONS")
      return cors(new Response(null, { status: 204 }));
    const sanRoom = /* @__PURE__ */ __name((s) => String(s || "").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48), "sanRoom");
    if (request.method === "POST" && url.pathname === "/report") {
      let body = {};
      try {
        body = await request.json();
      } catch {
      }
      const room = sanRoom(body.room);
      if (!room || room === "figager")
        return cors(json({ ok: false }));
      const cid = String(body.clientId || "anon").slice(0, 32);
      const now = Date.now();
      const e = await this.state.storage.get("dir:" + room) || { clients: {}, destroyable: false };
      e.clients[cid] = now;
      for (const k in e.clients)
        if (now - e.clients[k] > 45e3)
          delete e.clients[k];
      e.players = Object.keys(e.clients).length;
      if (typeof body.destroyable === "boolean")
        e.destroyable = body.destroyable;
      if (typeof body.hasScript === "boolean")
        e.hasScript = body.hasScript;
      e.ts = now;
      await this.state.storage.put("dir:" + room, e);
      return cors(json({ ok: true, players: e.players }));
    }
    if (request.method === "GET" && url.pathname === "/rooms") {
      const now = Date.now();
      const rows = await this.state.storage.list({ prefix: "dir:" });
      const out = [];
      for (const [k, e] of rows) {
        let players = 0;
        for (const c in e.clients || {})
          if (now - e.clients[c] <= 45e3)
            players++;
        if (players > 0)
          out.push({ room: k.slice(4), players, destroyable: !!e.destroyable, hasScript: !!e.hasScript });
      }
      out.sort((a, b) => b.players - a.players || a.room.localeCompare(b.room));
      return cors(json({ rooms: out.slice(0, 60) }));
    }
    if (url.pathname === "/thumb") {
      const room = sanRoom(url.searchParams.get("room"));
      if (!room)
        return cors(new Response("no room", { status: 400 }));
      if (request.method === "POST") {
        const data = await request.text();
        if (data && data.length < 24e4)
          await this.state.storage.put("thumb:" + room, data);
        return cors(json({ ok: true }));
      }
      const t = await this.state.storage.get("thumb:" + room);
      if (!t)
        return cors(new Response("", { status: 404 }));
      return cors(new Response(t, { headers: { "content-type": "text/plain" } }));
    }
    if (request.method === "GET" && url.pathname === "/published.json") {
      const snap = await this.state.storage.get("published") || EMPTY_SCENE;
      return cors(new Response(snap, { headers: { "content-type": "application/json" } }));
    }
    if (request.method === "POST" && url.pathname === "/publish") {
      const scene = await this.state.storage.get("scene");
      if (!scene)
        return cors(json({ ok: false, reason: "no live scene" }));
      await this.state.storage.put("published", scene);
      let ts = null;
      try {
        ts = JSON.parse(scene).ts;
      } catch {
      }
      return cors(json({ ok: true, ts }));
    }
    if (request.method === "POST" && url.pathname === "/reset") {
      const admin = this.env.ADMIN_KEY;
      if (!admin || url.searchParams.get("key") !== admin)
        return cors(json({ ok: false, reason: "forbidden" }));
      await this.state.storage.delete("owner");
      await this.state.storage.delete("destroyable");
      return cors(json({ ok: true, reset: "owner+destroyable" }));
    }
    if ((request.headers.get("Upgrade") || "").toLowerCase() === "websocket") {
      const roomName = sanRoom(url.searchParams.get("room")) || "figager";
      await this.maybeWipeStale(roomName);
      try {
        await this.state.storage.put("roomName", roomName);
      } catch {
      }
      await this.touch();
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);
      await this.seed(server, Relay.landId(url.searchParams.get("land")));
      return new Response(null, { status: 101, webSocket: client });
    }
    return cors(new Response("relay ok", { status: 200 }));
  }
  // Seed a freshly-connected peer: CONTENT (global) + the build of the land it
  // joined (?land=<id>), so late joiners see that land's full build.
  async seed(ws, landId) {
    const scene = await this.state.storage.get("scene");
    const library = await this.state.storage.get("library");
    const land = await this.ensureLand(landId);
    await this.ensureAssets();
    try {
      if (scene)
        ws.send(scene);
      if (library)
        ws.send(library);
      for (const frame of this.assets.values())
        ws.send(frame);
      if (land.size) {
        const blocks = {};
        for (const [k, e] of land)
          blocks[k] = e;
        ws.send(JSON.stringify({ type: "land", land: landId, blocks }));
      }
      const owner = await this.state.storage.get("owner");
      const destroyable = await this.state.storage.get("destroyable") === true;
      ws.send(JSON.stringify({ type: "roomState", owned: !!owner, destroyable }));
      const race = await this.state.storage.get("race");
      if (race) {
        try {
          ws.send(JSON.stringify({ type: "race", race: JSON.parse(race) }));
        } catch {
        }
      }
      const lb = await this.state.storage.get("lb");
      if (lb && lb.length) {
        try {
          ws.send(JSON.stringify({ type: "leaderboard", entries: lb }));
        } catch {
        }
      }
    } catch {
    }
  }
  // Every inbound frame: auth-gate CONTENT writes, sniff for caching, fan out.
  async webSocketMessage(ws, message) {
    await this.touch();
    const text = typeof message === "string" ? message : new TextDecoder().decode(message);
    let msg = null;
    try {
      msg = JSON.parse(text);
    } catch {
    }
    if (msg && msg.type === "auth") {
      const token = String(msg.token || "");
      const master = this.env.OWNER_KEY;
      const owner = await this.state.storage.get("owner");
      let authed = false;
      if (master && token && token === master) {
        authed = true;
        if (!owner)
          await this.state.storage.put("owner", token);
      } else if (!owner) {
        if (token) {
          await this.state.storage.put("owner", token);
          authed = true;
        }
      } else
        authed = owner === token;
      ws.serializeAttachment({ authed });
      try {
        ws.send(JSON.stringify({ type: "authResult", owner: authed }));
      } catch {
      }
      return;
    }
    if (msg && msg.type === "setDestroyable") {
      const att = ws.deserializeAttachment();
      if (!(att && att.authed))
        return;
      await this.state.storage.put("destroyable", !!msg.value);
      const owner = await this.state.storage.get("owner");
      const rs = JSON.stringify({ type: "roomState", owned: !!owner, destroyable: !!msg.value });
      for (const peer of this.state.getWebSockets()) {
        if (peer.readyState === WebSocket.OPEN) {
          try {
            peer.send(rs);
          } catch {
          }
        }
      }
      return;
    }
    if (msg && (msg.type === "op" || msg.type === "carry")) {
      const att = ws.deserializeAttachment();
      if (!(att && att.authed)) {
        const destroyable = await this.state.storage.get("destroyable") === true;
        if (!destroyable)
          return;
      }
    }
    if (msg && msg.type === "race") {
      const att = ws.deserializeAttachment();
      if (!(att && att.authed)) {
        const destroyable = await this.state.storage.get("destroyable") === true;
        if (!destroyable)
          return;
      }
      try {
        await this.state.storage.put("race", JSON.stringify(msg.race || null));
      } catch {
      }
    }
    if (msg && msg.type === "wipe") {
      const att = ws.deserializeAttachment();
      if (!(att && att.authed))
        return;
      try {
        const keys = [...(await this.state.storage.list({ prefix: "b:" })).keys()];
        for (let i = 0; i < keys.length; i += 100)
          await this.state.storage.delete(keys.slice(i, i + 100));
        await this.state.storage.delete("race");
      } catch {
      }
      this.lands.clear();
      try {
        await this.state.storage.delete("lb");
      } catch {
      }
      const w = JSON.stringify({ type: "wiped" });
      for (const peer of this.state.getWebSockets()) {
        if (peer.readyState === WebSocket.OPEN) {
          try {
            peer.send(w);
          } catch {
          }
        }
      }
      return;
    }
    if (msg && msg.type === "finish") {
      const time = Number(msg.time);
      if (isFinite(time) && time > 0 && time < 36e3) {
        const name = String(msg.name || "anon").slice(0, 24);
        let lb = await this.state.storage.get("lb") || [];
        lb.push({ name, time });
        lb.sort((a, b) => a.time - b.time);
        lb = lb.slice(0, 10);
        try {
          await this.state.storage.put("lb", lb);
        } catch {
        }
        const m2 = JSON.stringify({ type: "leaderboard", entries: lb });
        for (const peer of this.state.getWebSockets()) {
          if (peer.readyState === WebSocket.OPEN) {
            try {
              peer.send(m2);
            } catch {
            }
          }
        }
      }
      return;
    }
    const isContent = !!msg && (msg.type === "scene" || msg.type === "library" || msg.type === "asset" && (msg.key || msg.nodeId));
    if (isContent) {
      const owner = await this.state.storage.get("owner");
      const att = ws.deserializeAttachment();
      if (owner && !(att && att.authed))
        return;
    }
    try {
      if (msg && msg.type === "scene")
        await this.state.storage.put("scene", text);
      else if (msg && msg.type === "library")
        await this.state.storage.put("library", text);
      else if (msg && msg.type === "asset" && (msg.key || msg.nodeId)) {
        const ak = msg.key || msg.nodeId;
        this.assets.set(ak, text);
        try {
          await this.state.storage.put("a:" + ak, text);
        } catch {
        }
      } else if (msg && msg.type === "op" && Array.isArray(msg.ops)) {
        const landId = Relay.landId(msg.land);
        const land = await this.ensureLand(landId);
        const pre = "b:" + landId + ":";
        const puts = {};
        const dels = [];
        for (const o of msg.ops) {
          const cur = land.get(o.key);
          if (cur && cur.ts > (o.ts || 0))
            continue;
          if (o.op === "d") {
            land.delete(o.key);
            dels.push(pre + o.key);
          } else {
            const e = { val: o.val, ts: o.ts || 0 };
            land.set(o.key, e);
            puts[pre + o.key] = e;
          }
        }
        if (Object.keys(puts).length)
          await this.state.storage.put(puts);
        if (dels.length)
          await this.state.storage.delete(dels);
      }
    } catch {
    }
    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        try {
          peer.send(text);
        } catch {
        }
      }
    }
  }
  async webSocketClose(ws) {
    try {
      ws.close();
    } catch {
    }
  }
  async webSocketError(ws) {
    try {
      ws.close();
    } catch {
    }
  }
};
__name(Relay, "Relay");

// src/index.ts
var ROOM_NS = "g2";
var src_default = {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === "/rooms" || url.pathname === "/report" || url.pathname === "/thumb") {
      return env.RELAY.get(env.RELAY.idFromName(ROOM_NS + ":__directory__")).fetch(request);
    }
    const room = (url.searchParams.get("room") || "figager").toLowerCase().replace(/[^a-z0-9_-]/g, "").slice(0, 48) || "figager";
    const id = env.RELAY.idFromName(ROOM_NS + ":" + room);
    return env.RELAY.get(id).fetch(request);
  }
};
export {
  Relay,
  src_default as default
};
//# sourceMappingURL=index.js.map
