/**
 * Streaming export sink — a thin JS handle over the Rust file writer
 * (`begin_export` / `write_export_chunk` / `finish_export`). Rust writes to a
 * temp sidecar beside the chosen path and renames on `finish()` so a failed or
 * cancelled export never truncates an existing destination file.
 *
 * The Rust side does positioned writes, so this works for both streaming muxers
 * (mediabunny `StreamTarget`, which writes out of order) and sequential
 * producers (GIF, which passes a monotonic offset via `append`).
 */

import type { StreamTargetChunk } from "mediabunny";
import { commands } from "../../../ipc/bindings";
import { describeError } from "../../recorder/store";

export class ExportSink {
  private offset = 0;
  private written = 0;

  private constructor(private readonly handle: number) {}

  static async open(path: string): Promise<ExportSink> {
    return new ExportSink(await commands.beginExport(path));
  }

  /** High-water mark of bytes written — the resulting file size. */
  get bytesWritten(): number {
    return this.written;
  }

  /** Write `data` at an absolute byte offset (for `StreamTarget`). */
  writeAt(position: number, data: Uint8Array): Promise<void> {
    this.written = Math.max(this.written, position + data.byteLength);
    return commands.writeExportChunk(this.handle, position, data);
  }

  /** Append `data` sequentially, tracking the running offset. */
  async append(data: Uint8Array): Promise<void> {
    const at = this.offset;
    this.offset += data.byteLength;
    await this.writeAt(at, data);
  }

  /**
   * A `WritableStream` for mediabunny's `StreamTarget`. Each `write` awaits the
   * disk write, so encoder backpressure propagates and memory stays bounded.
   */
  writable(): WritableStream<StreamTargetChunk> {
    return new WritableStream<StreamTargetChunk>({
      write: (chunk) => this.writeAt(chunk.position, chunk.data),
    });
  }

  /** Flush, close, and return the final file path. */
  finish(): Promise<string> {
    return commands.finishExport(this.handle);
  }

  /** Close and delete the partial file. Best-effort; never throws. */
  async abort(error: unknown): Promise<void> {
    await commands.abortExport(this.handle, describeError(error)).catch(() => undefined);
  }
}
