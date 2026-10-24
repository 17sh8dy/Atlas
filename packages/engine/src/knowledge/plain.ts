/**
 * Markdown reduced to the plain sentences a person would read: code blocks and tables dropped (a grid of pipes
 * or an install command is not an answer), emphasis, headings and links unwrapped.
 */
export function plainText(markdown: string): string {
  const withoutFences = markdown.replace(/```[\s\S]*?(?:```|$)/g, '\n');
  return withoutFences
    .split('\n')
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*[-*_]{3,}\s*$/.test(l))
    .map((l) =>
      l
        .replace(/^\s{0,3}#{1,6}\s+/, '')
        .replace(/\*\*(.+?)\*\*/g, '$1')
        .replace(/`([^`]+)`/g, '$1')
        .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1'),
    )
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** How much of a chunk is readable prose: a chunk that is mostly table or code is a poor answer however well it matches. */
export function substance(markdown: string): number {
  return markdown.length === 0 ? 0 : plainText(markdown).length / markdown.length;
}
