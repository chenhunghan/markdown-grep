/**
 * Chunks markdown content into smaller pieces for indexing.
 * Uses markdown structure (headings, paragraphs, code blocks) as natural break points.
 */

export interface Chunk {
  content: string;
  startLine: number;
  endLine: number;
  index: number;
}

const MAX_CHUNK_LINES = 60;
const OVERLAP_LINES = 8;

/**
 * Split markdown content into chunks.
 * Strategy:
 *   1. Split on headings (##, ###, etc.) as primary boundaries
 *   2. If a section exceeds MAX_CHUNK_LINES, split on blank lines
 *   3. Apply overlap between chunks for context continuity
 */
export function chunkMarkdown(content: string): Chunk[] {
  const lines = content.split("\n");
  if (lines.length === 0) {
    return [{ content: "", startLine: 1, endLine: 1, index: 0 }];
  }

  // Find heading boundaries
  const boundaries: number[] = [0];
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i]!;
    // Heading line (# ... or ## ... etc.)
    if (/^#{1,6}\s/.test(line)) {
      boundaries.push(i);
    }
  }
  boundaries.push(lines.length);

  // Create sections from heading boundaries
  const sections: { startLine: number; endLine: number; lines: string[] }[] = [];
  for (let i = 0; i < boundaries.length - 1; i++) {
    const start = boundaries[i]!;
    const end = boundaries[i + 1]!;
    sections.push({
      startLine: start,
      endLine: end - 1,
      lines: lines.slice(start, end),
    });
  }

  // Split oversized sections on blank lines
  const chunks: Chunk[] = [];
  let chunkIndex = 0;

  for (const section of sections) {
    if (section.lines.length <= MAX_CHUNK_LINES) {
      chunks.push({
        content: section.lines.join("\n"),
        startLine: section.startLine + 1, // 1-indexed
        endLine: section.endLine + 1,
        index: chunkIndex++,
      });
    } else {
      // Split on blank lines within the section
      const subChunks = splitOnBlankLines(section.lines, section.startLine);
      for (const sub of subChunks) {
        chunks.push({ ...sub, index: chunkIndex++ });
      }
    }
  }

  // Apply overlap: prepend last OVERLAP_LINES of previous chunk
  if (chunks.length > 1) {
    for (let i = 1; i < chunks.length; i++) {
      const prev = chunks[i - 1]!;
      const prevLines = prev.content.split("\n");
      if (prevLines.length > OVERLAP_LINES) {
        const overlap = prevLines.slice(-OVERLAP_LINES).join("\n");
        chunks[i]!.content = overlap + "\n" + chunks[i]!.content;
        chunks[i]!.startLine = Math.max(1, chunks[i]!.startLine - OVERLAP_LINES);
      }
    }
  }

  return chunks;
}

function splitOnBlankLines(
  lines: string[],
  baseLineOffset: number
): Omit<Chunk, "index">[] {
  const result: Omit<Chunk, "index">[] = [];
  let currentLines: string[] = [];
  let currentStart = 0;

  for (let i = 0; i < lines.length; i++) {
    currentLines.push(lines[i]!);

    const isBlankLine = lines[i]!.trim() === "";
    const atLimit = currentLines.length >= MAX_CHUNK_LINES;

    if (isBlankLine && atLimit) {
      result.push({
        content: currentLines.join("\n"),
        startLine: baseLineOffset + currentStart + 1,
        endLine: baseLineOffset + i + 1,
      });
      currentLines = [];
      currentStart = i + 1;
    }
  }

  // Remaining lines
  if (currentLines.length > 0) {
    result.push({
      content: currentLines.join("\n"),
      startLine: baseLineOffset + currentStart + 1,
      endLine: baseLineOffset + lines.length,
    });
  }

  return result;
}
