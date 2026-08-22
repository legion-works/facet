export type GalleryThemeMode = "dark" | "light" | "system";

export type ResolvedGalleryTheme = Exclude<GalleryThemeMode, "system">;

export function isGalleryThemeMode(value: unknown): value is GalleryThemeMode {
  return value === "dark" || value === "light" || value === "system";
}

export function isResolvedGalleryTheme(value: unknown): value is ResolvedGalleryTheme {
  return value === "dark" || value === "light";
}

export function galleryDataTheme(theme: ResolvedGalleryTheme): "night" | "winter" {
  return theme === "light" ? "winter" : "night";
}
