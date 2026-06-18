export { Relay } from './relay';

export interface Env {
  RELAY: DurableObjectNamespace;
  ADMIN_KEY?: string; // wrangler secret; enables POST /reset?room=&key= to clear a room owner
  OWNER_KEY?: string; // wrangler secret; a MASTER owner key — presenting it as the auth token owns any room (e.g. the lobby). Set with `wrangler secret put OWNER_KEY`; never in the repo.
}

// Routing namespace. BUMP this to RESET EVERY ROOM: each room then resolves to a
// brand-new empty Durable Object, so all worlds (lobby + every player room: content,
// builds, owners, destroyable) start fresh. The old DOs are simply orphaned (idle =
// free). Reversible — set it back to reach the old data. Rooms stay addressed by
// their plain ?room id (this prefix is invisible to users).
const ROOM_NS = 'g3';

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // ONE Durable Object PER ROOM (per WORLD). `?room=<id>` selects the world;
    // default 'figager' is the canonical world, so existing links (which send no
    // ?room) are byte-for-byte unchanged. A room is a *content fork*: a modder
    // hosts their own forked Figma file by pointing the plugin at ?room=<id>, and
    // visitors connect with the same ?room. Content is correctly per-room because
    // EACH ROOM HAS ITS OWN PLUGIN STREAMING IT.
    //
    // This is NOT the per-land routing we reverted (01fc7d5). That split GLOBAL
    // content off from the single canonical plugin (land-rooms had no content
    // source). Routing by ?room is safe precisely because a fork brings its own
    // content host. `?land` (read inside relay.ts) still namespaces BUILDS WITHIN
    // a room — orthogonal to ?room, which picks the whole DO (content + builds).
    const url = new URL(request.url);
    // The Visit-grid directory (active rooms + thumbnails) lives on ONE singleton DO.
    if (url.pathname === '/rooms' || url.pathname === '/report' || url.pathname === '/thumb') {
      return env.RELAY.get(env.RELAY.idFromName(ROOM_NS + ':__directory__')).fetch(request);
    }
    const room = (url.searchParams.get('room') || 'figager')
      .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48) || 'figager';
    const id = env.RELAY.idFromName(ROOM_NS + ':' + room);
    return env.RELAY.get(id).fetch(request);
  },
};
