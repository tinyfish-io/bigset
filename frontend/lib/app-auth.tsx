"use client";

import {
  ClerkProvider,
  useAuth as useClerkAuth,
  useClerk as useRealClerk,
  useUser as useRealUser,
} from "@clerk/nextjs";
import { useConvexAuth as useRealConvexAuth } from "convex/react";
import type { ReactNode } from "react";
import { isLocalMode, LOCAL_USER_ID } from "./app-mode";

const localUser = {
  id: LOCAL_USER_ID,
  fullName: "BigSet local",
  firstName: "BigSet",
  primaryEmailAddress: null,
  imageUrl: null,
};

function useLocalAuth() {
  return {
    isLoaded: true,
    isSignedIn: true,
    userId: LOCAL_USER_ID,
    getToken: async () => "bigset-local",
  };
}

function useLocalUser() {
  return {
    isLoaded: true,
    isSignedIn: true,
    user: localUser,
  };
}

function useLocalClerk() {
  return {
    signOut: async () => {},
  };
}

function useLocalConvexAuth() {
  return {
    isLoading: false,
    isAuthenticated: true,
  };
}

export const useAppAuth = isLocalMode ? useLocalAuth : useClerkAuth;
export const useAppUser = isLocalMode ? useLocalUser : useRealUser;
export const useAppClerk = isLocalMode ? useLocalClerk : useRealClerk;
export const useAppConvexAuth = isLocalMode
  ? useLocalConvexAuth
  : useRealConvexAuth;

export function AppAuthProvider({ children }: { children: ReactNode }) {
  if (isLocalMode) return <>{children}</>;

  return (
    <ClerkProvider
      signInForceRedirectUrl="/dashboard"
      signUpForceRedirectUrl="/dashboard"
    >
      {children}
    </ClerkProvider>
  );
}
