import { createFileRoute, redirect } from "@tanstack/react-router";

// The app opens on the Library (#15).
export const Route = createFileRoute("/")({
  beforeLoad: () => {
    throw redirect({ to: "/library" });
  },
});
