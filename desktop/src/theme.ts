export type Appearance = "system" | "dark" | "light";
export const media = matchMedia("(prefers-color-scheme: dark)");
export function savedAppearance(): Appearance {
  try {
    const value = localStorage.getItem("codexbei.appearance");
    if (value === "dark" || value === "light") return value;
  } catch {
    /* Use system preference. */
  }
  return "system";
}
export function applyAppearance(value: Appearance) {
  document.documentElement.dataset.theme =
    value === "system" ? (media.matches ? "dark" : "light") : value;
}
applyAppearance(savedAppearance());
