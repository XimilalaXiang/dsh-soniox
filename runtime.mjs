// Loading Host packages from an out-of-tree plugin.
//
// A plugin installed into a profile cannot `import '@deepseek-ai/dsh-tools'`:
// ESM resolves bare specifiers from the plugin's own directory upwards, and the
// harness packages live in the *runtime* install, not next to the plugin. The
// Host launcher does expose its location though — `dsh` runs from
// `<runtime>/node_modules/.bin/dsh` — so the scope root is one walk up from
// `process.argv[1]`.
//
// This is a compatibility shim, not a preference: prefer `ctx.get(service)` and
// node builtins, and reach for this only when a Host helper (schema conversion,
// tool definition) is genuinely required.
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';

const cache = new Map();

/**
 * Node modules root of the running harness, or null when it cannot be found.
 *
 * `DSH_ROOT` wins when set, which is how an out-of-process caller (a script, a
 * test) names a runtime that is not its own ancestor.
 */
export function hostScopeRoot(argv1 = process.argv[1]) {
  if (process.env.DSH_ROOT) return join(process.env.DSH_ROOT, 'node_modules');
  if (typeof argv1 !== 'string' || !argv1) return null;
  let directory = dirname(argv1);
  for (let depth = 0; depth < 8 && directory !== '/' && directory !== '.'; depth += 1) {
    if (directory.endsWith('node_modules')) return directory;
    directory = dirname(directory);
  }
  return null;
}

/**
 * Import one Host package by absolute path.
 * @param specifier - package name, e.g. `@deepseek-ai/dsh-tools`.
 * @param [entry] - file inside the package, defaulting to its ESM entry.
 * @returns the module namespace, or null when the runtime cannot be located.
 */
export async function importHostPackage(specifier, { entry = 'lib/index.js', argv1 } = {}) {
  const root = hostScopeRoot(argv1);
  if (!root) return null;
  const key = `${root}\u0000${specifier}\u0000${entry}`;
  if (cache.has(key)) return cache.get(key);
  const promise = import(pathToFileURL(join(root, ...specifier.split('/'), ...entry.split('/'))).href).catch(() => null);
  cache.set(key, promise);
  return promise;
}
