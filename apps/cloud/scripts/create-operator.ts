import "dotenv/config";
import { createOperator } from "../src/server/operators";

const [email, name, password, role = "SUPER_ADMIN"] = process.argv.slice(2);
if (!email || !name || !password) {
  console.error("usage: pnpm operator:create <email> <name> <password> [SUPER_ADMIN|SUPPORT|VIEWER]");
  process.exit(1);
}
createOperator({ email, name, password, role: role as never }).then((o) => { console.log(`created operator ${o.email} (${o.role})`); process.exit(0); }).catch((e) => {
  // A configuration problem: at a terminal the NAMES of what is missing are exactly what is needed (never the values).
  if (Array.isArray(e?.issues)) { console.error("The Control Tower is not configured correctly:"); for (const i of e.issues) console.error(`  - ${i}`); console.error("Set these in the environment (see docs/deployment.md) and try again."); }
  else console.error(e.message);
  process.exit(1);
});
