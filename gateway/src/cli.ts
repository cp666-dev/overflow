// Admin CLI: bun run cli <command>
//
//   keys create --name <name>       create an API key (prints it once)
//   keys list                       list keys and balances
//   credit add --id <keyId> --usd <amount>
//   usage [--id <keyId>]            recent usage events

import { addCredit, createApiKey, openDb } from "./db";

function arg(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const db = openDb();
const [, , cmd, sub] = process.argv;

if (cmd === "keys" && sub === "create") {
  const name = arg("--name") ?? "unnamed";
  const { key, id } = createApiKey(db, name);
  console.log(`created key id=${id} name=${name}`);
  console.log(`API key (shown once, store it now): ${key}`);
} else if (cmd === "keys" && sub === "list") {
  const rows = db
    .query("SELECT id, name, balance_nano, created_at FROM api_keys ORDER BY id")
    .all() as any[];
  for (const r of rows) {
    console.log(
      `#${r.id}  ${r.name.padEnd(20)}  $${(r.balance_nano / 1e9).toFixed(4)}  (${r.created_at})`,
    );
  }
  if (!rows.length) console.log("no keys yet. run: bun run cli keys create --name you");
} else if (cmd === "credit" && sub === "add") {
  const id = Number(arg("--id"));
  const usd = Number(arg("--usd"));
  if (!id || !usd) throw new Error("usage: credit add --id <keyId> --usd <amount>");
  addCredit(db, id, Math.round(usd * 1e9));
  console.log(`added $${usd.toFixed(2)} to key #${id}`);
} else if (cmd === "usage") {
  const id = arg("--id");
  const rows = (
    id
      ? db.query("SELECT * FROM usage_events WHERE key_id = ? ORDER BY id DESC LIMIT 30").all(id)
      : db.query("SELECT * FROM usage_events ORDER BY id DESC LIMIT 30").all()
  ) as any[];
  for (const r of rows) {
    console.log(
      `${r.ts}  key#${r.key_id}  ${r.requested_model} → ${r.served_model}@${r.upstream}  ` +
        `${r.in_tokens}in/${r.out_tokens}out  $${(r.cost_nano / 1e9).toFixed(6)}`,
    );
  }
  if (!rows.length) console.log("no usage yet");
} else {
  console.log("commands: keys create --name X | keys list | credit add --id N --usd X | usage");
}
