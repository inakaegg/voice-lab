import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

function syntheticCase(phraseCount, wordsPerPhrase) {
  const targets = [];
  const words = [];
  let timestamp = 0;
  for (let phraseIndex = 0; phraseIndex < phraseCount; phraseIndex += 1) {
    const pieces = [`word${phraseIndex}`, ...Array.from({ length: wordsPerPhrase - 1 }, (_, index) => `part${index + 1}`)];
    targets.push(`${pieces.join(" ")}.`);
    for (const text of pieces) {
      words.push({ text, start: timestamp, end: timestamp + 0.08 });
      timestamp += 0.1;
    }
  }
  return {
    targetText: targets.join(" "),
    recognizedText: words.map((word) => word.text).join(" "),
    targetLanguage: "en-US",
    asrTimestamps: { available: true, words },
  };
}

function measure(module, name, phraseCount, wordsPerPhrase, iterations) {
  const canonical = typeof module.practiceComparisonAlignmentCanonical === "function";
  const align = canonical ? module.practiceComparisonAlignmentCanonical : module.practiceComparisonAlignment;
  const input = syntheticCase(phraseCount, wordsPerPhrase);
  const samples = [];
  let result;
  align(input);
  global.gc?.();
  const heapBefore = process.memoryUsage().heapUsed;
  for (let iteration = 0; iteration < iterations; iteration += 1) {
    const started = performance.now();
    result = align(input);
    samples.push(performance.now() - started);
  }
  global.gc?.();
  const heapAfter = process.memoryUsage().heapUsed;
  samples.sort((left, right) => left - right);
  const p95Index = Math.max(0, Math.min(samples.length - 1, Math.ceil(samples.length * 0.95) - 1));
  return {
    name,
    phrase_count: phraseCount,
    timestamp_unit_count: phraseCount * wordsPerPhrase,
    iterations,
    median_elapsed_ms: Number(samples[Math.floor(samples.length / 2)].toFixed(3)),
    p95_elapsed_ms: Number(samples[p95Index].toFixed(3)),
    heap_delta_bytes: Math.max(0, heapAfter - heapBefore),
    candidate_count: Number(result?.diagnostics?.candidate_count || 0),
    score_computation_count: Number(result?.diagnostics?.score_computation_count || 0),
    canonical_contract: canonical,
  };
}

const args = process.argv.slice(2);
const quick = args.includes("--quick");
const moduleIndex = args.indexOf("--module");
const modulePath = moduleIndex >= 0 ? args[moduleIndex + 1] : "cloudflare/worker.mjs";
if (moduleIndex >= 0 && !modulePath) throw new Error("--module requires a path");
const module = await import(pathToFileURL(resolve(modulePath)).href);
const normalIterations = quick ? 5 : 20;
const maxIterations = quick ? 2 : 5;
const results = [
  measure(module, "representative_4x16", 4, 4, normalIterations),
  measure(module, "maximum_complexity_16x64", 16, 4, maxIterations),
  measure(module, "maximum_timestamp_1x256", 1, 256, maxIterations),
];
process.stdout.write(`${JSON.stringify({ runtime: "cloudflare-worker", results })}\n`);
