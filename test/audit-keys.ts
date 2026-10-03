import { readFileSync, writeFileSync } from "node:fs";
import { lookupKeys } from "./support/pack.js";
const [input, output] = process.argv.slice(2);
writeFileSync(output!, JSON.stringify([...lookupKeys(JSON.parse(readFileSync(input!, "utf8")))]));
