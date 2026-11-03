// Credential lookup shared by the STT provider and the TTS surface.
import { readFileSync } from 'node:fs';

/**
 * Read the API key: the Host credential store, then an environment variable,
 * then a file.
 *
 * A `CredentialRef` in DSH is an environment-variable-shaped name that resolves
 * through the provider-managed store first and ambient fallbacks (`$DSH_HOME/.env`,
 * `process.env`) afterwards, so one `resolve()` call covers both the stored-secret
 * and the exported-variable case. Resolution happens per call, so a key stored
 * later is picked up without restarting the Host.
 */
export async function resolveApiKey(options, ctx, { hasCredentials } = {}) {
  const credentials = hasCredentials ?? (typeof ctx?.get === 'function' ? ctx.get('credentials') : null);
  const ref = options.apiKeyRef ?? options.apiKeyEnv;
  if (ref && typeof credentials?.resolve === 'function') {
    try {
      const resolved = await credentials.resolve(ref);
      const value = typeof resolved?.value === 'string' ? resolved.value.trim() : '';
      if (value) return value;
    } catch {
      // An unreachable credential store falls through to the ambient layers.
    }
  }
  if (options.apiKeyEnv) {
    const value = process.env[options.apiKeyEnv];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  if (options.apiKeyFile) {
    try {
      const value = readFileSync(options.apiKeyFile, 'utf8').trim();
      if (value) return value;
    } catch {
      // A missing key file simply leaves the key empty; the caller reports it.
    }
  }
  return '';
}
