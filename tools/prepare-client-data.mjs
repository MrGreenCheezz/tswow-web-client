import { ensureClientDataStubs } from "./client-data.mjs";

const created = ensureClientDataStubs();
if (created.length > 0) {
  console.log(`Created neutral client-data implementation(s): ${created.join(", ")}`);
  console.log("These files are ignored by Git. Run `npm run client-data:generate` with your own dataset for gameplay.");
} else {
  console.log("Client-data implementations are already present; nothing was replaced.");
}
