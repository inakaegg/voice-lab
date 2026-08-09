# Cloud Run service `zoovoice` の設定の正本。
# imageはdeploy script（scripts/deploy_zoovoice_cloud_run.sh）がdigest指定で入れ替えるため、
# Terraformでは追跡しない（lifecycle.ignore_changes）。

resource "google_cloud_run_v2_service" "zoovoice" {
  name                = "zoovoice"
  location            = local.region
  ingress             = "INGRESS_TRAFFIC_ALL"
  deletion_protection = true

  template {
    service_account                  = "${data.google_project.current.number}-compute@developer.gserviceaccount.com"
    timeout                          = "90s"
    max_instance_request_concurrency = 1

    scaling {
      min_instance_count = 0
      max_instance_count = 2
    }

    containers {
      # この値は新規作成時にしか使われない（既存serviceはignore_changesで追跡しない）。
      # 万一作り直す場合は、実在するdigest（<repo>/zoovoice@sha256:...）へ書き換えてからapplyする。
      image = "${local.region}-docker.pkg.dev/${local.project}/voice-lab/zoovoice"

      ports {
        container_port = 8080
      }

      resources {
        limits = {
          cpu    = "2"
          memory = "2Gi"
        }
        cpu_idle          = true
        startup_cpu_boost = true
      }

      env {
        name = "OPENAI_API_KEY"
        value_source {
          secret_key_ref {
            secret  = google_secret_manager_secret.zoovoice_openai_api_key.secret_id
            version = "latest"
          }
        }
      }
    }
  }

  traffic {
    type    = "TRAFFIC_TARGET_ALLOCATION_TYPE_LATEST"
    percent = 100
  }

  lifecycle {
    ignore_changes = [
      # imageはdeploy scriptがdigestで更新する
      template[0].containers[0].image,
      # gcloud deployが書き込むclient情報とrevision nonce
      client,
      client_version,
      template[0].labels,
      template[0].annotations,
    ]
  }
}

# privateを維持する。呼び出しはWorker用とローカルsmoke用の2つのservice accountだけに許可する。
resource "google_cloud_run_v2_service_iam_binding" "zoovoice_invoker" {
  name     = google_cloud_run_v2_service.zoovoice.name
  location = local.region
  role     = "roles/run.invoker"

  members = [
    "serviceAccount:${google_service_account.smoke_invoker.email}",
    "serviceAccount:${google_service_account.worker_invoker.email}",
  ]
}
