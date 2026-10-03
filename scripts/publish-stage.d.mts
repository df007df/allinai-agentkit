export declare function transformManifest(
  manifest: Record<string, unknown>,
): Record<string, unknown>;
export declare function publicationAction(
  result: { status: number | null; stdout: string; error?: Error },
  gitHead: string,
): "publish" | "skip";
