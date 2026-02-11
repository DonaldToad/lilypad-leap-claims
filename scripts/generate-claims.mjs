import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { StandardMerkleTree } from "@openzeppelin/merkle-tree";

/**
 * Usage (locally or in GitHub Actions):
 *   CHAIN_ID=59144 EPOCH_ID=12 node scripts/generate-claims.mjs
 *
 * Expects input CSV at:
 *   input/<chainId>/<epochId>.csv
 *
 * CSV columns (header required):
 *   address,amount,generatedLoss
 *
 * amount & generatedLoss MUST be uint256 base-units as decimal strings (wei).
 */

const chainId = Number(process.env.CHAIN_ID || "59144");
const epochId = Number(process.env.EPOCH_ID || "1");

if (!Number.isFinite(chainId) || !Number.isFinite(epochId) || epochId <= 0) {
  throw new Error("Set env: CHAIN_ID and EPOCH_ID (EPOCH_ID > 0)");
}

const repoRoot = process.cwd();
const inputCsv = path.join(repoRoot, "input", String(chainId), `${epochId}.csv`);
const outClaimsDir = path.join(repoRoot, "claims", String(chainId));
const outEpochDir = path.join(repoRoot, "epochs", String(chainId));

if (!fs.existsSync(inputCsv)) {
  throw new Error(`Missing input CSV: ${inputCsv}`);
}

const csvText = fs.readFileSync(inputCsv, "utf8");
const rows = parse(csvText, { columns: true, skip_empty_lines: true, trim: true });

function normAddr(a) {
  if (typeof a !== "string") return "";
  const x = a.toLowerCase();
  if (!x.startsWith("0x") || x.length !== 42) return "";
  return x;
}

function asUintStr(x, name) {
  if (typeof x !== "string") throw new Error(`${name} must be string`);
  if (!/^[0-9]+$/.test(x)) throw new Error(`${name} must be uint256 decimal string. Got: ${x}`);
  // quick sanity: no leading +, no decimals
  return x;
}

// 1) Collect entries
const entries = [];
for (const r of rows) {
  const address = normAddr(r.address);
  if (!address) throw new Error(`Bad address: ${r.address}`);

  const amount = asUintStr(String(r.amount), "amount");
  const generatedLoss = asUintStr(String(r.generatedLoss), "generatedLoss");

  entries.push([address, amount, generatedLoss]);
}

if (entries.length === 0) throw new Error("No rows in CSV.");

console.log(`Entries: ${entries.length} for chainId=${chainId} epochId=${epochId}`);

// 2) Build Merkle tree (leaf = keccak256(abi.encode(address,uint256,uint256)))
const tree = StandardMerkleTree.of(entries, ["address", "uint256", "uint256"]);
const root = tree.root;

console.log("Merkle root:", root);

// 3) Write epoch meta
fs.mkdirSync(outEpochDir, { recursive: true });
const epochMeta = { chainId, epochId, merkleRoot: root, entries: entries.length };
fs.writeFileSync(path.join(outEpochDir, `${epochId}.json`), JSON.stringify(epochMeta, null, 2));
fs.writeFileSync(path.join(outEpochDir, `latest.json`), JSON.stringify(epochMeta, null, 2));

// 4) Write per-user claim bundles
fs.mkdirSync(outClaimsDir, { recursive: true });

for (const [addr, amount, generatedLoss] of entries) {
  // Find proof for this exact leaf
  let proof = null;

  for (const [i, v] of tree.entries()) {
    const [a, am, gl] = v;
    if (a.toLowerCase() === addr && String(am) === String(amount) && String(gl) === String(generatedLoss)) {
      proof = tree.getProof(i);
      break;
    }
  }

  if (!proof) throw new Error(`Proof not found for ${addr}`);

  const bundle = {
    epochId,
    amount,
    generatedLoss,
    proof
  };

  fs.writeFileSync(path.join(outClaimsDir, `${addr}.json`), JSON.stringify(bundle, null, 2));
}

console.log(`Wrote bundles to: claims/${chainId}/<address>.json`);
console.log(`Wrote epoch meta to: epochs/${chainId}/${epochId}.json and latest.json`);
