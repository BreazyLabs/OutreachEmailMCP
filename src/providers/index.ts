import type { Provider } from './types.js';
import { googleProvider } from './google.js';
import { microsoftProvider } from './microsoft.js';
import type { ProviderName } from './oauth.js';

const registry: Record<ProviderName, Provider> = {
  google: googleProvider,
  microsoft: microsoftProvider,
};

export function providerFor(name: string): Provider {
  const provider = registry[name as ProviderName];
  if (!provider) throw new Error(`Unknown provider: ${name}`);
  return provider;
}

export type { Provider } from './types.js';
