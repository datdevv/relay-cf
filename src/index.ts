export { Relay } from './relay';

export interface Env {
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One Durable Object PER LAND: ?land=<id> picks the room, so separate named
    // worlds don't mix. Sanitised + stable, so every request for a land lands on
    // the same DO. No param -> the legacy shared room.
    const land = ((new URL(request.url).searchParams.get('land') || 'figager').toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 48)) || 'figager';
    const id = env.RELAY.idFromName(land);
    return env.RELAY.get(id).fetch(request);
  },
};
