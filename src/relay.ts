const EMPTY_SCENE = JSON.stringify({ type: 'scene', nodes: [], variables: [], ts: 0 });

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

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
    this.assets = new Map();
    this.assetsLoaded = false;
    this.lands = new Map();
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

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === 'OPTIONS') return cors(new Response(null, { status: 204 }));

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

    // WebSocket upgrade → join the room.
    if ((request.headers.get('Upgrade') || '').toLowerCase() === 'websocket') {
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
      for (const frame of this.assets.values()) ws.send(frame);
      if (land.size) {
        const blocks: Record<string, { val: unknown; ts: number }> = {};
        for (const [k, e] of land) blocks[k] = e;
        ws.send(JSON.stringify({ type: 'land', land: landId, blocks }));
      }
    } catch {}
  }

  // Every inbound frame: auth-gate CONTENT writes, sniff for caching, fan out.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let msg: any = null;
    try { msg = JSON.parse(text); } catch {}

    // Owner claim / verify. The token is NEVER cached or fanned out (so visitors
    // can't sniff it). The first token to arrive claims an unowned room.
    if (msg && msg.type === 'auth') {
      const owner = (await this.state.storage.get('owner')) as string | undefined;
      let authed = false;
      if (!owner) { if (msg.token) { await this.state.storage.put('owner', String(msg.token)); authed = true; } }
      else authed = owner === String(msg.token);
      ws.serializeAttachment({ authed });
      try { ws.send(JSON.stringify({ type: 'authResult', owner: authed })); } catch {}
      return;
    }

    // CONTENT writes (scene/library/asset) require ownership once a room is
    // claimed; a non-owner is read-only (its content is dropped — not cached, not
    // fanned out). Builds (op) / presence / hello are NOT gated.
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
