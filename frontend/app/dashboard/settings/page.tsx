"use client";

import { SettingsSidebar } from "@/components/settings/SettingsSidebar";
import { useRouter } from "next/navigation";
import { useEffect } from "react";

export default function SettingsPage() {
  const router = useRouter();

  useEffect(() => {
    router.replace("/dashboard/settings/models");
  }, [router]);

  return null;
}