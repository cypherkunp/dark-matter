import { useMutation, useQuery } from "@tanstack/react-query";
import { useTRPC } from "@/lib/trpc";

/** Runs a Scan and reports whether one is running, whoever started it. */
export const useScan = () => {
  const trpc = useTRPC();
  const status = useQuery(trpc.scan.status.queryOptions());
  const run = useMutation(trpc.scan.run.mutationOptions());
  return {
    scan: () => run.mutate(),
    scanning: run.isPending || (status.data?.running ?? false),
    lastScanAt: status.data?.lastScanAt ?? null,
  };
};
