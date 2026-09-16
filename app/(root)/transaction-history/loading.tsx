import { PageSkeleton, TableSkeleton } from "@/components/PageSkeleton";

export default function Loading() {
  return (
    <PageSkeleton label="Loading transaction history">
      <TableSkeleton rows={10} />
    </PageSkeleton>
  );
}
