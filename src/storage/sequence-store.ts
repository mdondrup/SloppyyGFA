export class FileSequenceStore {
  readonly #file: File;
  readonly #offsets: Float64Array;
  readonly #lengths: Uint32Array;

  constructor(file: File, offsets: Float64Array, lengths: Uint32Array) {
    this.#file = file;
    this.#offsets = offsets;
    this.#lengths = lengths;
  }

  async get(index: number): Promise<string | null> {
    if (!Number.isInteger(index) || index < 0 || index >= this.#offsets.length) {
      throw new RangeError(`Segment index ${index} is out of range`);
    }
    const length = this.#lengths[index]!;
    if (length === 0) return null;
    const offset = this.#offsets[index]!;
    return this.#file.slice(offset, offset + length).text();
  }
}
