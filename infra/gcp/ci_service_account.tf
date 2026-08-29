# GitHub ActionsのCDが使うservice account。
# 与えるのは、資材の取得・imageのpush・serviceのimage入れ替え・deploy後のsmokeだけとする。
# 鍵はTerraformで作らない。秘密鍵がstateへ入るためで、作成と失効の手順は
# docs/deployment/MODEL_STORAGE.md に置く。

resource "google_service_account" "ci_deployer" {
  account_id   = "zoovoice-ci-deployer"
  display_name = "Zoovoice CI deployer"
}

# deploy scriptはapply時にallUsersが居ないことをIAM policyで確認する。
# roles/artifactregistry.writer にはその読み取り権限が無く、
# 持つのは roles/artifactregistry.admin だけで、setIamPolicyと削除まで付いてくる。
# 不足する1権限だけをカスタムroleで足し、writerはそのまま使う。
resource "google_project_iam_custom_role" "artifact_registry_iam_reader" {
  role_id     = "zoovoiceArtifactRegistryIamReader"
  title       = "Zoovoice Artifact Registry IAM reader"
  description = "Artifact Registry repositoryのIAM policyを読むだけのrole"
  permissions = ["artifactregistry.repositories.getIamPolicy"]
}

# roles/run.developer はserviceの削除と作成まで含む。
# CDに必要なのはimageの入れ替えとIAM確認だけなので、その分だけをroleにする。
resource "google_project_iam_custom_role" "cloud_run_image_updater" {
  role_id     = "zoovoiceCloudRunImageUpdater"
  title       = "Zoovoice Cloud Run image updater"
  description = "Cloud Run serviceのimage入れ替えとIAM確認に要る権限だけを持つrole"
  permissions = [
    "run.services.get",
    "run.services.getIamPolicy",
    "run.services.update",
  ]
}

# `gcloud run services update` は更新operationの状態を取りに行くため run.operations.get を要する。
# この権限はserviceスコープでは付与できずprojectスコープにしかないので、roleを分ける。
# 欠けるとimageのpushは成功したまま更新の完了確認で失敗し、反映が中途半端になる。
resource "google_project_iam_custom_role" "cloud_run_operation_reader" {
  role_id     = "zoovoiceCloudRunOperationReader"
  title       = "Zoovoice Cloud Run operation reader"
  description = "Cloud Runの更新operationの状態を読むだけのrole"
  permissions = ["run.operations.get"]
}

# 資材の取得。読み取りだけで、削除と上書きは与えない。
resource "google_storage_bucket_iam_member" "ci_deployer_artifacts_reader" {
  bucket = google_storage_bucket.zoovoice_artifacts.name
  role   = "roles/storage.objectViewer"
  member = "serviceAccount:${google_service_account.ci_deployer.email}"
}

# imageのpush。付与先は voice-lab repository に限る。
resource "google_artifact_registry_repository_iam_member" "ci_deployer_writer" {
  project    = local.project
  location   = local.region
  repository = google_artifact_registry_repository.voice_lab.name
  role       = "roles/artifactregistry.writer"
  member     = "serviceAccount:${google_service_account.ci_deployer.email}"
}

resource "google_artifact_registry_repository_iam_member" "ci_deployer_iam_reader" {
  project    = local.project
  location   = local.region
  repository = google_artifact_registry_repository.voice_lab.name
  role       = google_project_iam_custom_role.artifact_registry_iam_reader.id
  member     = "serviceAccount:${google_service_account.ci_deployer.email}"
}

# imageの入れ替え。付与先は zoovoice service に限る。
resource "google_cloud_run_v2_service_iam_member" "ci_deployer_image_updater" {
  name     = google_cloud_run_v2_service.zoovoice.name
  location = local.region
  role     = google_project_iam_custom_role.cloud_run_image_updater.id
  member   = "serviceAccount:${google_service_account.ci_deployer.email}"
}

# 更新operationの状態取得はprojectスコープでしか付与できない。権限は1つに絞る。
resource "google_project_iam_member" "ci_deployer_operation_reader" {
  project = local.project
  role    = google_project_iam_custom_role.cloud_run_operation_reader.id
  member  = "serviceAccount:${google_service_account.ci_deployer.email}"
}

# Cloud Run実行用service accountを名乗るserviceを更新するために要る。
resource "google_service_account_iam_member" "ci_deployer_runtime_user" {
  service_account_id = "projects/${local.project}/serviceAccounts/${data.google_project.current.number}-compute@developer.gserviceaccount.com"
  role               = "roles/iam.serviceAccountUser"
  member             = "serviceAccount:${google_service_account.ci_deployer.email}"
}
