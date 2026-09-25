"use client";
import { Suspense, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { call } from "@/lib/api";
import { Button, Field, Notice, TextInput } from "@/ui/kit";

function Form() {
  const router = useRouter(); const sp = useSearchParams();
  const [email, setEmail] = useState(""); const [password, setPassword] = useState("");
  const [err, setErr] = useState<string | null>(null); const [ref, setRef] = useState<string | null>(null); const [busy, setBusy] = useState(false);
  const next = sp.get("next");
  const go = async (e: React.FormEvent) => {
    e.preventDefault(); setBusy(true); setErr(null);
    try { await call("login", "POST", { email, password }); router.replace(next && next.startsWith("/") && !next.startsWith("//") ? next : "/fleet"); }
    catch (x) { setErr((x as Error).message); setRef((x as { requestId?: string }).requestId?.slice(0, 8) ?? null); setBusy(false); }
  };
  return (
    <main className="login">
      <form onSubmit={go}>
        <h1>Control Tower</h1>
        <p className="muted" style={{ marginTop: 0 }}>SmartSchool installations, licences and health. Operators only.</p>
        {err && <Notice tone="bad">{err}{ref && <span className="muted" style={{ display: "block", fontWeight: 400 }}>Reference: <span className="num">{ref}</span></span>}</Notice>}
        <Field label="Email"><TextInput type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} /></Field>
        <Field label="Password"><TextInput type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} /></Field>
        <Button type="submit" loading={busy} style={{ width: "100%" }}>Sign in</Button>
      </form>
    </main>
  );
}
export default function Login() { return <Suspense><Form /></Suspense>; }
