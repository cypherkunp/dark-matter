import { createFileRoute } from "@tanstack/react-router";
import { Page } from "@/components/page";
import { PageHead } from "@/components/page-head";
import { breadcrumbFor } from "@/nav";

// Every screen from the information architecture that later tickets build.
export const Route = createFileRoute("/$")({ component: NotBuiltYet });

function NotBuiltYet() {
  const { _splat } = Route.useParams();
  const title = breadcrumbFor(`/${_splat ?? ""}`).at(-1) ?? "Dark Matter";
  return (
    <Page>
      <PageHead title={title} summary="This screen isn't built yet." />
    </Page>
  );
}
