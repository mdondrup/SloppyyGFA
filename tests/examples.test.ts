import { afterEach, describe, expect, it, vi } from "vitest";

import { downloadExample, EXAMPLE_BASE_URL, EXAMPLES } from "../src/examples";

afterEach(() => {
  vi.unstubAllGlobals();
});

function streamOf(parts: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const part of parts) controller.enqueue(encoder.encode(part));
      controller.close();
    },
  });
}

describe("examples", () => {
  it("lists the bundled test graphs on the main branch", () => {
    expect(EXAMPLE_BASE_URL).toBe("https://raw.githubusercontent.com/mdondrup/SloppyyGFA/main/tests/data/");
    expect(EXAMPLES.map(({ file }) => file)).toEqual([
      "Pract6_Plant_meta.gfa",
      "Pract6_Sea_metaFlye.gfa",
      "Pract6_Stool_meta.gfa",
    ]);
  });

  it("downloads an example into a named File and reports progress", async () => {
    const fetchMock = vi.fn(async (_url: URL) => new Response(streamOf(["S\ts1\tACGT\n", "S\ts2\tGG\n"])));
    vi.stubGlobal("fetch", fetchMock);
    const progress: number[] = [];
    const file = await downloadExample(EXAMPLES[0]!, new AbortController().signal, (loaded) => progress.push(loaded));

    expect(String(fetchMock.mock.calls[0]![0])).toBe(`${EXAMPLE_BASE_URL}Pract6_Plant_meta.gfa`);
    expect(file.name).toBe("Pract6_Plant_meta.gfa");
    expect(await file.text()).toBe("S\ts1\tACGT\nS\ts2\tGG\n");
    expect(progress).toEqual([10, 18]);
  });

  it("rejects failed downloads", async () => {
    vi.stubGlobal("fetch", async () => new Response("missing", { status: 404, statusText: "Not Found" }));
    await expect(downloadExample(EXAMPLES[1]!, new AbortController().signal, () => {})).rejects.toThrow(
      "HTTP 404 Not Found",
    );
  });
});
