import Link from "next/link";

export default function Home() {
  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <div className="w-full max-w-md space-y-8 text-center">
        <div>
          <h1 className="text-4xl font-semibold tracking-tight">BigSet</h1>
          <p className="mt-3 text-lg text-foreground/60">
            Live, queryable datasets — updated automatically.
          </p>
        </div>

        <div className="flex flex-col gap-3 sm:flex-row sm:justify-center">
          <Link
            href="/auth/sign-up"
            className="rounded-lg bg-foreground px-6 py-2.5 text-sm font-medium text-background transition-opacity hover:opacity-90"
          >
            Get started
          </Link>
          <Link
            href="/auth/sign-in"
            className="rounded-lg border border-foreground/20 px-6 py-2.5 text-sm font-medium transition-colors hover:bg-foreground/5"
          >
            Sign in
          </Link>
        </div>
      </div>
    </div>
  );
}
