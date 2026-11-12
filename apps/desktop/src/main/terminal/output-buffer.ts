/**
 * Bounded terminal output buffer backed by a chunk list.
 *
 * Appending is O(chunk): chunks are pushed and old ones dropped from the front,
 * instead of rebuilding a ~100 KB string on every PTY chunk. The joined string
 * is only built (and cached) when it is read.
 */

export const DEFAULT_MAX_OUTPUT_BUFFER_CHARS = 100_000;

export class TerminalOutputBuffer {
  private chunks: string[] = [];
  private currentLength = 0;
  private totalAppended = 0;
  private cached: string | null = '';

  constructor(private readonly max: number = DEFAULT_MAX_OUTPUT_BUFFER_CHARS) {}

  append(data: string): void {
    if (data.length === 0) return;
    this.chunks.push(data);
    this.currentLength += data.length;
    this.totalAppended += data.length;
    this.cached = null;
    this.trim();
  }

  private trim(): void {
    // Drop whole chunks from the front while the remainder still satisfies the limit.
    let drop = 0;
    while (drop < this.chunks.length - 1 && this.currentLength - this.chunks[drop].length >= this.max) {
      this.currentLength -= this.chunks[drop].length;
      drop++;
    }
    if (drop > 0) this.chunks.splice(0, drop);

    // Still over the limit: slice only the first remaining chunk.
    if (this.currentLength > this.max && this.chunks.length > 0) {
      const excess = this.currentLength - this.max;
      this.chunks[0] = this.chunks[0].slice(excess);
      this.currentLength = this.max;
    }
  }

  toString(): string {
    if (this.cached === null) {
      const joined = this.chunks.join('');
      this.chunks = joined.length > 0 ? [joined] : [];
      this.cached = joined;
    }
    return this.cached;
  }

  /** Total characters ever appended; never reduced by trimming. */
  getTotalAppended(): number {
    return this.totalAppended;
  }

  /** Output appended after the given total offset, clamped to what is still retained. */
  readSince(offset: number): string {
    const retainedStart = this.totalAppended - this.currentLength;
    if (offset >= this.totalAppended) return '';
    if (offset <= retainedStart) return this.toString();
    return this.toString().slice(offset - retainedStart);
  }

  get length(): number {
    return this.currentLength;
  }

  clear(): void {
    this.chunks = [];
    this.currentLength = 0;
    this.cached = '';
  }

  set(value: string): void {
    const kept = value.length > this.max ? value.slice(-this.max) : value;
    this.chunks = kept.length > 0 ? [kept] : [];
    this.currentLength = kept.length;
    this.totalAppended += value.length;
    this.cached = kept;
  }
}
