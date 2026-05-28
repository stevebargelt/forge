variable "subscription_id" {
  description = "Azure subscription ID"
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group to create"
  type        = string
  default     = "forge-ntfy"
}

variable "location" {
  description = "Azure region"
  type        = string
  default     = "eastus"
}

variable "name" {
  description = "Container App name (also used as the subdomain)"
  type        = string
  default     = "ntfy"
}

variable "base_url" {
  description = "Public base URL for ntfy (leave empty to auto-derive from Container App FQDN)"
  type        = string
  default     = ""
}
