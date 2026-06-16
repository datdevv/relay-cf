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

  constructor(state: DurableObjectState, env: unknown) {
    this.state = state;
    this.env = env;
    this.assets = new Map();
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
    try {
      if (scene) ws.send(scene);
      if (library) ws.send(library);
      for (const frame of this.assets.values()) ws.send(frame);
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
