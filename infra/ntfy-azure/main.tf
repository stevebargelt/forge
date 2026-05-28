terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    random = {
      source  = "hashicorp/random"
      version = "~> 3.0"
    }
  }
}

provider "azurerm" {
  features {}
  subscription_id = var.subscription_id
}

resource "random_id" "topic" {
  byte_length = 16
}

resource "azurerm_resource_group" "ntfy" {
  name     = var.resource_group_name
  location = var.location
}

resource "azurerm_container_app_environment" "ntfy" {
  name                = "${var.name}-env"
  location            = azurerm_resource_group.ntfy.location
  resource_group_name = azurerm_resource_group.ntfy.name
}

resource "azurerm_container_app" "ntfy" {
  name                         = var.name
  container_app_environment_id = azurerm_container_app_environment.ntfy.id
  resource_group_name          = azurerm_resource_group.ntfy.name
  revision_mode                = "Single"

  template {
    min_replicas = 0
    max_replicas = 1

    container {
      name   = "ntfy"
      image  = "binwiederhier/ntfy:latest"
      cpu    = 0.25
      memory = "0.5Gi"

      args = [
        "serve",
        "--base-url=${var.base_url != "" ? var.base_url : "https://${var.name}.${azurerm_container_app_environment.ntfy.default_domain}"}",
      ]
    }
  }

  ingress {
    external_enabled = true
    target_port      = 80
    transport        = "auto"

    traffic_weight {
      latest_revision = true
      percentage      = 100
    }
  }
}
