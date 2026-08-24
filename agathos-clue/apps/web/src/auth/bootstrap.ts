import { loadEmbeddedSession, type EmbeddedSdkFactory, type EmbeddedSession } from './embedded';
import { loadStandaloneSession, type StandaloneSession } from './standalone';

export interface AuthBootstrapOptions {
  embedded?: boolean;
  browserWindow?: Window;
  clientId?: string;
  fetcher?: typeof fetch;
  redirect?: (path: string) => void;
  sdkFactory?: EmbeddedSdkFactory;
}

export function isEmbeddedContext(browserWindow: Window | undefined =
  typeof window === 'undefined' ? undefined : window): boolean {
  if (browserWindow === undefined) return false;
  try {
    return browserWindow.self !== browserWindow.top;
  } catch {
    return true;
  }
}

export function bootstrapAuth(
  options: AuthBootstrapOptions = {},
): Promise<EmbeddedSession | StandaloneSession | null> {
  const embedded = options.embedded ?? isEmbeddedContext(options.browserWindow);
  if (embedded) {
    return loadEmbeddedSession({
      clientId: options.clientId,
      fetcher: options.fetcher,
      sdkFactory: options.sdkFactory,
    });
  }
  return loadStandaloneSession(options.fetcher, options.redirect);
}
