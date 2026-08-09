resource "google_artifact_registry_repository" "voice_lab" {
  repository_id = "voice-lab"
  location      = local.region
  format        = "DOCKER"
  description   = "Private Voice Lab container images"
}
