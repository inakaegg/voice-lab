# Workerが使う保存資産。binding名との対応は wrangler.toml が正。
# Workerスクリプト本体とsecretはTerraformで持たない（wrangler deploy / wrangler secret が正）。

resource "cloudflare_workers_kv_namespace" "mo_speech" {
  account_id = local.account_id
  title      = "MO_SPEECH_KV"
}

resource "cloudflare_d1_database" "mo_speech_demo" {
  account_id = local.account_id
  name       = "mo-speech-demo-db"

  read_replication = {
    mode = "disabled"
  }
}

resource "cloudflare_r2_bucket" "mo_speech_audio" {
  account_id    = local.account_id
  name          = "mo-speech-audio"
  location      = "APAC"
  storage_class = "Standard"
}

resource "cloudflare_r2_bucket" "mo_speech_audio_preview" {
  account_id    = local.account_id
  name          = "mo-speech-audio-preview"
  location      = "APAC"
  storage_class = "Standard"
}
