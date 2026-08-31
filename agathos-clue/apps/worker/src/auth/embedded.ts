import type { Env } from '../index';
import { mintJwt } from './jwt';
import {
  boundedParam,
  exchangeCode,
  fetchDiscordUser,
  isBoundedString,
  isDiscordUserId,
  isJsonContentType,
  MAX_CLIENT_ID_LENGTH,
  MAX_CODE_LENGTH,
  MAX_DISCORD_TOKEN_LENGTH,
  readJsonRequest,
} from './discord';

const ACCESS_TOKEN_TTL_SECONDS = 3_600;
const SESSION_TTL_SECONDS = 86_400;
const SESSION_COOKIE = 'clue-session';

export async function handleEmbedded(req: Request, env: Env): Promise<Response> {
  if (req.method !== 'POST') return methodNotAllowed();
  if (!isJsonContentType(req.headers.get('Content-Type'))) return authenticationFailure(400);
  if (!isBoundedString(env.DISCORD_CLIENT_ID, MAX_CLIENT_ID_LENGTH) ||
      !isBoundedString(env.DISCORD_CLIENT_SECRET, MAX_DISCORD_TOKEN_LENGTH) ||
      !isBoundedString(env.JWT_SECRET, 4_096)) {
    return authenticationFailure(503);
  }

  let value: Record<string, unknown>;
  try {
    value = await readJsonRequest(req);
  } catch {
    return authenticationFailure(400);
  }
  const code = boundedParam(value.code, MAX_CODE_LENGTH);
  if (code === null) return authenticationFailure(400);

  try {
    const token = await exchangeCode(code, env, false);
    const discordUser = await fetchDiscordUser(token.accessToken);
    if (!isDiscordUserId(discordUser.id)) return authenticationFailure(502);

    const sessionToken = await mintJwt({ userId: discordUser.id }, env.JWT_SECRET, SESSION_TTL_SECONDS);
    const accessToken = await mintJwt({ userId: discordUser.id }, env.JWT_SECRET, ACCESS_TOKEN_TTL_SECONDS);
    const response = json({
      authenticated: true,
      userId: discordUser.id,
      token: accessToken,
      access_token: token.accessToken,
    });
    response.headers.append('Set-Cookie', `${SESSION_COOKIE}=${encodeURIComponent(sessionToken)}; Max-Age=${SESSION_TTL_SECONDS}; Path=/; HttpOnly; SameSite=Lax; Secure`);
    return response;
  } catch {
    return authenticationFailure(502);
  }
}

function authenticationFailure(status: number): Response {
  return text('authentication failed', status);
}

function json(value: unknown, status = 200): Response {
  return Response.json(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function text(value: string, status: number): Response {
  return new Response(value, {
    status,
    headers: { 'Cache-Control': 'no-store' },
  });
}

function methodNotAllowed(): Response {
  return text('method not allowed', 405);
}
