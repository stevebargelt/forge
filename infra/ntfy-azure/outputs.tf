output "fqdn" {
  description = "The FQDN of the ntfy Container App"
  value       = azurerm_container_app.ntfy.ingress[0].fqdn
}

output "topic_secret" {
  description = "Randomized topic name — this IS the auth. Keep it secret."
  value       = "forge-${random_id.topic.hex}"
  sensitive   = true
}

output "ntfy_url" {
  description = "Full ntfy topic URL — paste into ~/.forge/notify.env as NTFY_URL"
  value       = "https://${azurerm_container_app.ntfy.ingress[0].fqdn}/forge-${random_id.topic.hex}"
  sensitive   = true
}

output "notify_env_snippet" {
  description = "Lines to add to ~/.forge/notify.env (run: tofu output -raw notify_env_snippet)"
  value       = "FORGE_NOTIFY=ntfy\nNTFY_URL=https://${azurerm_container_app.ntfy.ingress[0].fqdn}/forge-${random_id.topic.hex}"
  sensitive   = true
}
