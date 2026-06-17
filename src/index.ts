export { Relay } from './relay';

export interface Env {
  RELAY: DurableObjectNamespace;
}

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
    const room = (url.searchParams.get('room') || 'figager')
      .toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48) || 'figager';
    const id = env.RELAY.idFromName(room);
    return env.RELAY.get(id).fetch(request);
  },
};
