"use client";

import { useEffect } from "react";
import { SignIn } from "@clerk/nextjs";
import { EVENTS, track } from "@/lib/analytics";

export default function SignInPage() {
  useEffect(() => {
    track(EVENTS.SIGN_IN_VIEWED);
  }, []);

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <SignIn forceRedirectUrl="/dashboard" />
    </div>
  );
}
