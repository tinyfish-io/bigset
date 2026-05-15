"use client";

import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { authClient } from "@/lib/auth-client";

export default function DashboardPage() {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();

  useEffect(() => {
    if (!isPending && !session) {
      router.push("/auth/sign-in");
    }
  }, [isPending, session, router]);

  if (isPending) {
    return (
      <div className="flex flex-1 items-center justify-center">
        <p className="text-foreground/60">Loading...</p>
      </div>
    );
  }

  if (!session) {
    return null;
  }

  async function handleSignOut() {
    try {
      await authClient.signOut();
      router.push("/auth/sign-in");
    } catch {
      router.push("/auth/sign-in");
    }
  }

  return (
    <div className="flex flex-1 flex-col items-center justify-center px-4">
      <div className="w-full max-w-lg space-y-8 text-center">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">Dashboard</h1>
          <p className="mt-2 text-foreground/60">
            Welcome, {session.user.name}
          </p>
        </div>

        <div className="rounded-lg border border-foreground/10 p-6 text-left space-y-3">
          <div className="flex justify-between">
            <span className="text-sm text-foreground/60">Name</span>
            <span className="text-sm font-medium">{session.user.name}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-foreground/60">Email</span>
            <span className="text-sm font-medium">{session.user.email}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-sm text-foreground/60">User ID</span>
            <span className="text-sm font-mono text-foreground/60">
              {session.user.id}
            </span>
          </div>
        </div>

        <button
          onClick={handleSignOut}
          className="rounded-lg border border-foreground/20 px-4 py-2 text-sm font-medium transition-colors hover:bg-foreground/5"
        >
          Sign out
        </button>
      </div>
    </div>
  );
}
