// 対応表のSQLを実D1（miniflareのSQLite）へ流し、migration 0005 と食い違っていないことを確かめる。
// fake D1 は本体と同じ思い込みを共有し得るので、DDLとの整合はここでしか検出できない。
// 起動コストがあるので、この経路のテストはこの1本に限る。
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { getPlatformProxy } from "wrangler";

import { CREDIT_RESERVATION_SQL } from "../cloudflare/worker.mjs";

test("credit reservation statements run against the schema migration 0005 creates", async () => {
  const proxy = await getPlatformProxy({ persist: false });
  try {
    const db = proxy.env.MO_SPEECH_DB;
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0005_credit_job_reservations.sql", import.meta.url)),
      "utf8",
    );
    for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }

    const now = "2026-09-03T00:00:00.000Z";
    await db.prepare(CREDIT_RESERVATION_SQL.insert)
      .bind("r1", "google:1", "voice-conversion-jobs", "job", 30, now).run();
    await db.prepare(CREDIT_RESERVATION_SQL.attachJobId).bind("job-1", "r1").run();
    await db.prepare(CREDIT_RESERVATION_SQL.recordOutcome).bind("succeeded", 90_000, "r1").run();

    const byJobId = await db.prepare(CREDIT_RESERVATION_SQL.selectByJobId).bind("job-1").first();
    assert.equal(byJobId.reserve_key, "r1");
    assert.equal(byJobId.status, "in_flight");
    assert.equal(byJobId.job_status, "succeeded");
    assert.equal(byJobId.execution_time_ms, 90_000);

    await db.prepare(CREDIT_RESERVATION_SQL.finalize)
      .bind("settled", 23, "2026-09-03T00:05:00.000Z", "r1").run();
    const settled = await db.prepare(CREDIT_RESERVATION_SQL.selectByKey).bind("r1").first();
    assert.equal(settled.status, "settled");
    assert.equal(settled.settled_amount, 23);

    // 終端でない行は保持期間の削除に巻き込まれない
    await db.prepare(CREDIT_RESERVATION_SQL.insert)
      .bind("r2", "google:1", "practice-prompts", "sync", 5, now).run();
    await db.prepare(CREDIT_RESERVATION_SQL.deleteResolved).bind("2027-01-01T00:00:00.000Z").run();
    assert.equal(await db.prepare(CREDIT_RESERVATION_SQL.selectByKey).bind("r1").first(), null);
    assert.notEqual(await db.prepare(CREDIT_RESERVATION_SQL.selectByKey).bind("r2").first(), null);
  } finally {
    await proxy.dispose();
  }
});

test("credit reservation schema rejects states the code never writes", async () => {
  const proxy = await getPlatformProxy({ persist: false });
  try {
    const db = proxy.env.MO_SPEECH_DB;
    const migration = await readFile(
      fileURLToPath(new URL("../migrations/0005_credit_job_reservations.sql", import.meta.url)),
      "utf8",
    );
    for (const statement of migration.split(";").map((part) => part.trim()).filter(Boolean)) {
      await db.prepare(statement).run();
    }

    await assert.rejects(() =>
      db.prepare(CREDIT_RESERVATION_SQL.insert)
        .bind("bad-kind", "google:1", "practice-prompts", "batch", 5, "2026-09-03T00:00:00.000Z").run());
    await db.prepare(CREDIT_RESERVATION_SQL.insert)
      .bind("r1", "google:1", "practice-prompts", "sync", 5, "2026-09-03T00:00:00.000Z").run();
    await assert.rejects(() =>
      db.prepare(CREDIT_RESERVATION_SQL.finalize)
        .bind("done", null, "2026-09-03T00:01:00.000Z", "r1").run());
  } finally {
    await proxy.dispose();
  }
});
