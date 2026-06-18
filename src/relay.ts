const EMPTY_SCENE = JSON.stringify({ type: 'scene', nodes: [], variables: [], ts: 0 });

// Inactivity TTL: if NOTHING touches a room (no connect, no message) for this long,
// the next connect REBORNS it empty (all builds/scene/library/race/owner/assets wiped).
// 14 days is long enough that a real, in-use world is never wiped between sessions
// (people return within ~2 weeks), while truly abandoned forks are garbage-collected so
// stale owners/builds don't linger forever. The lobby (figager) is NEVER wiped. Note: the
// Visit grid already hides rooms with no reporter in ~45s — "gone from the grid" is purely
// cosmetic and separate from this; data stays alive here until the 14-day TTL elapses.
const ROOM_TTL_MS = 14 * 24 * 60 * 60 * 1000; // 14 days

const cors = (res: Response): Response => {
  res.headers.set('Access-Control-Allow-Origin', '*');
  res.headers.set('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.headers.set('Access-Control-Allow-Headers', 'content-type');
  return res;
};

const json = (obj: unknown): Response =>
  new Response(JSON.stringify(obj), { headers: { 'content-type': 'application/json' } });

export class Relay {
  state: DurableObjectState;
  env: unknown;
  // Big base64 textures live in memory only; re-streamed by the plugin on
  // connect. scene/library persist to storage (see brief §2).
  assets: Map<string, string>;
  assetsLoaded: boolean;
  // Player builds, namespaced PER LAND so separate ?land=<id> worlds don't mix
  // while CONTENT (scene/library/assets) stays shared in this one DO. lands:
  // landId -> (cell "x,y,z" -> {val,ts}); persisted as "b:<land>:<cell>". Lazy.
  lands: Map<string, Map<string, { val: unknown; ts: number }>>;
  rate: WeakMap<WebSocket, { c: number; t: number }>; // per-socket message-rate guard (abuse / cost control)

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
    this.assets = new Map();
    this.assetsLoaded = false;
    this.lands = new Map();
    this.rate = new WeakMap();
  }

  // Lazily hydrate textures from DO storage so CONTENT survives eviction / days
  // with no plugin connected (small pixel-art PNGs are well under the value limit).
  async ensureAssets(): Promise<void> {
    if (this.assetsLoaded) return;
    this.assetsLoaded = true;
    const rows = (await this.state.storage.list({ prefix: 'a:' })) as Map<string, string>;
    for (const [k, v] of rows) { const key = k.slice(2); if (!this.assets.has(key)) this.assets.set(key, v); }
  }

  static landId(raw: string | null): string { return ((raw || 'home').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)) || 'home'; }

  // Lazily hydrate ONE land from DO storage (survives hibernation/cold start).
  async ensureLand(landId: string): Promise<Map<string, { val: unknown; ts: number }>> {
    let m = this.lands.get(landId);
    if (m) return m;
    m = new Map();
    const pre = 'b:' + landId + ':';
    const rows = (await this.state.storage.list({ prefix: pre })) as Map<string, { val: unknown; ts: number }>;
    for (const [k, v] of rows) m.set(k.slice(pre.length), v);
    this.lands.set(landId, m);
    return m;
  }

  // Mark the room as alive NOW. Called on every connect and every inbound message, so a
  // room only goes stale after a continuous TTL window with zero traffic. Persisted (the
  // wipe check on a later cold start reads it from storage, not an instance field).
  async touch(): Promise<void> { try { await this.state.storage.put('lastSeen', Date.now()); } catch {} }

  // Inactivity rebirth. If this room has had NO traffic for longer than ROOM_TTL_MS and is
  // not the lobby (figager), erase its whole world so it is reborn empty: builds (b:*),
  // assets (a:*), scene, library, race, owner, destroyable, published, thumb — everything
  // except we re-stamp roomName + lastSeen. We deleteAll() (simplest + covers every key,
  // incl. directory keys which only live on the singleton DO anyway) then restore identity.
  // First-ever connect (no lastSeen yet) is NOT a wipe — touch() will stamp it.
  async maybeWipeStale(roomName: string): Promise<void> {
    if (roomName === 'figager') return; // never wipe the lobby
    let lastSeen: number | undefined;
    try { lastSeen = (await this.state.storage.get('lastSeen')) as number | undefined; } catch {}
    if (typeof lastSeen !== 'number') return; // never seen before → nothing to wipe
    if (Date.now() - lastSeen <= ROOM_TTL_MS) return; // still fresh
    try {
      await this.state.storage.deleteAll(); // builds, assets, scene, library, race, owner, destroyable, …
    } catch {}
    // drop hydrated in-memory caches so the reborn world doesn't re-seed old content
    this.lands.clear();
    this.assets.clear();
    this.assetsLoaded = false;
    try { await this.state.storage.put('roomName', roomName); } catch {}
    try { await this.state.storage.put('lastSeen', Date.now()); } catch {}
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

    // --- room directory (Visit grid). These routes are sent to ONE singleton DO by
    // index.ts, so this storage is the global registry of active worlds. Clients POST
    // /report ~every 15s with {room, clientId, owner, destroyable}; each room entry
    // tracks recent clientIds (=live player count). The owner POSTs a canvas snapshot
    // to /thumb. /rooms returns active worlds for the grid.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const sanRoom = (s: any) => String(s || '').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48);
    if (request.method === 'POST' && url.pathname === '/report') {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      let body: any = {}; try { body = await request.json(); } catch {}
      const room = sanRoom(body.room);
      if (!room || room === 'figager') return cors(json({ ok: false })); // the lobby isn't listed
      const cid = String(body.clientId || 'anon').slice(0, 32);
      const now = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const e: any = (await this.state.storage.get('dir:' + room)) || { clients: {}, destroyable: false };
      e.clients[cid] = now;
      for (const k in e.clients) if (now - e.clients[k] > 45000) delete e.clients[k];
      e.players = Object.keys(e.clients).length;
      if (typeof body.destroyable === 'boolean') e.destroyable = body.destroyable;
      if (typeof body.hasScript === 'boolean') e.hasScript = body.hasScript;
      e.ts = now;
      await this.state.storage.put('dir:' + room, e);
      return cors(json({ ok: true, players: e.players }));
    }
    if (request.method === 'GET' && url.pathname === '/rooms') {
      const now = Date.now();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const rows = (await this.state.storage.list({ prefix: 'dir:' })) as Map<string, any>;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const out: any[] = [];
      const stale: string[] = [];
      const KEEP_MS = 14 * 24 * 60 * 60 * 1000; // worlds stay listed (even idle) until their data TTL, so you can find the ones you made
      for (const [k, e] of rows) {
        let players = 0; for (const c in (e.clients || {})) if (now - e.clients[c] <= 45000) players++;
        const ts = e.ts || 0;
        if (players === 0 && now - ts > KEEP_MS) { stale.push(k); continue; } // forget long-dead worlds
        out.push({ room: k.slice(4), players, destroyable: !!e.destroyable, hasScript: !!e.hasScript, idle: players === 0, ts });
      }
      if (stale.length) { try { await this.state.storage.delete(stale); } catch {} }
      out.sort((a, b) => (b.players - a.players) || (b.ts - a.ts)); // live worlds first, then most-recently-active
      return cors(json({ rooms: out.slice(0, 60) }));
    }
    if (url.pathname === '/thumb') {
      const room = sanRoom(url.searchParams.get('room'));
      if (!room) return cors(new Response('no room', { status: 400 }));
      if (request.method === 'POST') {
        const data = await request.text();
        if (data && data.length < 240000) await this.state.storage.put('thumb:' + room, data);
        return cors(json({ ok: true }));
      }
      const t = (await this.state.storage.get('thumb:' + room)) as string | undefined;
      if (!t) return cors(new Response('', { status: 404 }));
      return cors(new Response(t, { headers: { 'content-type': 'text/plain' } }));
    }

    // Player-mode fallback: frozen snapshot.
    if (request.method === 'GET' && url.pathname === '/published.json') {
      const snap = ((await this.state.storage.get('published')) as string) || EMPTY_SCENE;
      return cors(new Response(snap, { headers: { 'content-type': 'application/json' } }));
    }
    // Freeze the current live scene to disk (the "Push update" button).
    if (request.method === 'POST' && url.pathname === '/publish') {
      const scene = (await this.state.storage.get('scene')) as string | undefined;
      if (!scene) return cors(json({ ok: false, reason: 'no live scene' }));
      await this.state.storage.put('published', scene);
      let ts: number | null = null;
      try { ts = JSON.parse(scene).ts; } catch {}
      return cors(json({ ok: true, ts }));
    }

    // Admin reset: clear a room's owner so it can be re-claimed. Gated by the
    // ADMIN_KEY wrangler secret (disabled if unset) — POST /reset?room=&key=.
    if (request.method === 'POST' && url.pathname === '/reset') {
      const admin = (this.env as { ADMIN_KEY?: string }).ADMIN_KEY;
      if (!admin || url.searchParams.get('key') !== admin) return cors(json({ ok: false, reason: 'forbidden' }));
      await this.state.storage.delete('owner');
      await this.state.storage.delete('destroyable');
      return cors(json({ ok: true, reset: 'owner+destroyable' }));
    }

    // WebSocket upgrade → join the room.
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
      // Cost/abuse guard: cap concurrent sockets per room so nobody can connection-bomb the DO.
      if (this.state.getWebSockets().length >= 100) return cors(new Response('room full', { status: 429 }));
      // Remember which room THIS DO is (the name only reaches us on the URL at connect;
      // hibernation drops instance fields, so persist it). Used by the TTL wipe to spare
      // the lobby.
      const roomName = sanRoom(url.searchParams.get('room')) || 'figager';
      // Inactivity rebirth: BEFORE seeding, if this room has been untouched longer than
      // the TTL (and is not the lobby), wipe it so the joiner sees a fresh empty world.
      await this.maybeWipeStale(roomName);
      try { await this.state.storage.put('roomName', roomName); } catch {}
      await this.touch(); // a connect counts as activity
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.state.acceptWebSocket(server);     // Hibernation API: idle rooms cost nothing
      await this.seed(server, Relay.landId(url.searchParams.get('land'))); // shared content + this land's build
      return new Response(null, { status: 101, webSocket: client });
    }

    return cors(new Response('relay ok', { status: 200 }));
  }

  // Seed a freshly-connected peer: CONTENT (global) + the build of the land it
  // joined (?land=<id>), so late joiners see that land's full build.
  async seed(ws: WebSocket, landId: string): Promise<void> {
    const scene = (await this.state.storage.get('scene')) as string | undefined;
    const library = (await this.state.storage.get('library')) as string | undefined;
    const land = await this.ensureLand(landId);
    await this.ensureAssets(); // load persisted textures so a cold start / no-plugin world still has them
    try {
      if (scene) ws.send(scene);
      if (library) ws.send(library);
      // DELTA SEED: send only a MANIFEST (asset key -> byte length), not the bodies. The client
      // requests just the textures it's missing or whose length changed, so a reconnect / return
      // visit re-streams ~nothing while a re-exported texture still updates.
      const amani: Record<string, number> = {}; for (const [k, v] of this.assets) amani[k] = v.length;
      ws.send(JSON.stringify({ type: 'amani', keys: amani }));
      if (land.size) {
        const blocks: Record<string, { val: unknown; ts: number }> = {};
        for (const [k, e] of land) blocks[k] = e;
        ws.send(JSON.stringify({ type: 'land', land: landId, blocks }));
      }
      // Tell the joiner whether this room is owned + open to building, so its UI can
      // show/hide build tools. (authResult, sent after the client's auth, says whether
      // THIS socket is the owner.)
      const owner = (await this.state.storage.get('owner')) as string | undefined;
      const destroyable = (await this.state.storage.get('destroyable')) === true;
      ws.send(JSON.stringify({ type: 'roomState', owned: !!owner, destroyable }));
      // Race course is room-wide content: replay the persisted course to late joiners.
      const race = (await this.state.storage.get('race')) as string | undefined;
      if (race) { try { ws.send(JSON.stringify({ type: 'race', race: JSON.parse(race) })); } catch {} }
      // ...and the current leaderboard, so finish times are there before you race.
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const lb = (await this.state.storage.get('lb')) as any[] | undefined;
      if (lb && lb.length) { try { ws.send(JSON.stringify({ type: 'leaderboard', entries: lb })); } catch {} }
    } catch {}
  }

  // Every inbound frame: auth-gate CONTENT writes, sniff for caching, fan out.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    // --- abuse / cost guards: drop floods + absurd frames BEFORE any storage write ---
    const _sz = typeof message === 'string' ? message.length : message.byteLength;
    if (_sz > 2_000_000) return; // ignore absurdly large frames (legit op/asset frames are tiny)
    const _now = Date.now();
    let _r = this.rate.get(ws);
    if (!_r || _now - _r.t > 3000) { _r = { c: 0, t: _now }; this.rate.set(ws, _r); }
    if (++_r.c > 3000) { try { ws.close(1013, 'rate limit'); } catch {} return; } // sustained flood (>1k/s) -> disconnect this socket
    await this.touch(); // any inbound frame keeps the room alive (resets the inactivity TTL)
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any = null;
    try { msg = JSON.parse(text); } catch {}

    // DELTA SEED: the client asks for the specific asset keys it doesn't have cached. Public read
    // (textures are content), batch-capped so it can't be used to amplify load.
    if (msg && msg.type === 'want' && Array.isArray(msg.keys)) {
      await this.ensureAssets();
      for (const k of msg.keys.slice(0, 6000)) { const f = this.assets.get(k); if (f) { try { ws.send(f); } catch {} } }
      return;
    }

    // Owner claim / verify. The token is NEVER cached or fanned out (so visitors
    // can't sniff it). The first token to arrive claims an unowned room.
    if (msg && msg.type === 'auth') {
      const token = String(msg.token || '');
      const master = (this.env as { OWNER_KEY?: string }).OWNER_KEY; // wrangler secret; owns any room (the lobby) — never in the repo
      const owner = (await this.state.storage.get('owner')) as string | undefined;
      let authed = false;
      if (master && token && token === master) { authed = true; if (!owner) await this.state.storage.put('owner', token); } // operator master key -> owner of this room
      else if (!owner) { if (token) { await this.state.storage.put('owner', token); authed = true; } }                      // first token claims an unowned room
      else authed = owner === token;                                                                                        // otherwise must match the claimer
      ws.serializeAttachment({ authed });
      try { ws.send(JSON.stringify({ type: 'authResult', owner: authed })); } catch {}
      return;
    }

    // Owner toggles "destroyable" (= buildable by everyone). Authed-only; the new
    // roomState is broadcast to all peers so their build UI updates immediately.
    if (msg && msg.type === 'setDestroyable') {
      const att = ws.deserializeAttachment() as { authed?: boolean } | null;
      if (!(att && att.authed)) return; // only the owner may change it
      await this.state.storage.put('destroyable', !!msg.value);
      const owner = (await this.state.storage.get('owner')) as string | undefined;
      const rs = JSON.stringify({ type: 'roomState', owned: !!owner, destroyable: !!msg.value });
      for (const peer of this.state.getWebSockets()) { if (peer.readyState === WebSocket.OPEN) { try { peer.send(rs); } catch {} } }
      return;
    }

    // BUILD gating: building — op (persistent edits) and carry (held / in-flight block
    // ghosts) — is allowed ONLY for the authed owner OR when the room is "destroyable"
    // (open to everyone). Otherwise the room is read-only: drop it (not persisted, not
    // fanned out). This is what makes "read-only by default" server-enforced.
    if (msg && (msg.type === 'op' || msg.type === 'carry')) {
      const att = ws.deserializeAttachment() as { authed?: boolean } | null;
      if (!(att && att.authed)) {
        const destroyable = (await this.state.storage.get('destroyable')) === true;
        if (!destroyable) return;
      }
    }

    // RACE course sync: the authored race (start/end/checkpoints) is room-wide
    // content. Gate it EXACTLY like op/carry (authed owner OR destroyable room),
    // persist it as a JSON string under "race", then let it fan out below so all
    // peers update live. A non-owner in a read-only room is dropped (not stored,
    // not forwarded).
    if (msg && msg.type === 'race') {
      const att = ws.deserializeAttachment() as { authed?: boolean } | null;
      if (!(att && att.authed)) {
        const destroyable = (await this.state.storage.get('destroyable')) === true;
        if (!destroyable) return;
      }
      try { await this.state.storage.put('race', JSON.stringify(msg.race || null)); } catch {}
    }

    // Owner WIPE: clear everything the players BUILT (all b:<land>:* builds + the race
    // course). Content (scene/library/textures) and ownership/destroyable stay, so the
    // world is reborn empty but still textured + still yours. Authed owner only. Then
    // tell every peer to reload into the fresh world.
    if (msg && msg.type === 'wipe') {
      const att = ws.deserializeAttachment() as { authed?: boolean } | null;
      if (!(att && att.authed)) return; // owner only
      try {
        const keys = [...(await this.state.storage.list({ prefix: 'b:' })).keys()];
        for (let i = 0; i < keys.length; i += 100) await this.state.storage.delete(keys.slice(i, i + 100));
        await this.state.storage.delete('race');
      } catch {}
      this.lands.clear();
      try { await this.state.storage.delete('lb'); } catch {} // fresh world -> fresh leaderboard
      const w = JSON.stringify({ type: 'wiped' });
      for (const peer of this.state.getWebSockets()) { if (peer.readyState === WebSocket.OPEN) { try { peer.send(w); } catch {} } }
      return;
    }

    // Race FINISH: anyone racing can submit {name,time}. Keep the top-10 fastest per room
    // (this DO = this room) under "lb", then broadcast the updated board to everyone.
    if (msg && msg.type === 'finish') {
      const time = Number(msg.time);
      if (isFinite(time) && time > 0 && time < 36000) {
        const name = String(msg.name || 'anon').slice(0, 24);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        let lb = ((await this.state.storage.get('lb')) as any[]) || [];
        lb.push({ name, time });
        lb.sort((a, b) => a.time - b.time);
        lb = lb.slice(0, 10);
        try { await this.state.storage.put('lb', lb); } catch {}
        const m2 = JSON.stringify({ type: 'leaderboard', entries: lb });
        for (const peer of this.state.getWebSockets()) { if (peer.readyState === WebSocket.OPEN) { try { peer.send(m2); } catch {} } }
      }
      return;
    }

    // CONTENT writes (scene/library/asset) require ownership once a room is
    // claimed; a non-owner is read-only (its content is dropped — not cached, not
    // fanned out). presence / hello are NOT gated.
    const isContent = !!msg && (msg.type === 'scene' || msg.type === 'library' || (msg.type === 'asset' && (msg.key || msg.nodeId)));
    if (isContent) {
      const owner = (await this.state.storage.get('owner')) as string | undefined;
      const att = ws.deserializeAttachment() as { authed?: boolean } | null;
      if (owner && !(att && att.authed)) return; // not the owner -> ignore content
    }

    try {
      if (msg && msg.type === 'scene') await this.state.storage.put('scene', text);
      else if (msg && msg.type === 'library') await this.state.storage.put('library', text);
      else if (msg && msg.type === 'asset' && (msg.key || msg.nodeId)) {
        const ak = msg.key || msg.nodeId;
        this.assets.set(ak, text);
        try { await this.state.storage.put('a:' + ak, text); } catch {} // persist so textures survive eviction / no-plugin days
      }
      else if (msg && msg.type === 'op' && Array.isArray(msg.ops)) {
        // Build edits for ONE land: accumulate (last-write-wins per cell) and
        // persist per-cell under that land, so it survives + seeds late joiners.
        const landId = Relay.landId(msg.land);
        const land = await this.ensureLand(landId);
        const pre = 'b:' + landId + ':';
        const puts: Record<string, { val: unknown; ts: number }> = {};
        const dels: string[] = [];
        for (const o of msg.ops) {
          const cur = land.get(o.key);
          if (cur && cur.ts > (o.ts || 0)) continue;        // keep the newer edit
          if (o.op === 'd') { land.delete(o.key); dels.push(pre + o.key); }
          else { const e = { val: o.val, ts: o.ts || 0 }; land.set(o.key, e); puts[pre + o.key] = e; }
        }
        if (Object.keys(puts).length) await this.state.storage.put(puts);
        if (dels.length) await this.state.storage.delete(dels);
      }
      // hello/write/resync/patch/presence/carry: nothing to cache — just forwarded.
    } catch { /* non-JSON or partial — still forward verbatim */ }

    for (const peer of this.state.getWebSockets()) {
      if (peer !== ws && peer.readyState === WebSocket.OPEN) {
        try { peer.send(text); } catch {}
      }
    }
  }

  async webSocketClose(ws: WebSocket): Promise<void> { try { ws.close(); } catch {} }
  async webSocketError(ws: WebSocket): Promise<void> { try { ws.close(); } catch {} }
}
