import { useQueryClient } from "@tanstack/react-query";
import { useSubscription } from "@trpc/tanstack-react-query";
import { useTRPC } from "@/lib/trpc";

/**
 * Subscribes to the core's `events` and invalidates the queries each event
 * names. Returns whether the subscription is live, i.e. the core is connected.
 */
export const useCoreEvents = () => {
  const trpc = useTRPC();
  const queryClient = useQueryClient();
  const subscription = useSubscription(
    trpc.events.subscriptionOptions(undefined, {
      onData: (event) => {
        for (const domain of event.domains) {
          void queryClient.invalidateQueries({ queryKey: trpc[domain].pathKey() });
        }
        // skills.sh results mark "in Library"; the core answers a re-run from its cache.
        if (event.domains.includes("library")) {
          void queryClient.invalidateQueries({ queryKey: trpc.skillsSh.search.pathKey() });
          // The Favourites view lists Library Skills from starred Sources.
          void queryClient.invalidateQueries({ queryKey: trpc.favourites.pathKey() });
        }
      },
    }),
  );
  return { connected: subscription.status === "pending" };
};
