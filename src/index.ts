export { Relay } from './relay';

export interface Env {
  RELAY: DurableObjectNamespace;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    // One shared room for the whole project. idFromName is stable, so every
    // request lands on the same DO instance (the relay hub).
    const id = env.RELAY.idFromName('figager');
    return env.RELAY.get(id).fetch(request);
  },
};
