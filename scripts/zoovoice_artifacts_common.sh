# Zoovoiceのbuild資材（ASRモデルと動物音源セット）のGCS上の位置と、期待するSHA-256。
# 資材はrepositoryへ置かないため、正本はGCSのobjectであり、この値がその同一性を保証する。
# 資材を差し替えるときは、新しいobjectを別のpathへ置いてからここを更新する。既存objectは上書きしない。

zoovoice_artifacts_bucket=mo-speech-501706-zoovoice-artifacts

zoovoice_asr_model_object=asr/ggml-small-1be3a9b20638.bin
zoovoice_asr_model_sha256=1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b

# 音源セットは66ファイルあるため、決定的なtar.gz 1本にまとめて置く。
# 個々のファイルのSHA-256照合は、Goサービスが起動時にmanifest.jsonで行う既存経路が担う。
zoovoice_sounds_object=sounds/zoovoice-sounds-c60cf12c5c9f.tar.gz
zoovoice_sounds_sha256=c60cf12c5c9fa0bcd6aa272b8b0fb1f4632711f865761aaeac42d7de8f2f6329

zoovoice_artifacts_fail() {
  echo "$1" >&2
  exit 1
}

# shasumはmacOS、sha256sumはLinux。CIとローカルの両方で動かすため両対応にする。
zoovoice_artifacts_sha256() {
  local target=$1
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$target" | awk '{print $1}'
  elif command -v sha256sum >/dev/null 2>&1; then
    sha256sum "$target" | awk '{print $1}'
  else
    zoovoice_artifacts_fail "SHA-256を計算できるコマンドが見つかりません。"
  fi
}

zoovoice_artifacts_verify_sha256() {
  local target=$1
  local expected=$2
  local label=$3
  local actual
  actual=$(zoovoice_artifacts_sha256 "$target")
  if [[ "$actual" != "$expected" ]]; then
    echo "${label}のSHA-256が期待値と一致しません。" >&2
    echo "  expected: $expected" >&2
    echo "  actual:   $actual" >&2
    exit 1
  fi
}
