resource "cloudflare_turnstile_widget" "voice_lab_zoovoice" {
  account_id      = local.account_id
  name            = "voice-lab-zoovoice"
  mode            = "managed"
  region          = "world"
  bot_fight_mode  = false
  clearance_level = "no_clearance"
  offlabel        = false

  domains = [
    "127.0.0.1",
    "localhost",
    "voice-lab.inakaegg.workers.dev",
  ]
}
