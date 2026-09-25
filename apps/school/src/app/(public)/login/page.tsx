"use client";
import { Suspense, useEffect, useState, type FormEvent } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { ApiError, api, useMutation } from "@/lib/api";
import { homeFor } from "@/lib/nav";
import { Button, ErrorNote, FormError, TextField } from "@/ui/kit";
import { BookCover } from "@/ui/cover";
import type { Me } from "@/ui/session";

function LoginForm() {
  const router = useRouter();
  const next = useSearchParams().get("next");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [school, setSchool] = useState<{ schoolName: string; motto: string | null } | null>(null);
  const [reveal, setReveal] = useState(false);

  // If the server itself is unhealthy (not configured, database down, migrations missing) say so up front, with its real reason,
  // instead of letting the person type a password into a form that cannot work.
  const [serverProblem, setServerProblem] = useState<ApiError | null>(null);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    setServerProblem(null);
    api.get<{ needsSetup: boolean }>("/setup/status").then((s) => { if (s.needsSetup) router.replace("/setup"); }).catch((e) => { if (e instanceof ApiError) setServerProblem(e); });
    api.get<{ school: { schoolName: string; motto: string | null } | null }>("/public/admissions").then((i) => setSchool(i.school)).catch(() => undefined); // decoration only
  }, [router, checks]);

  const login = useMutation(async () => {
    const r = await api.post<{ mustChangePassword: boolean; userType: string }>("/auth/login", { username, password });
    if (r.mustChangePassword) return router.replace("/change-password");
    const me = await api.get<Me>("/auth/me");
    router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : homeFor(me.user.userType, me.permissions));
  });
  const submit = (e: FormEvent) => { e.preventDefault(); void login.run(); };

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1.1fr_1fr]">
      <BookCover school={school?.schoolName ?? "SmartSchool"} motto={school?.motto ?? "Attendance, results, fees and exams — kept on your own network."} />
      <main className="flex items-center justify-center px-5 py-10">
        <form onSubmit={submit} className="w-full max-w-sm space-y-5" noValidate>
          <div><h1 className="font-serif text-3xl font-semibold">Sign in</h1><p className="mt-1 text-ink-500">Use the username your school gave you.</p></div>
          <TextField label="Username" value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" autoFocus required />
          <div className="space-y-1.5">
            <TextField label="Password" type={reveal ? "text" : "password"} value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
            <label className="flex cursor-pointer items-center gap-2 text-[0.9375rem] text-ink-700"><input type="checkbox" className="size-4 accent-brand-700" checked={reveal} onChange={(e) => setReveal(e.target.checked)} />Show password</label>
          </div>
          <ErrorNote error={serverProblem} onRetry={() => setChecks((n) => n + 1)} />
          <FormError error={login.error} />
          <Button type="submit" loading={login.pending} className="w-full" disabled={!username || !password}>Sign in</Button>
          <p className="text-center text-[0.9375rem] text-ink-500">Applying for a place? <Link href="/apply" className="font-bold text-brand-700 underline">Start an application</Link></p>
        </form>
      </main>
    </div>
  );
}

export default function LoginPage() {
  return <Suspense><LoginForm /></Suspense>;
}
