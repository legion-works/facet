export function artifactMainAttributes(artifactType: string): string {
  return `id="artifact" data-facet-artifact-type="${artifactType}"`;
}
