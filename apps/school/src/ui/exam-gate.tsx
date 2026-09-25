"use client";
import { useEffect, type ReactNode } from "react";
import { usePathname, useRouter } from "next/navigation";

/**
 * The exam room's stand-in for SessionProvider. It must NOT wait for the server: a student who refreshes
 * during a Wi-Fi drop has to get their exam back from the device. It only reacts to the server saying the
 * sign-in is no longer valid; answers stay in IndexedDB and the student resumes at the same URL after signing in.
 */
export function ExamGate({ children }: { children: ReactNode }) {
  const router = useRouter();
  const path = usePathname();
  useEffect(() => {
    const goLogin = () => router.replace(`/login?next=${encodeURIComponent(path)}`);
    const goPw = () => router.replace("/change-password");
    window.addEventListener("ss:unauthenticated", goLogin);
    window.addEventListener("ss:password-change", goPw);
    return () => { window.removeEventListener("ss:unauthenticated", goLogin); window.removeEventListener("ss:password-change", goPw); };
  }, [router, path]);
  return <>{children}</>;
}
