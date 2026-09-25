"use client";
import { useState, type FormEvent } from "react";
import { useRouter } from "next/navigation";
import { api, useMutation } from "@/lib/api";
import { Button, FormError, TextField, useToast } from "@/ui/kit";

export default function ChangePassword() {
  const router = useRouter();
  const toast = useToast();
  const [cur, setCur] = useState("");
  const [next, setNext] = useState("");
  const [again, setAgain] = useState("");
  const mismatch = again !== "" && again !== next;
  const change = useMutation(async () => {
    await api.post("/auth/change-password", { currentPassword: cur, newPassword: next });
    toast.push("ok", "Password changed. Please sign in with the new one.");
    router.replace("/login");
  });
  const submit = (e: FormEvent) => { e.preventDefault(); if (!mismatch) void change.run(); };
  return (
    <main className="mx-auto flex min-h-dvh max-w-sm items-center px-5">
      <form onSubmit={submit} className="w-full space-y-5">
        <div><h1 className="font-serif text-3xl font-semibold">Choose a new password</h1><p className="mt-1 text-ink-500">Use at least 8 characters, with letters and numbers. You'll sign in again afterwards.</p></div>
        <TextField label="Current password" type="password" value={cur} onChange={(e) => setCur(e.target.value)} autoComplete="current-password" required />
        <TextField label="New password" type="password" value={next} onChange={(e) => setNext(e.target.value)} autoComplete="new-password" required />
        <TextField label="Repeat new password" type="password" value={again} onChange={(e) => setAgain(e.target.value)} autoComplete="new-password" error={mismatch ? "The two passwords are different" : undefined} required />
        <FormError error={change.error} />
        <Button type="submit" loading={change.pending} className="w-full" disabled={!cur || next.length < 8 || mismatch || !again}>Change password</Button>
      </form>
    </main>
  );
}
