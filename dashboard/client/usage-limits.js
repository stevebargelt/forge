import { h } from "https://esm.sh/preact@10.24.0";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

const SERVICE_META = {
  "claude-subscription": { mark: "C", color: "#ff8a4c", logo: "/client/claude-logo.png" },
  "anthropic-api": { mark: "C", color: "#ff8a4c", logo: "/client/claude-logo.png" },
  "codex-subscription": { mark: "O", color: "#10d49c", logo: "/client/openai-logo.png", invertLogo: true },
  "openai-api": { mark: "O", color: "#10d49c", logo: "/client/openai-logo.png", invertLogo: true },
  bedrock: { mark: "A", color: "#ffb454" },
};

const STATUS_LABEL = {
  live: "live",
  stale: "stale",
  unavailable: "unavailable",
  not_applicable: "not applicable",
  not_configured: "not configured",
  error: "error",
};

export function UsageLimits({ data, loading, refreshing, refreshError, onRefresh }) {
  const services = data?.services ?? [];
  return html`
    <section class="plan-usage" aria-labelledby="plan-usage-title">
      <div class="plan-usage-heading">
        <div>
          <div class="plan-usage-kicker">live usage</div>
          <h2 id="plan-usage-title">Plan limits & windows</h2>
        </div>
        <div class="plan-usage-actions">
          <span class="plan-usage-sync">${data?.generatedAt ? `sync · ${shortTime(data.generatedAt)}` : "sync"}</span>
          <button class="plan-refresh" disabled=${refreshing} onClick=${onRefresh}>
            <span class=${refreshing ? "plan-refresh-icon spinning" : "plan-refresh-icon"}>↻</span>
            ${refreshing ? "refreshing…" : "refresh"}
          </button>
        </div>
      </div>

      ${refreshError ? html`<div class="plan-refresh-error">${refreshError}</div>` : null}

      <div class="plan-services">
        ${loading && services.length === 0
          ? html`<div class="plan-empty">Loading host plan limits…</div>`
          : services.length === 0
            ? html`<div class="plan-empty">No host plan-limit services were reported.</div>`
            : services.map(service => html`<${ServiceRow} key=${service.id} service=${service} />`)}
      </div>

      <div class="plan-usage-footnote">
        Subscription windows come from Anthropic's observed usage integration and Codex's local App Server. A recent Codex rollout is used only as a stale fallback. Configured API and Bedrock channels are shown separately without subscription quotas. Credentials stay server-side and are never returned to the browser.
      </div>
    </section>
  `;
}

function ServiceRow({ service }) {
  const meta = SERVICE_META[service.id] ?? { mark: "?", color: "var(--accent)" };
  const status = STATUS_LABEL[service.status] ?? service.status;
  return html`
    <div class="plan-service" style=${{ "--service-color": meta.color }}>
      <div class="plan-service-identity">
        <${UsageDial} windows=${service.windows} color=${meta.color} />
        <div class="plan-service-copy">
          <div class="plan-service-name-row">
            <span class="plan-service-mark">
              ${meta.logo
                ? html`<img class=${meta.invertLogo ? "plan-service-logo plan-service-logo-invert" : "plan-service-logo"} src=${meta.logo} alt="" />`
                : meta.mark}
            </span>
            <strong>${service.name}</strong>
          </div>
          <div class="plan-service-plan">${service.plan ?? "No plan detected"}</div>
          <div class="plan-service-meta">
            <span class=${`plan-status plan-status-${service.status}`}>${status}</span>
            <span>${authLabel(service.authMode)}</span>
          </div>
        </div>
      </div>

      <div class="plan-window-list">
        ${service.windows.length > 0
          ? service.windows.map(window => html`<${WindowBar} key=${window.label} window=${window} />`)
          : html`<div class="plan-service-note">${service.note ?? "No plan windows reported."}</div>`}
        ${service.windows.length > 0 && service.note
          ? html`<div class="plan-service-note plan-service-note-inline">${service.note}</div>`
          : null}
        ${service.observedAt
          ? html`<div class="plan-observed">observed ${relativeTime(service.observedAt)}</div>`
          : null}
      </div>
    </div>
  `;
}

function UsageDial({ windows, color }) {
  const values = windows
    .map(window => window.usedPct)
    .filter(value => typeof value === "number" && Number.isFinite(value));
  const hasUsage = values.length > 0;
  const used = hasUsage ? Math.max(...values) : 0;
  const clamped = Math.max(0, Math.min(100, used));
  const size = 76;
  const stroke = 7;
  const radius = (size - stroke) / 2;
  const circumference = 2 * Math.PI * radius;
  const offset = circumference * (1 - clamped / 100);
  return html`
    <div class=${hasUsage ? "plan-dial" : "plan-dial plan-dial-unknown"}>
      <svg class="plan-dial-ring" width=${size} height=${size} viewBox=${`0 0 ${size} ${size}`} aria-hidden="true">
        <circle
          class="plan-dial-track"
          cx=${size / 2}
          cy=${size / 2}
          r=${radius}
          stroke-width=${stroke}
        ></circle>
        ${hasUsage ? html`
          <circle
            class="plan-dial-progress"
            cx=${size / 2}
            cy=${size / 2}
            r=${radius}
            stroke=${color}
            stroke-width=${stroke}
            stroke-dasharray=${circumference}
            stroke-dashoffset=${offset}
          ></circle>
        ` : null}
      </svg>
      <div class="plan-dial-inner">
        <svg class="plan-dial-gauge" viewBox="0 0 24 24" aria-hidden="true">
          <path d="M3.34 19a10 10 0 1 1 17.32 0"></path>
          <path d="m12 14 4-4"></path>
        </svg>
        <div class="plan-dial-value">${hasUsage ? `${Math.round(clamped)}%` : "—"}</div>
      </div>
    </div>
  `;
}

function WindowBar({ window }) {
  const used = Math.max(0, Math.min(100, window.usedPct));
  return html`
    <div class="plan-window">
      <div class="plan-window-top">
        <div class="plan-window-label">
          <span>${window.label}</span>
          <strong>${Math.round(window.usedPct)}%</strong>
        </div>
        <div class="plan-window-detail">
          ${window.resetsAt ? `resets ${relativeFuture(window.resetsAt)}` : "reset unknown"}
          ${window.pacePct != null ? html`<span class="plan-pace">pace ${window.pacePct}%</span>` : null}
        </div>
      </div>
      <div class="plan-window-track" title=${window.resetsAt ? `Resets ${new Date(window.resetsAt).toLocaleString()}` : undefined}>
        <div class="plan-window-fill" style=${{ width: `${used}%` }}></div>
        <i></i><i></i><i></i>
      </div>
    </div>
  `;
}

function authLabel(mode) {
  if (mode === "oauth") return "OAuth";
  if (mode === "subscription") return "subscription";
  if (mode === "api_key") return "API key";
  if (mode === "bedrock") return "AWS";
  return "host";
}

function shortTime(iso) {
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "unknown";
}

function relativeTime(iso) {
  const ms = Date.now() - new Date(iso).getTime();
  if (!Number.isFinite(ms)) return "at an unknown time";
  if (ms < 60_000) return "just now";
  if (ms < 3_600_000) return `${Math.round(ms / 60_000)}m ago`;
  if (ms < 86_400_000) return `${Math.round(ms / 3_600_000)}h ago`;
  return `${Math.round(ms / 86_400_000)}d ago`;
}

function relativeFuture(iso) {
  const ms = new Date(iso).getTime() - Date.now();
  if (!Number.isFinite(ms)) return "unknown";
  if (ms <= 0) return "now";
  if (ms < 3_600_000) return `in ${Math.max(1, Math.round(ms / 60_000))}m`;
  if (ms < 172_800_000) return `in ${Math.round(ms / 3_600_000)}h`;
  return `in ${Math.round(ms / 86_400_000)}d`;
}
