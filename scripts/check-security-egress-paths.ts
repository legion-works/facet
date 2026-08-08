export const SECURITY_EGRESS_PATH_PATTERN =
  /^(scripts\/(launch-netns\.sh|egress-penetration\.ts)|src\/(gallery-web\/.+|validation\/.+|service\/security\/.+)|src\/.*\/(frame-html|token[^/]*)\.ts|tests\/acceptance\/(egress|gate-forgery)\.test\.ts|\.github\/workflows\/security-egress\.yml)$/;

export function isSecurityEgressPath(path: string): boolean {
  return SECURITY_EGRESS_PATH_PATTERN.test(path);
}

export function main(paths: readonly string[] = process.argv.slice(2)): void {
  for (const path of paths)
    console.log(`${isSecurityEgressPath(path) ? "match" : "no-match"}\t${path}`);
}

if (import.meta.main) main();
