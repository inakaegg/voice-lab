import assert from "node:assert/strict";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const launcher = "scripts/run_zoovoice_local_cloudflare.sh";

test("Zoovoice local launcher dry-run uses Go and Wrangler without starting FastAPI or child commands", () => {
  const fakeBin = mkdtempSync(join(tmpdir(), "zoovoice-launcher-test-"));
  const marker = join(fakeBin, "executed.txt");
  try {
    const runtime = createRuntimeFixtures(fakeBin);
    for (const name of ["gcloud", "go", "npm", "npx"]) {
      const path = join(fakeBin, name);
      writeFileSync(
        path,
        '#!/bin/sh\nprintf \'%s\\n\' "$0 $*" >> "$ZOOVOICE_EXECUTION_MARKER"\nexit 99\n',
      );
      chmodSync(path, 0o700);
    }
    const result = runLauncher("local", {
      PATH: `${fakeBin}${delimiter}${process.env.PATH || ""}`,
      ZOOVOICE_EXECUTION_MARKER: marker,
      ...runtime,
    });

    assert.equal(result.status, 0, result.stderr);
    assert.match(result.stdout, /npm run build:web/);
    assert.match(
      result.stdout,
      /wrangler d1 migrations apply MO_SPEECH_DB .*--local.*--persist-to/,
    );
    assert.match(result.stdout, /go build -o tmp\/zoovoice-local-api \./);
    assert.match(result.stdout, /ZOOVOICE_PORT=8090 .*tmp\/zoovoice-local-api/);
    assert.match(result.stdout, /ZOOVOICE_TIMEOUT_SECONDS=85/);
    assert.match(
      result.stdout,
      /ASR runtime artifacts and association API key: verified/,
    );
    assert.match(
      result.stdout,
      /wrangler dev .*--local.*--ip 127\.0\.0\.1.*--port 8787/,
    );
    assert.match(result.stdout, /--env-file <temporary-dev-vars>/);
    assert.doesNotMatch(result.stdout, /uvicorn|mo_speech\.api|FastAPI/i);
    assert.equal(readIfPresent(marker), "");
  } finally {
    rmSync(fakeBin, { recursive: true, force: true });
  }
});

test("Zoovoice local launcher honours port overrides and rejects invalid ports", () => {
  const directory = mkdtempSync(join(tmpdir(), "zoovoice-launcher-ports-"));
  try {
    const runtime = createRuntimeFixtures(directory);

    const overridden = runLauncher("local", {
      ...runtime,
      ZOOVOICE_DEV_PORT: "8788",
      ZOOVOICE_API_PORT: "8091",
    });

    assert.equal(overridden.status, 0, overridden.stderr);
    assert.match(overridden.stdout, /ZOOVOICE_PORT=8091 /);
    assert.match(overridden.stdout, /wrangler dev .*--port 8788/);

    const rejected = runLauncher("local", {
      ...runtime,
      ZOOVOICE_DEV_PORT: "not-a-port",
    });

    assert.notEqual(rejected.status, 0);
    assert.match(rejected.stderr, /ZOOVOICE_DEV_PORT must be a port number/);
    assert.doesNotMatch(
      rejected.stdout + rejected.stderr,
      /wrangler dev|go build|npm run build:web/,
    );
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Zoovoice local launcher requires ASR runtime artifacts and an API key before child commands", () => {
  const directory = mkdtempSync(join(tmpdir(), "zoovoice-launcher-inputs-"));
  try {
    const runtime = createRuntimeFixtures(directory);
    for (const omitted of [
      "ZOOVOICE_WHISPER_COMMAND",
      "ZOOVOICE_ASR_MODEL_PATH",
      "ZOOVOICE_SOUNDS_DIR",
      "OPENAI_API_KEY",
    ]) {
      const values = { ...runtime };
      delete values[omitted as keyof typeof values];

      const result = runLauncher("local", values);

      assert.notEqual(result.status, 0, omitted);
      assert.match(result.stderr, new RegExp(`${omitted} is required`));
      assert.doesNotMatch(
        result.stdout + result.stderr,
        /wrangler dev|go run|npm run build:web/,
      );
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test("Zoovoice Cloud Run launcher dry-run uses redacted service account impersonation", () => {
  const serviceAccount =
    "must-not-appear@example-project.iam.gserviceaccount.com";
  const secretValue = "must-not-appear-id-token";
  const result = runLauncher("cloud-run", {
    ZOOVOICE_CLOUD_RUN_URL: "https://zoovoice-example-uc.a.run.app",
    ZOOVOICE_GCP_PROJECT: "example-project",
    ZOOVOICE_SMOKE_SERVICE_ACCOUNT: serviceAccount,
    ZOOVOICE_GCP_ID_TOKEN: secretValue,
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /gcloud auth print-identity-token/);
  assert.match(result.stdout, /--impersonate-service-account=<redacted>/);
  assert.match(
    result.stdout,
    /--audiences=https:\/\/zoovoice-example-uc\.a\.run\.app/,
  );
  assert.match(result.stdout, /--project=example-project/);
  assert.match(result.stdout, /ZOOVOICE_ORIGIN_MODE=cloud-run-smoke/);
  assert.doesNotMatch(
    result.stdout + result.stderr,
    new RegExp(serviceAccount.replaceAll(".", "\\.")),
  );
  assert.doesNotMatch(result.stdout + result.stderr, new RegExp(secretValue));
  assert.doesNotMatch(
    result.stdout + result.stderr,
    /ZOOVOICE_GCP_SERVICE_ACCOUNT_JSON|PRIVATE KEY/,
  );
});

test("Zoovoice Cloud Run launcher fails before child commands when required inputs are missing", () => {
  for (const omitted of [
    "ZOOVOICE_CLOUD_RUN_URL",
    "ZOOVOICE_GCP_PROJECT",
    "ZOOVOICE_SMOKE_SERVICE_ACCOUNT",
  ]) {
    const values: Record<string, string> = {
      ZOOVOICE_CLOUD_RUN_URL: "https://zoovoice-example-uc.a.run.app",
      ZOOVOICE_GCP_PROJECT: "example-project",
      ZOOVOICE_SMOKE_SERVICE_ACCOUNT:
        "smoke@example-project.iam.gserviceaccount.com",
    };
    delete values[omitted];

    const result = runLauncher("cloud-run", values);

    assert.notEqual(result.status, 0, omitted);
    assert.match(result.stderr, new RegExp(`${omitted} is required`));
    assert.doesNotMatch(
      result.stdout + result.stderr,
      /wrangler dev|go run|npm run build:web/,
    );
  }
});

test("Zoovoice launcher rejects unsupported modes", () => {
  const result = runLauncher("production", {});

  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /usage: .*\{local\|cloud-run\}/);
});

test("package scripts expose both Zoovoice Wrangler modes", () => {
  const directory = mkdtempSync(join(tmpdir(), "zoovoice-package-scripts-"));
  const runtime = createRuntimeFixtures(directory);
  const local = spawnSync("npm", ["run", "dev:zoovoice"], {
    cwd: repositoryRoot,
    env: { ...process.env, ZOOVOICE_DRY_RUN: "1", ...runtime },
    encoding: "utf8",
  });
  assert.equal(local.status, 0, local.stderr);
  assert.match(local.stdout, /ZOOVOICE_ORIGIN_MODE=local-origin/);

  const cloudRun = spawnSync("npm", ["run", "dev:zoovoice:cloud-run"], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ZOOVOICE_DRY_RUN: "1",
      ZOOVOICE_CLOUD_RUN_URL: "https://zoovoice-example-uc.a.run.app",
      ZOOVOICE_GCP_PROJECT: "example-project",
      ZOOVOICE_SMOKE_SERVICE_ACCOUNT:
        "smoke@example-project.iam.gserviceaccount.com",
    },
    encoding: "utf8",
  });
  assert.equal(cloudRun.status, 0, cloudRun.stderr);
  assert.match(cloudRun.stdout, /ZOOVOICE_ORIGIN_MODE=cloud-run-smoke/);
  const packageJson = readFileSync(
    join(repositoryRoot, "package.json"),
    "utf8",
  );
  assert.match(
    packageJson,
    /"test:e2e:zoovoice":\s*"playwright test --config playwright\.zoovoice\.config\.ts"/,
  );
  rmSync(directory, { recursive: true, force: true });
});

test("Playwright keeps FastAPI for existing suites and uses Wrangler only for Zoovoice", () => {
  const sharedConfig = readFileSync(
    join(repositoryRoot, "playwright.config.ts"),
    "utf8",
  );
  const zoovoiceConfig = readFileSync(
    join(repositoryRoot, "playwright.zoovoice.config.ts"),
    "utf8",
  );

  assert.match(sharedConfig, /uvicorn mo_speech\.api:app/);
  assert.doesNotMatch(sharedConfig, /wrangler dev/);
  assert.match(zoovoiceConfig, /wrangler dev/);
  assert.match(zoovoiceConfig, /--local/);
  assert.match(zoovoiceConfig, /timeout:\s*120_000/);
  assert.doesNotMatch(zoovoiceConfig, /uvicorn|mo_speech\.api|PYTHONPATH/);
});

function runLauncher(mode: string, extraEnv: Record<string, string>) {
  return spawnSync("bash", [launcher, mode], {
    cwd: repositoryRoot,
    env: {
      ...process.env,
      ZOOVOICE_DRY_RUN: "1",
      ...extraEnv,
    },
    encoding: "utf8",
  });
}

function readIfPresent(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return "";
    throw error;
  }
}

function createRuntimeFixtures(directory: string): Record<string, string> {
  const command = join(directory, "whisper-cli");
  const model = join(directory, "ggml-small.bin");
  const sounds = join(directory, "sounds");
  writeFileSync(command, "fixture");
  writeFileSync(model, "fixture");
  mkdirSync(sounds, { recursive: true });
  writeFileSync(
    join(sounds, "manifest.json"),
    '{"schema_version":1,"animals":[]}',
  );
  return {
    ZOOVOICE_WHISPER_COMMAND: command,
    ZOOVOICE_ASR_MODEL_PATH: model,
    ZOOVOICE_SOUNDS_DIR: sounds,
    OPENAI_API_KEY: "test-openai-key",
  };
}
