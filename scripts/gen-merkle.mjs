#!/usr/bin/env node
/**
 * Generates:
 *  - claims/<chainId>/<address>.json  (epochId, amount, generatedLoss, proof[])
 *  - epochs/<chainId>/<epochId>.json  (merkleRoot, totals, counts)
 *  - epochs/<chainId>/latest.json     (points to latest epoch + merkleRoot)
 *
 * Leaf hashing MUST match Solidity:
 *   leaf = keccak256(abi.encodePacked(address, uint256 amount, uint256 generatedLoss))
 */

import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { keccak256, encodePacked, isAddress } from "viem";

function mustEnv(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env var ${name}`);
  return v;
}

const CHAIN_ID = Number(mustEnv("CHAIN_ID"));
const EPOCH_ID = Number(mustEnv("EPOCH_ID"));
const ROOT = process.cwd();

// Accept either "inputs" or "input"
const inputsDir =
  fs.existsSync(path.join(ROOT, "inputs")) ? "inputs" :
  fs.existsSync(path.join(ROOT, "input"))  ? "input"  :
  null;

if (!inputsDir) {
  throw new Error(`Missing inputs folder. Create "inputs/" (recommended) or "input/".`);
}

const inputCsv = path.join(ROOT, inputsDir, String(CHAIN_ID), `epoch-${EPOCH_ID}.csv`);

if (!fs.existsSync(inputCsv)) {
  throw new Error(
    `Input not found: ${inputCsv}\n` +
    `Fix: create ${inputsDir}/${CHAIN_ID}/epoch-${EPOCH_ID}.csv`
  );
}

function readCsv(file) {
  const raw = fs.readFileSync(file, "utf8").trim();
  const lines = raw.split(/\r?\n/).filter(Boolean);
  if (lines.length < 2) throw new Error("CSV must have header + at least 1 row");

  const header = lines[0].split(",").map((s) => s.trim().toLowerCase());
  const idxAddr = header.indexOf("address");
  const idxAmt = header.indexOf("amount");
  const idxLoss = header.indexOf("generatedloss");

  if (idxAddr < 0 || idxAmt < 0 || idxLoss < 0) {
    throw new Error(`CSV header must include: address,amount,generatedLoss`);
  }

  const rows = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = lines[i].split(",").map((s) => s.trim());
    const address = (cols[idxAddr] || "").toLowerCase();
    const amount = cols[idxAmt] || "0";
    const generatedLoss = cols[idxLoss] || "0";

    if (!isAddress(address)) throw new Error(`Bad address on line ${i + 1}: ${address}`);
    if (!/^\d+$/.test(amount)) throw new Error(`Bad amount on line ${i + 1}: ${amount}`);
    if (!/^\d+$/.test(generatedLoss)) throw new Error(`Bad generatedLoss on line ${i + 1}: ${generatedLoss}`);

    rows.push({ address, amount, generatedLoss });
  }
  return rows;
}

// ----- Merkle helpers (sorted pairs) -----

function leafPacked(address, amount, generatedLoss) {
  return keccak256(
    encodePacked(
      ["address", "uint256", "uint256"],
      [address, BigInt(amount), BigInt(generatedLoss)]
    )
  );
}

function hashPair(a, b) {
  // sorted pair
  return keccak256(
    encodePacked(["bytes32", "bytes32"], a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a])
  );
}

function buildTree(leaves) {
  if (leaves.length === 0) throw new Error("No leaves");

  let level = leaves.slice();
  const layers = [level];

  while (level.length > 1) {
    const next = [];
    for (let i = 0; i < level.length; i += 2) {
      const left = level[i];
      const right = i + 1 < level.length ? level[i + 1] : level[i]; // duplicate last
      next.push(hashPair(left, right));
    }
    level = next;
    layers.push(level);
  }

  return { root: layers[layers.length - 1][0], layers };
}

function getProof(leaf, layers) {
  let idx = layers[0].indexOf(leaf);
  if (idx === -1) throw new Error("Leaf not found in layer 0");

  const proof = [];
  for (let level = 0; level < layers.length - 1; level++) {
    const layer = layers[level];
    const isRightNode = idx % 2 === 1;
    const pairIndex = isRightNode ? idx - 1 : idx + 1;
    const sibling = pairIndex < layer.length ? layer[pairIndex] : layer[idx]; // duplicate
    proof.push(sibling);
    idx = Math.floor(idx / 2);
  }
  return proof;
}

function ensureDir(p) {
  fs.mkdirSync(p, { recursive: true });
}

function writeJson(file, obj) {
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + "\n", "utf8");
}

const rows = readCsv(inputCsv);

// determinism: sort by address
rows.sort((a, b) => a.address.localeCompare(b.address));

const leaves = rows.map((r) => leafPacked(r.address, r.amount, r.generatedLoss));
const { root, layers } = buildTree(leaves);

// outputs
const claimsDir = path.join(ROOT, "claims", String(CHAIN_ID));
const epochsDir = path.join(ROOT, "epochs", String(CHAIN_ID));
ensureDir(claimsDir);
ensureDir(epochsDir);

let totalAmount = 0n;
let totalLoss = 0n;

for (let i = 0; i < rows.length; i++) {
  const r = rows[i];
  const proof = getProof(leaves[i], layers);

  totalAmount += BigInt(r.amount);
  totalLoss += BigInt(r.generatedLoss);

  const out = {
    epochId: EPOCH_ID,
    amount: r.amount,
    generatedLoss: r.generatedLoss,
    proof,
  };

  // IMPORTANT: filename is lowercase address
  const outFile = path.join(claimsDir, `${r.address}.json`);
  writeJson(outFile, out);
}

const epochMeta = {
  chainId: CHAIN_ID,
  epochId: EPOCH_ID,
  merkleRoot: root,
  count: rows.length,
  totalAmount: totalAmount.toString(),
  totalGeneratedLoss: totalLoss.toString(),
  input: `${inputsDir}/${CHAIN_ID}/epoch-${EPOCH_ID}.csv`,
  generatedAt: new Date().toISOString(),
};

writeJson(path.join(epochsDir, `${EPOCH_ID}.json`), epochMeta);
writeJson(path.join(epochsDir, `latest.json`), { ...epochMeta });

console.log(`✅ Generated ${rows.length} bundles`);
console.log(`   chain: ${CHAIN_ID} epoch: ${EPOCH_ID}`);
console.log(`   root: ${root}`);
console.log(`   claims: claims/${CHAIN_ID}/*.json`);
console.log(`   epoch meta: epochs/${CHAIN_ID}/${EPOCH_ID}.json`);
