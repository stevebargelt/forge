# Hosting ntfy for forge notifications

ntfy is a simple push notification server. Forge sends an HTTP POST; your phone gets a push notification. This doc covers hosting options — for the forge integration side, see [how-to-set-up-notifications.md](how-to-set-up-notifications.md).

## Option 1: Azure (Container App, free tier)

If you have Azure credits or a free-tier subscription, this is the lowest-maintenance path. Two ways to deploy: **OpenTofu/Terraform** (recommended) or **Azure CLI** manually.

### Prerequisites

- Azure CLI (`az`) installed and logged in (`az login`)

### Deploy with OpenTofu (recommended)

The forge repo includes an OpenTofu module at `infra/ntfy-azure/`.

```bash
cd infra/ntfy-azure
cp terraform.tfvars.example terraform.tfvars
# Edit terraform.tfvars — set your subscription_id at minimum
tofu init
tofu plan
tofu apply
```

Scales to zero when idle (no cost). First notification after idle has ~5-15s cold start.

### Get your credentials

The outputs contain a randomized topic URL — this is your auth. The topic name is a 32-char hex string that's effectively unguessable:

```bash
tofu output -raw notify_env_snippet
# Prints:
# FORGE_NOTIFY=ntfy
# NTFY_URL=https://ntfy.<env>.azurecontainerapps.io/forge-a1b2c3d4...
```

Paste those lines into `~/.forge/notify.env`. No `NTFY_TOKEN` needed — the secret topic name in the URL is the credential.

### Security model

ntfy's built-in user/token auth uses SQLite, which doesn't work on Azure Files (SMB locking incompatibility). Instead, the module generates a random topic name (`forge-<32 hex chars>`) that acts as a shared secret. The URL is stored in `~/.forge/notify.env` on your machine and in the ntfy phone app — nowhere else. Anyone who has the full URL can post; no one can guess it.

If you need server-level auth (multi-user, audit trail), run with `min_replicas = 1` so SQLite works on the container's local disk — but that costs ~$19/mo vs free at scale-to-zero.

### Deploy with Azure CLI (manual)

```bash
az group create -n forge-ntfy -l eastus

az containerapp env create \
  --name ntfy-env \
  --resource-group forge-ntfy \
  --location eastus

az containerapp create \
  --name ntfy \
  --resource-group forge-ntfy \
  --environment ntfy-env \
  --image binwiederhier/ntfy \
  --target-port 80 \
  --ingress external \
  --args serve --base-url https://ntfy.<your-env>.azurecontainerapps.io \
  --min-replicas 0 \
  --max-replicas 1
```

Grab the URL:
```bash
az containerapp show --name ntfy --resource-group forge-ntfy --query properties.configuration.ingress.fqdn -o tsv
```

### Configure forge

Use a random topic name as the shared secret (same approach the OpenTofu module uses):

```bash
# Generate a random topic name
TOPIC="forge-$(openssl rand -hex 16)"
FQDN=$(az containerapp show --name ntfy --resource-group forge-ntfy --query properties.configuration.ingress.fqdn -o tsv)
echo "FORGE_NOTIFY=ntfy"          >> ~/.forge/notify.env
echo "NTFY_URL=https://${FQDN}/${TOPIC}" >> ~/.forge/notify.env
```

Subscribe to the same topic URL in your ntfy phone app.

## Option 2: Public ntfy.sh (testing only)

For quick testing — **not for production use**. Public topics have no authentication: anyone who guesses the topic name can read your notifications AND post spam to your phone.

```
FORGE_NOTIFY=ntfy
NTFY_URL=https://ntfy.sh/forge-$(openssl rand -hex 8)
```

Use a long random topic name. Move to a self-hosted instance with auth for real use.

## Option 3: Raspberry Pi (always-on)

If you have a Pi running 24/7 (home server, NAS, etc.):

```bash
# On the Pi
sudo apt install -y ntfy   # or download the binary from ntfy.sh
sudo systemctl enable ntfy
sudo systemctl start ntfy
```

Then set up port forwarding (443 → Pi:443) on your router, DuckDNS or similar for dynamic DNS, and Let's Encrypt for TLS (ntfy has built-in ACME support).

```
FORGE_NOTIFY=ntfy
NTFY_URL=https://your-pi.duckdns.org/forge
```

## Phone setup

Install the ntfy app ([Android](https://play.google.com/store/apps/details?id=io.heckel.ntfy) / [iOS](https://apps.apple.com/app/ntfy/id1625396347)) and subscribe to your topic URL. Notifications appear as standard push notifications.

## Verify

```bash
forge notify test     # should show "✓ ntfy sent"
forge notify status   # should show "ntfy ready: yes"
```
