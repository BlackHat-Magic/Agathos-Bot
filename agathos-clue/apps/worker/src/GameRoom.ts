import { DurableObject } from 'cloudflare:workers';
import type { Env } from './index';

export class GameRoom extends DurableObject<Env> {
  async fetch(req: Request): Promise<Response> {
    return new Response('GameRoom stub');
  }
}