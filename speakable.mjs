// Markdown → speakable text.
//
// DSH replies are markdown: code fences, tables, links, file paths, tool chrome.
// Handing that to a speech synthesizer produces hours of "asterisk asterisk" and
// "M E D I A colon slash", so a provider-independent normalizer runs first.
//
// The rules are deliberately conservative: keep what a person would read aloud,
// drop what only works on screen. Everything here is a pure function, so the
// whole module is testable offline.

/** Text a synthesizer should never be asked to pronounce. */
const DROP_LINE = [
  /^\s*```/, // fence markers (the body is dropped whole, see below)
  /^\s*\|.*\|\s*$/, // table rows
  /^\s*[-*_]{3,}\s*$/, // horizontal rules
  /^\s*(media|image):/i, // MEDIA: delivery paths
  /^\s*<\/?[a-z][^>]*>\s*$/i, // a bare html tag line
];

export function speakableText(markdown, { maxChars = 0 } = {}) {
  if (typeof markdown !== 'string') return '';
  const lines = markdown.replace(/\r\n?/g, '\n').split('\n');
  const kept = [];
  let inFence = false;

  for (const raw of lines) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      // A short spoken marker keeps the listener aware something was skipped,
      // without reading the code itself.
      if (!inFence) kept.push('');
      continue;
    }
    if (inFence) continue;
    if (DROP_LINE.some((pattern) => pattern.test(raw))) continue;

    kept.push(
      raw
        // Markdown structure: headings, quotes, list bullets, task boxes.
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/^\s{0,3}>\s?/, '')
        .replace(/^\s*[-*+]\s+\[[ xX]\]\s+/, '')
        .replace(/^\s*(?:[-*+]|\d{1,3}[.)])\s+/, '')
        // Links and images: keep the label, drop the target.
        .replace(/!\[([^\]]*)\]\([^)]*\)/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
        // Bare URLs (http, https, file, and local paths inside backticks).
        .replace(/<?(?:https?|file):\/\/\S+>?/gi, '')
        // Inline code: read the content, not the backticks.
        .replace(/`([^`]*)`/g, '$1')
        // Emphasis, strikethrough, and stray html.
        .replace(/(\*\*|__|\*|~~)/g, '')
        .replace(/<\/?[a-z][^>]*>/gi, '')
        // Emoji and pictographs read as noise.
        .replace(/[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, ''),
    );
  }

  const text = kept
    .join('\n')
    .replace(/[ \t]+/g, ' ')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return maxChars > 0 && text.length > maxChars ? `${text.slice(0, maxChars).trimEnd()}` : text;
}

/**
 * Whether a reply is worth speaking at all.
 *
 * A message that is only a tool card, a file path, or a few characters of
 * punctuation would produce silence or a single stray word.
 */
export function isSpeakable(text, { minLetters = 2 } = {}) {
  if (typeof text !== 'string') return false;
  const words = text.match(/[\p{L}\p{N}]/gu);
  return (words?.length ?? 0) >= minLetters;
}
