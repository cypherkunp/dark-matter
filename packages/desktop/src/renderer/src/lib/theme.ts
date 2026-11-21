/** Follows the system appearance: `.dark` on <html> switches the theme tokens. */
export const followSystemTheme = () => {
  const media = window.matchMedia("(prefers-color-scheme: dark)");
  const apply = () => document.documentElement.classList.toggle("dark", media.matches);
  apply();
  media.addEventListener("change", apply);
};
