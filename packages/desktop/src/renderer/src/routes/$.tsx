import { createFileRoute } from "@tanstack/react-router";
import { PageHead } from "@/components/page-head";
import { breadcrumbFor } from "@/nav";

// Every screen from the information architecture that later tickets build.
export const Route = createFileRoute("/$")({ component: NotBuiltYet });

function NotBuiltYet() {
  const { _splat } = Route.useParams();
  const title = breadcrumbFor(`/${_splat ?? ""}`).at(-1) ?? "Dark Matter";
  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-8 px-10 py-9">
      <PageHead title={title} summary="This screen isn't built yet." />
    </div>
  );
}
