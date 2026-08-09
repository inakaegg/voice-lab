resource "google_service_account" "smoke_invoker" {
  account_id   = "zoovoice-local-smoke-invoker"
  display_name = "Zoovoice local smoke invoker"
}

resource "google_service_account" "worker_invoker" {
  account_id   = "zoovoice-worker-invoker"
  display_name = "Zoovoice Cloudflare Worker invoker"
}

# 開発者がsmoke用service accountを名乗って短期tokenを取れるようにする
resource "google_service_account_iam_member" "smoke_invoker_token_creator" {
  service_account_id = google_service_account.smoke_invoker.name
  role               = "roles/iam.serviceAccountTokenCreator"
  member             = var.smoke_invoker_principal
}
