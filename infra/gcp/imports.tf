# 既存資産の取り込み定義。import済みのstateには影響しない（再実行しても安全）。

import {
  for_each = toset(local.enabled_apis)
  to       = google_project_service.apis[each.value]
  id       = "${local.project}/${each.value}"
}

import {
  to = google_artifact_registry_repository.voice_lab
  id = "projects/${local.project}/locations/${local.region}/repositories/voice-lab"
}

import {
  to = google_service_account.smoke_invoker
  id = "projects/${local.project}/serviceAccounts/zoovoice-local-smoke-invoker@${local.project}.iam.gserviceaccount.com"
}

import {
  to = google_service_account.worker_invoker
  id = "projects/${local.project}/serviceAccounts/zoovoice-worker-invoker@${local.project}.iam.gserviceaccount.com"
}

import {
  to = google_service_account_iam_member.smoke_invoker_token_creator
  id = "projects/${local.project}/serviceAccounts/zoovoice-local-smoke-invoker@${local.project}.iam.gserviceaccount.com roles/iam.serviceAccountTokenCreator user:52376271+inakaegg@users.noreply.github.com"
}

import {
  to = google_secret_manager_secret.zoovoice_openai_api_key
  id = "projects/${local.project}/secrets/zoovoice-openai-api-key"
}

import {
  to = google_secret_manager_secret_iam_member.zoovoice_openai_api_key_accessor
  id = "projects/${local.project}/secrets/zoovoice-openai-api-key roles/secretmanager.secretAccessor serviceAccount:763476266301-compute@developer.gserviceaccount.com"
}

import {
  to = google_cloud_run_v2_service.zoovoice
  id = "projects/${local.project}/locations/${local.region}/services/zoovoice"
}

import {
  to = google_cloud_run_v2_service_iam_binding.zoovoice_invoker
  id = "projects/${local.project}/locations/${local.region}/services/zoovoice roles/run.invoker"
}
