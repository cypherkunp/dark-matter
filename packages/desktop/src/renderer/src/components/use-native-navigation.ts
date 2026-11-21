import { useRouter } from "@tanstack/react-router";
import { useEffect } from "react";

/** Opens the screen main asks for, e.g. the Inbox when a Scheduled Scan notification is clicked. */
export const useNativeNavigation = () => {
  const router = useRouter();
  useEffect(() => window.darkMatter.onNavigate((path) => router.history.push(path)), [router]);
};
