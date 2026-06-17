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
  // The shared LAND (player builds): cell key "x,y,z" -> { val, ts }. Accumulated
  // from `op` messages with last-write-wins, persisted per-cell to DO storage
  // (keys "b:<cell>"), and snapshotted to every joiner. Lazily loaded.
  land: Map<string, { val: unknown; ts: number }> | null;

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
    this.assets = new Map();
    this.land = null;
  }

  // Lazily hydrate the land from DO storage (survives hibernation/cold start).
  async ensureLand(): Promise<void> {
    if (this.land) return;
    this.land = new Map();
    const rows = (await this.state.storage.list({ prefix: 'b:' })) as Map<string, { val: unknown; ts: number }>;
    for (const [k, v] of rows) this.land.set(k.slice(2), v);
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
      await this.seed(server);                // late-joiner cache
      return new Response(null, { status: 101, webSocket: client });
    }

    return cors(new Response('relay ok', { status: 200 }));
  }

  // Seed a freshly-connected peer with the current world.
  async seed(ws: WebSocket): Promise<void> {
    const scene = (await this.state.storage.get('scene')) as string | undefined;
    const library = (await this.state.storage.get('library')) as string | undefined;
    await this.ensureLand();
    try {
      if (scene) ws.send(scene);
      if (library) ws.send(library);
      for (const frame of this.assets.values()) ws.send(frame);
      if (this.land!.size) {                       // the full shared build, so late joiners see everything
        const blocks: Record<string, { val: unknown; ts: number }> = {};
        for (const [k, e] of this.land!) blocks[k] = e;
        ws.send(JSON.stringify({ type: 'land', blocks }));
      }
    } catch {}
  }

  // Every inbound frame: sniff for caching, then fan out to all OTHER peers.
  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const text = typeof message === 'string' ? message : new TextDecoder().decode(message);
    try {
      const msg = JSON.parse(text);
      if (msg.type === 'scene') await this.state.storage.put('scene', text);
      else if (msg.type === 'library') await this.state.storage.put('library', text);
      else if (msg.type === 'asset' && (msg.key || msg.nodeId)) {
        this.assets.set(msg.key || msg.nodeId, text);
      }
      else if (msg.type === 'op' && Array.isArray(msg.ops)) {
        // Build edits: accumulate into the canonical land (last-write-wins per
        // cell) and persist per-cell, so the land survives + seeds late joiners.
        await this.ensureLand();
        const puts: Record<string, { val: unknown; ts: number }> = {};
        const dels: string[] = [];
        for (const o of msg.ops) {
          const cur = this.land!.get(o.key);
          if (cur && cur.ts > (o.ts || 0)) continue;        // keep the newer edit
          if (o.op === 'd') { this.land!.delete(o.key); dels.push('b:' + o.key); }
          else { const e = { val: o.val, ts: o.ts || 0 }; this.land!.set(o.key, e); puts['b:' + o.key] = e; }
        }
        if (Object.keys(puts).length) await this.state.storage.put(puts);
        if (dels.length) await this.state.storage.delete(dels);
      }
      // hello/write/resync/patch: nothing to cache — just forwarded below.
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
