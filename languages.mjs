// Language handling.
//
// Soniox takes bare ISO 639-1 codes as hints (`language_hints`), while DSH
// validates the selected language against the provider's advertised
// `info.languages` before a recording is accepted. The two lists therefore have
// to agree, and `auto` is DSH's spelling for "send no hint at all".

/** Registry-level language hints this provider accepts. */
export const LANGUAGES = Object.freeze([
  'auto',
  'zh',
  'en',
  'ja',
  'ko',
  'yue',
  'es',
  'fr',
  'de',
  'it',
  'pt',
  'ru',
  'ar',
  'hi',
  'th',
  'vi',
  'id',
  'nl',
  'pl',
  'tr',
  'uk',
]);

/**
 * `zh-CN` / `EN_us` -> `zh`; unknown input -> null.
 *
 * Soniox rejects region-qualified codes, and DSH's own UI already speaks bare
 * codes, so this only normalizes configuration written by hand.
 */
export function normalizeLanguage(value) {
  if (typeof value !== 'string') return null;
  const code = value.trim().replace(/_/g, '-').split('-')[0].toLowerCase();
  return code || null;
}

/**
 * Build the `language_hints` list for one recording.
 *
 * Precedence: the language DSH selected for this recording, then configured
 * hints. `auto` (and an empty selection) contributes nothing, which tells
 * Soniox to detect the language itself. Hints bias recognition; they do not
 * restrict it.
 */
export function languageHints(selected, configured) {
  const source = [];
  const chosen = normalizeLanguage(selected);
  if (chosen && chosen !== 'auto') source.push(chosen);
  if (source.length === 0) {
    const raw = Array.isArray(configured) ? configured : typeof configured === 'string' ? configured.split(',') : [];
    for (const entry of raw) {
      const code = normalizeLanguage(entry);
      if (code && code !== 'auto') source.push(code);
    }
  }
  const hints = [];
  for (const code of source) if (!hints.includes(code)) hints.push(code);
  return hints;
}
