import { hash, verify } from "@node-rs/argon2";
import { validation } from "./errors";

// OWASP-recommended Argon2id parameters (19 MiB, t=2, p=1).
const OPTS = { memoryCost: 19456, timeCost: 2, parallelism: 1 } as const;

export const hashPassword = (plain: string) => hash(plain, OPTS);

export async function verifyPassword(stored: string, plain: string): Promise<boolean> {
  try {
    return await verify(stored, plain);
  } catch {
    return false;
  }
}

/** Policy for accounts created by staff or imports. Length matters more than symbols. */
export function assertPasswordPolicy(plain: string) {
  if (plain.length < 8) throw validation("Password must be at least 8 characters long");
  if (plain.length > 128) throw validation("Password is too long");
  if (!/[A-Za-z]/.test(plain) || !/[0-9]/.test(plain)) throw validation("Password must contain letters and numbers");
  if (/^(password|12345678|qwerty12)/i.test(plain)) throw validation("That password is too easy to guess");
}
