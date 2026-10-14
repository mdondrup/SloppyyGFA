import { describe, expect, it } from "vitest";

import { FileSequenceStore } from "../src/storage/sequence-store";

describe("FileSequenceStore", () => {
  it("reads only the indexed byte range", async () => {
    const file = new File(["prefixACGTsuffix"], "graph.gfa");
    const store = new FileSequenceStore(file, new Float64Array([6]), new Uint32Array([4]));

    await expect(store.get(0)).resolves.toBe("ACGT");
  });

  it("represents absent sequences as null and rejects invalid indexes", async () => {
    const file = new File(["*"], "graph.gfa");
    const store = new FileSequenceStore(file, new Float64Array([0]), new Uint32Array([0]));

    await expect(store.get(0)).resolves.toBeNull();
    await expect(store.get(1)).rejects.toThrow(RangeError);
  });
});
