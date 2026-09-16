import { CardsSkeleton, PageSkeleton, TableSkeleton } from "@/components/PageSkeleton";

/**
 * The dashboard, and the fallback for any route in this group without its own.
 *
 * The sidebar is NOT redrawn here: `loading.tsx` replaces the layout's children,
 * so the navigation stays put and only the content area swaps. That is the
 * point — the tab you clicked highlights immediately, which is the feedback
 * that was missing.
 */
export default function Loading() {
  return (
    <PageSkeleton label="Loading your accounts">
      <CardsSkeleton count={2} />
      <TableSkeleton rows={6} />
    </PageSkeleton>
  );
}
