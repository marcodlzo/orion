import { CardsSkeleton, PageSkeleton } from "@/components/PageSkeleton";

export default function Loading() {
  return (
    <PageSkeleton label="Loading your bank accounts">
      <CardsSkeleton count={2} />
    </PageSkeleton>
  );
}
