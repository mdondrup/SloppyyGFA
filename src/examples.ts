/** Example graphs from `tests/data`, served by GitHub with permissive CORS headers. */
export const EXAMPLE_BASE_URL = "https://raw.githubusercontent.com/mdondrup/SloppyyGFA/main/tests/data/";

export interface Example {
  readonly id: string;
  readonly label: string;
  readonly file: string;
  readonly bytes: number;
  readonly segments: number;
}

export const EXAMPLES: readonly Example[] = [
  { id: "plant", label: "Plant metagenome", file: "Pract6_Plant_meta.gfa", bytes: 7_506_852, segments: 959 },
  { id: "sea", label: "Sea metagenome", file: "Pract6_Sea_metaFlye.gfa", bytes: 9_204_191, segments: 721 },
  { id: "stool", label: "Stool metagenome", file: "Pract6_Stool_meta.gfa", bytes: 75_305_088, segments: 103_426 },
];

/**
 * Downloads an example into an in-memory `File`, so it is parsed and its sequences are read
 * exactly like a local file. `onProgress` receives the decoded bytes received so far.
 */
export async function downloadExample(
  example: Example,
  signal: AbortSignal,
  onProgress: (loaded: number) => void,
  baseUrl = EXAMPLE_BASE_URL,
): Promise<File> {
  const response = await fetch(new URL(example.file, baseUrl), { signal });
  if (!response.ok) throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
  const chunks: BlobPart[] = [];
  if (response.body) {
    const reader = response.body.getReader();
    let loaded = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      loaded += value.byteLength;
      onProgress(loaded);
    }
  } else {
    chunks.push(await response.blob());
  }
  return new File(chunks, example.file, { type: "text/plain" });
}
