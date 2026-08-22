export type GalleryThemeMode = "dark" | "light" | "system";

export type ResolvedGalleryTheme = Exclude<GalleryThemeMode, "system">;

export type GalleryMatchMedia =
  | ((query: string) => Pick<MediaQueryList, "matches"> | null | undefined)
  | null
  | undefined;

export function isGalleryThemeMode(value: unknown): value is GalleryThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

export function isResolvedGalleryTheme(value: unknown): value is ResolvedGalleryTheme {
  return value === "dark" || value === "light";
}

export function resolveGalleryTheme(
  mode: GalleryThemeMode,
  matchMedia: GalleryMatchMedia,
): ResolvedGalleryTheme {
  if (mode !== "system") return mode;
  try {
    const preference = matchMedia?.("(prefers-color-scheme: dark)");
    if (
      preference === null ||
      preference === undefined ||
      typeof preference.matches !== "boolean"
    ) {
      return "dark";
    }
    return preference.matches ? "dark" : "light";
  } catch {
    return "dark";
  }
}

export function galleryDataTheme(theme: ResolvedGalleryTheme): "night" | "winter" {
  return theme === "light" ? "winter" : "night";
}
