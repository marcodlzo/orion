/**
 * Placeholder shapes shown while a page's server render is in flight.
 *
 * WHY THIS EXISTS. Clicking a nav link used to change nothing on screen for one
 * to three seconds. The App Router blocks navigation until the new route's
 * payload is ready, and with no `loading.tsx` anywhere the browser kept
 * rendering the OLD page for the whole wait — so the click read as ignored, and
 * the honest response was to click it again.
 *
 * These are not a fix for the latency. They are a fix for the LIE: the
 * application knew a navigation had started and was showing something that said
 * otherwise. The underlying cost is a live Plaid balance call per render, which
 * must not be cached away — a stale balance in a banking interface is a wrong
 * number, not a slow one.
 *
 * Deliberately not a spinner. A spinner says "something is happening
 * somewhere"; a shape says "this page, here, and it will look like this", which
 * also stops the layout jumping when the real content lands.
 */

/** One shimmering block. `aria-hidden` — the live region announces, not this. */
const Block = ({ className = "" }: { className?: string }) => (
  <div
    aria-hidden
    className={`animate-pulse rounded-lg bg-gray-200 ${className}`}
  />
);

/** The heading every page opens with. */
const HeaderSkeleton = () => (
  <header className="flex flex-col gap-2">
    <Block className="h-8 w-64" />
    <Block className="h-4 w-80" />
  </header>
);

/**
 * Announced ONCE, politely, rather than per shape.
 *
 * Screen-reader users get no visual shimmer, so without this the page is simply
 * silent for the whole wait — the same defect, in another modality.
 */
const Announce = ({ label }: { label: string }) => (
  <p role="status" aria-live="polite" className="sr-only">
    {label}
  </p>
);

export const PageSkeleton = ({
  label,
  children,
}: {
  label: string;
  children?: React.ReactNode;
}) => (
  <section className="no-scrollbar flex w-full flex-col gap-8 overflow-y-scroll p-8 xl:py-12">
    <Announce label={label} />
    <HeaderSkeleton />
    {children}
  </section>
);

/** A row of account cards — my-banks, and the dashboard's account strip. */
export const CardsSkeleton = ({ count = 2 }: { count?: number }) => (
  <div className="flex flex-wrap gap-6">
    {Array.from({ length: count }, (_, i) => (
      <Block key={i} className="h-48 w-80" />
    ))}
  </div>
);

/** A table of transactions. */
export const TableSkeleton = ({ rows = 8 }: { rows?: number }) => (
  <div className="flex flex-col gap-3">
    <Block className="h-10 w-full" />
    {Array.from({ length: rows }, (_, i) => (
      <Block key={i} className="h-12 w-full" />
    ))}
  </div>
);

/** A stack of form fields. */
export const FormSkeleton = ({ fields = 5 }: { fields?: number }) => (
  <div className="flex flex-col gap-6">
    {Array.from({ length: fields }, (_, i) => (
      <div key={i} className="flex flex-col gap-2 border-t border-gray-200 pt-6">
        <Block className="h-4 w-48" />
        <Block className="h-11 w-full max-w-md" />
      </div>
    ))}
  </div>
);

export default PageSkeleton;
