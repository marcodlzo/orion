import { FormSkeleton, PageSkeleton } from "@/components/PageSkeleton";

export default function Loading() {
  return (
    <PageSkeleton label="Loading the transfer form">
      <FormSkeleton fields={5} />
    </PageSkeleton>
  );
}
