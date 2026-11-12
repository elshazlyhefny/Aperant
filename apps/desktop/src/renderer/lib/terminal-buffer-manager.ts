/**
 * Terminal Buffer Manager
 *
 * Singleton that manages terminal output buffers outside of React state.
 * This prevents React re-renders on every terminal output chunk.
 *
 * Each buffer is a list of chunks plus a running length, so append() never
 * concatenates the whole buffer (O(chunk) instead of O(buffer) per write).
 * The list is joined lazily on get()/getAndClear()/getAll() and collapsed
 * back to a single chunk.
 *
 * Inspired by VS Code's DisposableStore pattern.
 */

interface BufferEntry {
  chunks: string[];
  length: number;
}

interface Disposable {
  dispose(): void;
}

class TerminalBufferManager {
  private static instance: TerminalBufferManager;
  private buffers = new Map<string, BufferEntry>();
  private disposables = new Map<string, Disposable[]>();
  private readonly MAX_BUFFER_SIZE = 100_000; // 100KB per terminal

  private constructor() {
    // Private constructor for singleton
  }

  static getInstance(): TerminalBufferManager {
    if (!TerminalBufferManager.instance) {
      TerminalBufferManager.instance = new TerminalBufferManager();
    }
    return TerminalBufferManager.instance;
  }

  /**
   * Append data to a terminal's buffer
   * Automatically truncates to MAX_BUFFER_SIZE
   */
  append(id: string, data: string): void {
    if (data.length === 0 && this.buffers.has(id)) return;
    let entry = this.buffers.get(id);
    if (!entry) {
      entry = { chunks: [], length: 0 };
      this.buffers.set(id, entry);
    }
    entry.chunks.push(data);
    entry.length += data.length;

    // Drop whole chunks from the front while the rest still holds the limit
    while (entry.chunks.length > 1 && entry.length - entry.chunks[0].length >= this.MAX_BUFFER_SIZE) {
      entry.length -= entry.chunks[0].length;
      entry.chunks.shift();
    }
    // Trim the first chunk so the total is exactly MAX_BUFFER_SIZE
    if (entry.length > this.MAX_BUFFER_SIZE) {
      const excess = entry.length - this.MAX_BUFFER_SIZE;
      entry.chunks[0] = entry.chunks[0].slice(excess);
      entry.length = this.MAX_BUFFER_SIZE;
    }
  }

  private join(entry: BufferEntry): string {
    if (entry.chunks.length > 1) {
      entry.chunks = [entry.chunks.join('')];
    }
    return entry.chunks[0] ?? '';
  }

  /**
   * Get the buffer for a terminal
   */
  get(id: string): string {
    const entry = this.buffers.get(id);
    return entry ? this.join(entry) : '';
  }

  /**
   * Set the entire buffer (for restoration)
   */
  set(id: string, buffer: string): void {
    const trimmed = buffer.slice(-this.MAX_BUFFER_SIZE);
    this.buffers.set(id, { chunks: [trimmed], length: trimmed.length });
  }

  /**
   * Clear a terminal's buffer
   */
  clear(id: string): void {
    this.buffers.delete(id);
  }

  /**
   * Atomically get and clear a terminal's buffer
   * This prevents race conditions where data could be appended between get() and clear()
   */
  getAndClear(id: string): string {
    const entry = this.buffers.get(id);
    this.buffers.delete(id);
    return entry ? this.join(entry) : '';
  }

  /**
   * Check if a terminal has a buffer
   */
  has(id: string): boolean {
    return this.buffers.has(id);
  }

  /**
   * Get buffer size in bytes
   */
  getSize(id: string): number {
    return this.buffers.get(id)?.length ?? 0;
  }

  /**
   * Register disposables for proper cleanup (VS Code pattern)
   */
  registerDisposable(id: string, ...disposables: Disposable[]): void {
    const existing = this.disposables.get(id) || [];
    this.disposables.set(id, [...existing, ...disposables]);
  }

  /**
   * Full cleanup when terminal is destroyed
   */
  dispose(id: string): void {
    // Dispose all registered resources
    const disposables = this.disposables.get(id);
    if (disposables) {
      for (const disposable of disposables) {
        try {
          disposable.dispose();
        } catch (e) {
          console.warn(`[TerminalBufferManager] Error disposing resource for ${id}:`, e);
        }
      }
      this.disposables.delete(id);
    }

    // Remove buffer
    this.buffers.delete(id);
  }

  /**
   * For session persistence - get all buffers
   */
  getAll(): Map<string, string> {
    const all = new Map<string, string>();
    for (const [id, entry] of this.buffers) {
      all.set(id, this.join(entry));
    }
    return all;
  }

  /**
   * Get all terminal IDs with buffers
   */
  getAllIds(): string[] {
    return Array.from(this.buffers.keys());
  }

  /**
   * Get total memory usage across all buffers
   */
  getTotalSize(): number {
    let total = 0;
    for (const entry of this.buffers.values()) {
      total += entry.length;
    }
    return total;
  }

  /**
   * Get statistics for debugging
   */
  getStats(): {
    terminalCount: number;
    totalSizeBytes: number;
    maxBufferSize: number;
    buffers: Array<{ id: string; sizeBytes: number }>;
  } {
    const buffers = Array.from(this.buffers.entries()).map(([id, entry]) => ({
      id,
      sizeBytes: entry.length,
    }));

    return {
      terminalCount: this.buffers.size,
      totalSizeBytes: this.getTotalSize(),
      maxBufferSize: this.MAX_BUFFER_SIZE,
      buffers,
    };
  }
}

// Export singleton instance
export const terminalBufferManager = TerminalBufferManager.getInstance();

// For debugging in browser console
if (typeof window !== 'undefined') {
  (window as Window & { __terminalBufferManager?: TerminalBufferManager }).__terminalBufferManager = terminalBufferManager;
}
