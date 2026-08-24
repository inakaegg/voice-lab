import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const repositoryRoot = fileURLToPath(new URL("../", import.meta.url));
const launcherSource = join(repositoryRoot, "zoovoice");

test("Zoovoice launcher uses ignored internal paths and forwards only preview arguments", () => {
  const fixture = createLauncherFixture();
  try {
    assert.equal(
      readFileSync(join(fixture.root, ".env.zoovoice"), "utf8"),
      [
        `SOUNDS_DIR=${fixture.sounds}`,
        `WHISPER_BUILD_DIR=${fixture.whisperBuild}`,
        `ASR_MODEL_PATH=${fixture.model}`,
        "",
      ].join("\n"),
    );
    assert.equal(statSync(join(fixture.root, ".env.zoovoice")).mode & 0o777, 0o600);

    const help = spawnSync(fixture.launcher, ["--help"], {
      cwd: fixture.root,
      encoding: "utf8",
    });
    assert.equal(help.status, 0, help.stderr);
    assert.doesNotMatch(help.stdout, /setup|environment|環境変数/i);

    const previewed = spawnSync(
      fixture.launcher,
      [
        "preview",
        "-audio",
        fixture.input,
        "-species",
        "cat,dog",
        "-intensity",
        "50",
      ],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.fakeBin}${delimiter}${process.env.PATH || ""}`,
          ZOOVOICE_FAKE_BINARY_TEMPLATE: fixture.fakeBinary,
          ZOOVOICE_TEST_CAPTURE: fixture.capture,
        },
      },
    );

    assert.equal(previewed.status, 0, previewed.stderr);
    const capture = readFileSync(fixture.capture, "utf8");
    assert.match(
      capture,
      new RegExp(
        `^args=preview -audio ${escapeRegExp(fixture.input)} -species cat,dog -intensity 50$`,
        "m",
      ),
    );
    assert.match(
      capture,
      new RegExp(`^sounds=${escapeRegExp(fixture.sounds)}$`, "m"),
    );
    assert.match(
      capture,
      new RegExp(`^model=${escapeRegExp(fixture.model)}$`, "m"),
    );

    const whisperWrapper = capture.match(/^whisper=(.+)$/m)?.[1];
    assert.ok(whisperWrapper);
    const libraryPath = [
      join(fixture.whisperBuild, "src"),
      join(fixture.whisperBuild, "ggml", "src"),
      join(fixture.whisperBuild, "ggml", "src", "ggml-blas"),
      join(fixture.whisperBuild, "ggml", "src", "ggml-metal"),
    ].join(":");

    // wrapperは呼び出し元のlibrary pathを保持して前置する。呼び出し元の値を
    // 明示しないと、CIのようにLD_LIBRARY_PATHが設定済みの環境で結果が変わる。
    const runWrapper = (captureName: string, inherited: string) => {
      const whisperCapture = join(fixture.root, captureName);
      const whispered = spawnSync(whisperWrapper, ["--version"], {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          ZOOVOICE_WHISPER_CAPTURE: whisperCapture,
          LD_LIBRARY_PATH: inherited,
          DYLD_LIBRARY_PATH: inherited,
        },
      });
      assert.equal(whispered.status, 0, whispered.stderr);
      return readFileSync(whisperCapture, "utf8");
    };

    assert.equal(
      runWrapper("whisper-capture.txt", ""),
      `args=--version\nlib=${libraryPath}\n`,
    );
    assert.equal(
      runWrapper("whisper-capture-inherited.txt", "/opt/example/lib"),
      `args=--version\nlib=${libraryPath}:/opt/example/lib\n`,
    );
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Zoovoice launcher previews text without the ASR setup", () => {
  // -textの合成はASRを通らない。whisper一式のない環境でも動かせることを固定する。
  const fixture = createLauncherFixture(true, false);
  try {
    rmSync(fixture.whisperBuild, { recursive: true, force: true });
    const previewed = spawnSync(
      fixture.launcher,
      ["preview", "-text", "屋根の上で何かが鳴いていました"],
      {
        cwd: fixture.root,
        encoding: "utf8",
        env: {
          ...process.env,
          PATH: `${fixture.fakeBin}${delimiter}${process.env.PATH || ""}`,
          ZOOVOICE_FAKE_BINARY_TEMPLATE: fixture.fakeBinary,
          ZOOVOICE_TEST_CAPTURE: fixture.capture,
        },
      },
    );

    assert.equal(previewed.status, 0, previewed.stderr);
    const capture = readFileSync(fixture.capture, "utf8");
    assert.match(
      capture,
      new RegExp(`^args=preview -text 屋根の上で何かが鳴いていました$`, "m"),
    );
    assert.match(capture, new RegExp(`^sounds=${escapeRegExp(fixture.sounds)}$`, "m"));
    assert.match(capture, /^model=$/m);
    assert.match(capture, /^whisper=$/m);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

test("Zoovoice launcher reports its ignored internal config when local paths are absent", () => {
  const fixture = createLauncherFixture(false);
  try {
    const result = spawnSync(
      fixture.launcher,
      ["preview", "-audio", fixture.input, "-species", "cat"],
      { cwd: fixture.root, encoding: "utf8" },
    );

    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /内部設定ファイル.*\.env\.zoovoice/);
    assert.doesNotMatch(result.stderr, /setup|export|環境変数/i);
  } finally {
    rmSync(fixture.root, { recursive: true, force: true });
  }
});

function createLauncherFixture(withConfig = true, withWhisper = true) {
  const root = realpathSync(
    mkdtempSync(join(tmpdir(), "zoovoice-cli-launcher-")),
  );
  const launcher = join(root, "zoovoice");
  copyFileSync(launcherSource, launcher);
  chmodSync(launcher, 0o700);

  mkdirSync(join(root, "services", "zoovoice"), { recursive: true });
  const sounds = join(root, "animal sounds");
  mkdirSync(sounds);
  writeFileSync(join(sounds, "manifest.json"), '{"schema_version":1}\n');

  const whisperBuild = join(root, "whisper build");
  for (const directory of [
    join(whisperBuild, "bin"),
    join(whisperBuild, "src"),
    join(whisperBuild, "ggml", "src", "ggml-blas"),
    join(whisperBuild, "ggml", "src", "ggml-metal"),
  ]) {
    mkdirSync(directory, { recursive: true });
  }
  const whisper = join(whisperBuild, "bin", "whisper-cli");
  writeFileSync(
    whisper,
    [
      "#!/bin/sh",
      "printf 'args=%s\\nlib=%s\\n' \"$*\" \"$LD_LIBRARY_PATH\" > \"$ZOOVOICE_WHISPER_CAPTURE\"",
      "",
    ].join("\n"),
  );
  chmodSync(whisper, 0o700);

  const model = join(root, "ggml-small.bin");
  const input = join(root, "input.wav");
  writeFileSync(model, "model");
  writeFileSync(input, "audio");
  if (withConfig) {
    const config = join(root, ".env.zoovoice");
    writeFileSync(
      config,
      [
        `SOUNDS_DIR=${sounds}`,
        ...(withWhisper
          ? [`WHISPER_BUILD_DIR=${whisperBuild}`, `ASR_MODEL_PATH=${model}`]
          : []),
        "",
      ].join("\n"),
      { mode: 0o600 },
    );
  }

  const fakeBin = join(root, "fake-bin");
  mkdirSync(fakeBin);
  const fakeGo = join(fakeBin, "go");
  writeFileSync(
    fakeGo,
    [
      "#!/bin/sh",
      "set -eu",
      "output=''",
      "while [ \"$#\" -gt 0 ]; do",
      "  if [ \"$1\" = '-o' ]; then output=$2; shift 2; continue; fi",
      "  shift",
      "done",
      "cp \"$ZOOVOICE_FAKE_BINARY_TEMPLATE\" \"$output\"",
      "chmod +x \"$output\"",
      "",
    ].join("\n"),
  );
  chmodSync(fakeGo, 0o700);

  const fakeBinary = join(root, "fake-zoovoice-binary");
  writeFileSync(
    fakeBinary,
    [
      "#!/bin/sh",
      "set -eu",
      "{",
      "  printf 'args=%s\\n' \"$*\"",
      "  printf 'sounds=%s\\n' \"$ZOOVOICE_SOUNDS_DIR\"",
      "  printf 'model=%s\\n' \"${ZOOVOICE_ASR_MODEL_PATH:-}\"",
      "  printf 'whisper=%s\\n' \"${ZOOVOICE_WHISPER_COMMAND:-}\"",
      "} > \"$ZOOVOICE_TEST_CAPTURE\"",
      "",
    ].join("\n"),
  );
  chmodSync(fakeBinary, 0o700);

  return {
    root,
    launcher,
    sounds,
    whisperBuild,
    model,
    input,
    fakeBin,
    fakeBinary,
    capture: join(root, "capture.txt"),
  };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
