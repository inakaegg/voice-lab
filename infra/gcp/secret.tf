# secretの入れ物とアクセス権だけを管理する。値（version）はTerraformで持たない。
# 値の登録は gcloud secrets versions add を正とする。

resource "google_secret_manager_secret" "zoovoice_openai_api_key" {
  secret_id = "zoovoice-openai-api-key"

  replication {
    auto {}
  }
}

# Cloud Run実行用service account（default compute）へ読み取りを許可する
resource "google_secret_manager_secret_iam_member" "zoovoice_openai_api_key_accessor" {
  secret_id = google_secret_manager_secret.zoovoice_openai_api_key.secret_id
  role      = "roles/secretmanager.secretAccessor"
  member    = "serviceAccount:${data.google_project.current.number}-compute@developer.gserviceaccount.com"
}
