export const HTML_TAILWIND_CLASSES = [
  "block",
  "flex",
  "grid",
  "inline-flex",
  "flex-col",
  "flex-wrap",
  "items-center",
  "justify-between",
  "justify-center",
  "grid-cols-1",
  "grid-cols-2",
  "grid-cols-3",
  "gap-2",
  "gap-3",
  "gap-4",
  "gap-6",
  "p-2",
  "p-3",
  "p-4",
  "p-6",
  "px-3",
  "px-4",
  "py-2",
  "py-3",
  "m-0",
  "mt-2",
  "mt-4",
  "mb-2",
  "mb-4",
  "w-full",
  "max-w-prose",
  "max-w-2xl",
  "text-xs",
  "text-sm",
  "text-base",
  "text-lg",
  "text-xl",
  "text-2xl",
  "font-medium",
  "font-semibold",
  "font-bold",
  "leading-relaxed",
  "text-left",
  "text-center",
  "text-right",
  "text-legion-ink",
  "text-legion-muted",
  "text-legion-cyan",
  "bg-legion-paper",
  "bg-legion-ink",
  "bg-legion-cyan",
  "border",
  "border-2",
  "border-legion-line",
  "rounded",
  "rounded-box",
  "overflow-x-auto",
  "table",
  "table-zebra",
] as const;

export const HTML_DAISY_COMPONENTS = ["alert", "badge", "btn", "card", "stat", "table"] as const;

/**
 * Distinct (deduplicated) view of the full vocabulary. `table` appears
 * in both arrays above (it ships as a Tailwind utility AND a daisyUI
 * component), so a naïve `.length` double-counts it. Use this for any
 * "how many distinct classes shipped" assertion — including the
 * drift-guard test, which derives its expected count from this set so
 * a future deduplication regression (e.g. adding a second duplicate)
 * reddens the doc-block test rather than silently agreeing with itself.
 */
export const HTML_STYLE_CLASSES_DISTINCT = [
  ...new Set<string>([...HTML_TAILWIND_CLASSES, ...HTML_DAISY_COMPONENTS]),
] as const;

/**
 * Flat view of the vocabulary used by the Tailwind class-name build.
 * Duplicates `table` (Tailwind utility AND daisyUI component) so the
 * vendored CSS ship output keeps the `.table` class even if a future
 * dedup removes one of its sources — but DO NOT use this for any
 * "how many distinct classes shipped" assertion; use
 * `HTML_STYLE_CLASSES_DISTINCT` instead.
 */
export const HTML_STYLE_CLASSES = [...HTML_TAILWIND_CLASSES, ...HTML_DAISY_COMPONENTS] as const;
