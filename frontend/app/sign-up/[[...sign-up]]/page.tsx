"use client";

import { useEffect } from "react";
import { redirect } from "next/navigation";
import { SignUp } from "@clerk/nextjs";
import { EVENTS, track } from "@/lib/analytics";
import { isLocalMode } from "@/lib/app-mode";

export default function SignUpPage() {
  useEffect(() => {
    track(EVENTS.SIGN_UP_VIEWED);
  }, []);

  if (isLocalMode) {
    redirect("/dashboard");
  }

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <SignUp forceRedirectUrl="/dashboard" />
    </div>
  );
}
