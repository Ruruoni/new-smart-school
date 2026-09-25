import { generateKeyPairSync, randomBytes } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const b64 = (k: typeof publicKey | typeof privateKey, type: "spki" | "pkcs8") => Buffer.from(k.export({ type, format: "pem" }) as string).toString("base64");
console.log("# Add to the CLOUD app's environment:");
console.log(`CLOUD_ENCRYPTION_KEY=${randomBytes(32).toString("base64")}`);
console.log(`CLOUD_SIGNING_PRIVATE_KEY=${b64(privateKey, "pkcs8")}`);
console.log(`CLOUD_SIGNING_PUBLIC_KEY=${b64(publicKey, "spki")}`);
console.log("\n# Give every SCHOOL installation this value (public — safe to distribute):");
console.log(`CLOUD_PUBLIC_KEY=${b64(publicKey, "spki")}`);
