# 既存資産の取り込み定義。import済みのstateには影響しない（再実行しても安全）。

import {
  to = cloudflare_workers_kv_namespace.mo_speech
  id = "${local.account_id}/8eeb96d03f7e4d97ad387a654225b649"
}

import {
  to = cloudflare_d1_database.mo_speech_demo
  id = "${local.account_id}/3e526561-0c28-42f9-8ff2-e84d091d0d70"
}

import {
  to = cloudflare_r2_bucket.mo_speech_audio
  id = "${local.account_id}/mo-speech-audio/default"
}

import {
  to = cloudflare_r2_bucket.mo_speech_audio_preview
  id = "${local.account_id}/mo-speech-audio-preview/default"
}

import {
  to = cloudflare_turnstile_widget.voice_lab_zoovoice
  id = "${local.account_id}/0x4AAAAAAEGEa8LeZO8poIN_"
}
