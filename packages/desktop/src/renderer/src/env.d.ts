import type { DarkMatterBridge } from "../../shared/bridge";

declare global {
  interface Window {
    darkMatter: DarkMatterBridge;
  }
}
