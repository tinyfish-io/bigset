"use client";

import { useEffect } from "react";
import { SignUp } from "@clerk/nextjs";
import { EVENTS, track } from "@/lib/analytics";

export default function SignUpPage() {
  useEffect(() => {
    track(EVENTS.SIGN_UP_VIEWED);
  }, []);

  return (
    <div className="flex flex-1 items-center justify-center px-4">
      <SignUp forceRedirectUrl="/dashboard" />
    </div>
  );
}
