"use client";
import { useEffect, useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, useMutation } from "@/lib/api";
import { Button, ErrorNote, FormError, TextField } from "@/ui/kit";
import { BookCover } from "@/ui/cover";

export default function Setup() {
  const router = useRouter();
  const [f, setF] = useState({ schoolName: "", city: "", state: "", phone: "", firstName: "", lastName: "", username: "", password: "" });
  const [done, setDone] = useState<string | null>(null);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement>) => setF((s) => ({ ...s, [k]: e.target.value }));
  // A server that can't answer at all (not configured, database down, not migrated) must be reported here, before someone fills in the whole form.
  const [serverProblem, setServerProblem] = useState<ApiError | null>(null);
  const [checks, setChecks] = useState(0);
  useEffect(() => {
    setServerProblem(null);
    api.get<{ needsSetup: boolean }>("/setup/status").then((s) => { if (!s.needsSetup) router.replace("/login"); }).catch((e) => { if (e instanceof ApiError) setServerProblem(e); });
  }, [router, checks]);

  const install = useMutation(async () => {
    const r = await api.post<{ installationCode: string }>("/setup", { schoolName: f.schoolName, city: f.city || undefined, state: f.state || undefined, phone: f.phone || undefined, admin: { username: f.username, password: f.password, firstName: f.firstName, lastName: f.lastName } });
    setDone(r.installationCode);
  });
  const submit = (e: FormEvent) => { e.preventDefault(); void install.run(); };
  const fe = install.error?.fieldErrors() ?? {};

  if (done) return (
    <main className="mx-auto max-w-lg px-5 py-16">
      <h1 className="font-serif text-3xl font-semibold">{f.schoolName} is ready</h1>
      <p className="mt-3 text-ink-700">Your installation code is <strong className="num rounded bg-brand-100 px-2 py-0.5">{done}</strong>. Keep it — support will ask for it.</p>
      <p className="mt-3 text-ink-700">Next: sign in, then set up your academic year, classes and subjects. Everything works without internet; register with the cloud later from <em>Cloud &amp; licence</em> when you're ready.</p>
      <Button className="mt-6" onClick={() => router.replace("/login")}>Go to sign in</Button>
    </main>
  );

  return (
    <div className="grid min-h-dvh lg:grid-cols-[1fr_1.2fr]">
      <BookCover school="SmartSchool" motto="Set up this school's own server. It takes about two minutes." />
      <main className="flex items-center justify-center px-5 py-10">
        <form onSubmit={submit} className="w-full max-w-lg space-y-5">
          <div><h1 className="font-serif text-3xl font-semibold">Set up your school</h1><p className="mt-1 text-ink-500">You'll become the primary admin — the one account that can never be deleted by accident.</p></div>
          <fieldset className="space-y-4"><legend className="mb-1 font-serif text-lg font-semibold">The school</legend>
            <TextField label="School name" value={f.schoolName} onChange={set("schoolName")} error={fe.schoolName} required />
            <div className="grid gap-4 sm:grid-cols-2"><TextField label="City or town" value={f.city} onChange={set("city")} /><TextField label="State" value={f.state} onChange={set("state")} /></div>
            <TextField label="School phone" type="tel" value={f.phone} onChange={set("phone")} />
          </fieldset>
          <fieldset className="space-y-4"><legend className="mb-1 font-serif text-lg font-semibold">Your admin account</legend>
            <div className="grid gap-4 sm:grid-cols-2"><TextField label="First name" value={f.firstName} onChange={set("firstName")} error={fe["admin.firstName"]} required /><TextField label="Last name" value={f.lastName} onChange={set("lastName")} error={fe["admin.lastName"]} required /></div>
            <TextField label="Username" value={f.username} onChange={set("username")} error={fe["admin.username"]} autoCapitalize="none" hint="Letters, numbers, dot, dash or underscore" required />
            <TextField label="Password" type="password" value={f.password} onChange={set("password")} error={fe["admin.password"]} autoComplete="new-password" hint="At least 8 characters with letters and numbers" required />
          </fieldset>
          <ErrorNote error={serverProblem} onRetry={() => setChecks((n) => n + 1)} />
          <FormError error={install.error && Object.keys(fe).length === 0 ? install.error : null} />
          <Button type="submit" loading={install.pending} className="w-full">Create school</Button>
        </form>
      </main>
    </div>
  );
}
