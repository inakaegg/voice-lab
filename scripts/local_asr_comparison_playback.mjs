import fs from "node:fs";

await import("../src/mo_speech/web/practice_playback.js");

const input = fs.readFileSync(0, "utf8");
const options = JSON.parse(input);
const plan = globalThis.voiceLabPracticePlayback.comparisonPlaybackPlan(options);
process.stdout.write(JSON.stringify(plan));
