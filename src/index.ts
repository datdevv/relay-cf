export { Relay } from './relay';

export interface Env {
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One Durable Object PER LAND: ?land=<id> picks the room, so separate named
    // worlds don't mix. Sanitised + stable, so every request for a land lands on
    // the same DO. No param -> the legacy shared room.
    // ONE Durable Object for the whole project: CONTENT (scene/library/assets) is
    // global, and BUILDS are namespaced per land INSIDE the DO (it reads ?land=).
    // Routing per-land HERE would split content off from the plugin (the bug we hit).
    const id = env.RELAY.idFromName('figager');
    return env.RELAY.get(id).fetch(request);
  },
};
