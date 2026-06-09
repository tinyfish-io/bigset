"use client";

import { useEffect } from "react";
import { redirect } from "next/navigation";
import { SignIn } from "@clerk/nextjs";
import { EVENTS, track } from "@/lib/analytics";
import { isLocalMode } from "@/lib/app-mode";

export default function SignInPage() {
  useEffect(() => {
    track(EVENTS.SIGN_IN_VIEWED);
  }, []);

  if (isLocalMode) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <SignIn forceRedirectUrl="/dashboard" />
    </div>
  );
}
