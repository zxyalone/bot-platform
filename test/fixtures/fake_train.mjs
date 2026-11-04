#!/usr/bin/env node
// Stands in for a training script: follows the platform's conventions without any real training.
// Usage: fake_train.mjs [--fail] [--sleep seconds] [--no-metrics] [--final]
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { deflateSync } from "node:zlib";

const args = process.argv.slice(2);
const flag = (f) => args.includes(f);
const sleep = flag("--sleep") ? Number(args[args.indexOf("--sleep") + 1]) : 0;
const seed = Number(process.env.BOT_SEED || 0);
const config = process.env.BOT_CONFIG_FILE ? JSON.parse(readFileSync(process.env.BOT_CONFIG_FILE, "utf8").trim() || "{}") : {};
console.log(`training with seed=${seed} config=${JSON.stringify(config)}`);
if (sleep) await new Promise((r) => setTimeout(r, sleep * 1000));
if (flag("--fail")) {
  console.error("CUDA out of memory");
  process.exit(3);
}

function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function png(size, paint) {
  const raw = Buffer.alloc((size * 3 + 1) * size);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) Buffer.from(paint(x, y)).copy(raw, y * (size * 3 + 1) + 1 + x * 3);
  const chunk = (type, data) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8;
  ihdr[9] = 2;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

const shift = Number(config.shift ?? 0.02);
const dice = Number((0.7 + shift + seed * 0.003).toFixed(4));
if (flag("--final")) {
  writeFileSync(process.env.BOT_METRICS_FILE, JSON.stringify({ test_dice: dice - 0.01, saw_test_dir: Boolean(process.env.BOT_TEST_DIR) }));
  process.exit(0);
}
const art = process.env.BOT_ARTIFACTS_DIR;
if (art) {
  mkdirSync(join(art, "cases"), { recursive: true });
  const cases = [];
  for (let i = 0; i < 4; i++) {
    const r = 12 + i * 3;
    const off = 4 - i;
    const circle = (cx, cy, rad, x, y) => (x - cx) ** 2 + (y - cy) ** 2 < rad ** 2;
    writeFileSync(join(art, "cases", `${i}_img.png`), png(48, (x, y) => [40 + ((x * 3 + y * 2) % 60), 40 + ((x + y * 3) % 60), 60 + y]));
    writeFileSync(join(art, "cases", `${i}_gt.png`), png(48, (x, y) => (circle(24, 24, r, x, y) ? [60, 200, 120] : [0, 0, 0])));
    writeFileSync(join(art, "cases", `${i}_pred.png`), png(48, (x, y) => (circle(24 + off, 24, r, x, y) ? [230, 80, 80] : [0, 0, 0])));
    cases.push({ id: `case-${i}`, image: `cases/${i}_img.png`, label: `cases/${i}_gt.png`, pred: `cases/${i}_pred.png`, metrics: { dice: Number((0.55 + i * 0.1 + shift).toFixed(3)) } });
  }
  writeFileSync(join(art, "manifest.json"), JSON.stringify({ cases }));
}
if (!flag("--no-metrics")) writeFileSync(process.env.BOT_METRICS_FILE, JSON.stringify({ dice, iou: Number((dice / (2 - dice)).toFixed(4)), note: "ignored" }));
console.log("done");
