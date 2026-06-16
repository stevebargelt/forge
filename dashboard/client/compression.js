// Compression stats view — FG-322.
// Four panels: health summary, timeseries chart, by-role breakdown, method distribution.

import { h } from "https://esm.sh/preact@10.24.0";
import { useState } from "https://esm.sh/preact@10.24.0/hooks";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

const PERIODS = ["7d", "30d", "90d", "all"];

function fmtBytes(n) {
  if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(1) + "GB";
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "MB";
  if (n >= 1_000) return (n / 1_000).toFixed(1) + "KB";
  return String(Math.round(n)) + "B";
}

function fmtTokens(bytes) {
  // Rough estimate: 1 token ≈ 4 bytes
  const tokens = bytes / 4;
  if (tokens >= 1_000_000) return (tokens / 1_000_000).toFixed(1) + "M";
  if (tokens >= 1_000) return (tokens / 1_000).toFixed(1) + "K";
  return String(Math.round(tokens));
}

function fmtDollars(bytes) {
  // $0.005 per 1K tokens; 1 token ≈ 4 bytes
  const tokens = bytes / 4;
  const dollars = (tokens / 1000) * 0.005;
  if (dollars >= 1000) return "$" + (dollars / 1000).toFixed(1) + "K";
  if (dollars >= 1) return "$" + dollars.toFixed(2);
  return "$" + dollars.toFixed(4);
}

function shortDay(iso) {
  const p = String(iso).split("-");
  return p.length === 3 ? `${+p[1]}/${+p[2]}` : String(iso);
}

export function CompressionView({ summary, timeSeries, byRole, methods, since, onSinceChange, proxyStats, proxyTelemetry }) {
  const isEmpty = !summary || summary.totalEvents === 0;
  const hasProxyData = proxyStats && proxyStats.requests;

  return html`
    <section class="compression-view">
      ${hasProxyData ? html`<${ProxyHealthBanner} stats=${proxyStats} telemetry=${proxyTelemetry} />` : null}

      <div class="row" style="gap: 8px; margin-bottom: 16px; flex-wrap: wrap; align-items: center;">
        <span class="muted" style="font-size: 12px;">window:</span>
        ${PERIODS.map(p => html`
          <button
            class=${"usage-dim-btn " + (since === p ? "usage-dim-btn-active" : "")}
            onClick=${() => onSinceChange(p)}
          >${p}</button>
        `)}
      </div>

      ${isEmpty
        ? html`
          <div class="card" style="cursor: default;">
            <div class="muted" style="font-style: italic;">No compression data yet. Agents will report compression stats as they run.</div>
          </div>
        `
        : html`
          <${CompressionHealth} summary=${summary} />
          <${CompressionTimeseries} data=${timeSeries} since=${since} />
          <${CompressionBreakdown} data=${byRole} />
          <${CompressionMethods} data=${methods} />
        `
      }
    </section>
  `;
}

function CompressionHealth({ summary }) {
  if (!summary) return null;
  const tokensSaved = fmtTokens(summary.bytesSaved);
  const dollarsSaved = fmtDollars(summary.bytesSaved);
  const ratioPercent = summary.avgCompressionRatio > 0
    ? (summary.avgCompressionRatio * 100).toFixed(1)
    : null;
  const compressedPct = summary.totalEvents > 0
    ? ((summary.agentCompressed / summary.totalEvents) * 100).toFixed(0)
    : "0";

  return html`
    <div class="compression-health">
      <div class="row" style="gap: 16px; flex-wrap: wrap; margin-bottom: 16px;">
        <div class="card stat" style="cursor: default; min-width: 180px;">
          <div class="stat-num">${tokensSaved}</div>
          <div class="muted">tokens saved (~${dollarsSaved} avoided)</div>
        </div>
        ${ratioPercent ? html`
          <div class="card stat" style="cursor: default; min-width: 140px;">
            <div class="stat-num">${ratioPercent}%</div>
            <div class="muted">avg compression ratio</div>
          </div>
        ` : null}
        <div class="card stat" style="cursor: default; min-width: 180px;">
          <div class="stat-num">${summary.agentCompressed} / ${summary.totalEvents}</div>
          <div class="muted">tasks compressed (${compressedPct}%)</div>
        </div>
        ${summary.bytesSaved > 0 ? html`
          <div class="card stat" style="cursor: default; min-width: 140px;">
            <div class="stat-num">${fmtBytes(summary.bytesSaved)}</div>
            <div class="muted">bytes saved</div>
          </div>
        ` : null}
      </div>
    </div>
  `;
}

function CompressionTimeseries({ data, since }) {
  if (!data || data.length === 0) return null;

  const VW = 1000;
  const VH = 120;
  const PAD_TOP = 16;
  const PAD_BOTTOM = 24;
  const chartH = VH - PAD_TOP - PAD_BOTTOM;

  const values = data.map(r => r.bytesSaved);
  const maxV = Math.max(...values, 1);
  const n = values.length;

  const xs = values.map((_, i) => n === 1 ? VW / 2 : Math.round((i / (n - 1)) * VW));
  const ys = values.map(v => PAD_TOP + chartH - Math.round((v / maxV) * chartH));
  const pt = (i) => `${xs[i]},${ys[i]}`;

  const todayStr = new Date().toISOString().slice(0, 10);
  const lastPartial = data[n - 1].date === todayStr;
  const solidEnd = lastPartial && n >= 2 ? n - 2 : n - 1;

  const solidPts = xs.slice(0, solidEnd + 1).map((_, i) => pt(i)).join(" L ");
  const linePath = `M ${solidPts}`;
  const dashPath = lastPartial && n >= 2 ? `M ${pt(n - 2)} L ${pt(n - 1)}` : null;
  const areaPath = `M ${xs[0]},${VH - PAD_BOTTOM} L ${solidPts} L ${xs[solidEnd]},${VH - PAD_BOTTOM} Z`;

  const peakIdx = values.indexOf(Math.max(...values));

  const LABEL_ALL_MAX = 10;
  const labelIdxs = n <= LABEL_ALL_MAX
    ? values.map((_, i) => i)
    : [...new Set([0, peakIdx, n - 1])].sort((a, b) => a - b);

  const labels = labelIdxs.map(i => {
    const isPartial = i === n - 1 && lastPartial;
    const isPeak = i === peakIdx;
    return {
      x: xs[i], y: ys[i],
      date: isPartial ? "today" : shortDay(data[i].date),
      value: values[i], isPeak, isPartial,
      showValue: isPeak || isPartial || (n > LABEL_ALL_MAX && (i === 0 || i === n - 1)),
    };
  });

  return html`
    <div class="usage-timeseries" style="margin-bottom: 16px;">
      <div class="usage-timeseries-title">bytes saved per day (${since})</div>
      <div style="font-size: 11px; color: var(--fg-faint); margin-top: 2px; margin-bottom: 6px;">
        Compression bytes saved each day.${lastPartial ? " Today is dashed — partial day, data incomplete." : ""}
      </div>
      <svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet">
        <path d=${areaPath} fill="rgba(74,222,128,0.10)" />
        <path d=${linePath} fill="none" stroke="var(--ok)" stroke-width="1.5" />
        ${dashPath ? html`<path d=${dashPath} fill="none" stroke="var(--ok)" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.7" />` : null}
        <text x="4" y=${PAD_TOP - 2} text-anchor="start" font-size="10" fill="var(--fg-faint)">peak: ${fmtBytes(maxV)}</text>
        ${labels.map(l => {
          const anchor = l.x < VW * 0.15 ? "start" : l.x > VW * 0.85 ? "end" : "middle";
          return html`
            <circle cx=${l.x} cy=${l.y} r="3"
              fill=${l.isPartial ? "var(--bg-elev)" : "var(--ok)"}
              stroke="var(--ok)" stroke-width=${l.isPartial ? 1.5 : 0} />
            <text x=${l.x} y=${VH - 4} text-anchor=${anchor} font-size="11" fill="var(--fg-faint)">${l.date}</text>
            ${l.showValue
              ? html`<text x=${l.x} y=${l.y - 7} text-anchor=${anchor} font-size="11" fill=${l.isPeak ? "var(--ok)" : "var(--fg-faint)"}>${fmtBytes(l.value)}</text>`
              : null
            }
          `;
        })}
      </svg>
    </div>
  `;
}

function CompressionBreakdown({ data }) {
  const [sortBy, setSortBy] = useState("bytesSaved");
  if (!data || data.length === 0) return null;

  const sorted = [...data].sort((a, b) => {
    if (sortBy === "ratio") return b.avgCompressionRatio - a.avgCompressionRatio;
    return b.bytesSaved - a.bytesSaved;
  });

  return html`
    <div class="card" style="cursor: default; margin-bottom: 12px;">
      <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 12px;">
        <h3 style="margin: 0;">By Agent Role</h3>
        <div style="display: flex; gap: 6px; align-items: center;">
          <span class="muted" style="font-size: 11px;">sort:</span>
          ${["bytesSaved", "ratio"].map(s => html`
            <button
              class=${"usage-dim-btn " + (sortBy === s ? "usage-dim-btn-active" : "")}
              onClick=${() => setSortBy(s)}
            >${s === "bytesSaved" ? "bytes saved" : "ratio"}</button>
          `)}
        </div>
      </div>
      <table class="compression-table">
        <thead>
          <tr>
            <th>agent role</th>
            <th style="text-align: right;">tasks compressed</th>
            <th style="text-align: right;">bytes saved</th>
            <th style="text-align: right;">avg ratio</th>
          </tr>
        </thead>
        <tbody>
          ${sorted.map(row => html`
            <tr key=${row.agentRole}>
              <td class="mono">${row.agentRole}</td>
              <td style="text-align: right;">${row.agentCompressed} / ${row.events}</td>
              <td style="text-align: right; font-family: ui-monospace, 'SF Mono', Menlo, monospace;">${fmtBytes(row.bytesSaved)}</td>
              <td style="text-align: right;">${row.avgCompressionRatio > 0 ? (row.avgCompressionRatio * 100).toFixed(1) + "%" : "—"}</td>
            </tr>
          `)}
        </tbody>
      </table>
    </div>
  `;
}

function CompressionMethods({ data }) {
  if (!data || data.length === 0) return null;
  const total = data.reduce((s, r) => s + r.count, 0);
  const maxCount = Math.max(1, ...data.map(r => r.count));

  return html`
    <div class="card" style="cursor: default; margin-bottom: 12px;">
      <h3 style="margin: 0 0 12px;">Method Distribution</h3>
      ${data.map(row => html`
        <div class="row" style="gap: 10px; align-items: center; padding: 3px 0;" key=${row.method}>
          <span class="mono" style="min-width: 160px; font-size: 12px;">${row.method}</span>
          <div style="flex: 1; background: var(--bg2, #1a1a1a); height: 14px; border-radius: 3px; overflow: hidden;">
            <div style="width: ${(row.count / maxCount * 100).toFixed(0)}%; height: 100%; background: var(--ok);"></div>
          </div>
          <span class="muted" style="min-width: 60px; text-align: right; font-size: 12px;">${row.count} (${total > 0 ? ((row.count / total) * 100).toFixed(0) : 0}%)</span>
        </div>
      `)}
    </div>
  `;
}

function ProxyHealthBanner({ stats, telemetry }) {
  if (!stats || !stats.requests) return null;

  const tokensSaved = stats.tokens?.saved || 0;
  const savingsPercent = stats.tokens?.savings_percent || 0;
  const ccrEntries = stats.compression?.ccr_entries || 0;
  const ccrRetrievals = stats.compression?.ccr_retrievals || 0;
  const totalCompressions = telemetry?.total_compressions || 0;
  const avgRatio = telemetry?.avg_compression_ratio || 0;

  return html`
    <div class="card" style="cursor: default; margin-bottom: 16px; background: var(--bg-elev-2); border-left: 3px solid var(--ok);">
      <div style="display: flex; gap: 12px; align-items: center; margin-bottom: 8px;">
        <span style="font-weight: 600; font-size: 13px;">🚀 Headroom Proxy Live</span>
        <span class="muted" style="font-size: 11px;">localhost:8787</span>
      </div>
      <div style="display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 12px;">
        <div>
          <div class="muted" style="font-size: 11px;">Tokens Saved</div>
          <div style="font-size: 16px; font-family: ui-monospace, 'SF Mono', Menlo, monospace;">${tokensSaved.toLocaleString()}</div>
        </div>
        <div>
          <div class="muted" style="font-size: 11px;">Savings</div>
          <div style="font-size: 16px;">${savingsPercent.toFixed(1)}%</div>
        </div>
        <div>
          <div class="muted" style="font-size: 11px;">Compressions</div>
          <div style="font-size: 16px;">${totalCompressions}</div>
        </div>
        <div>
          <div class="muted" style="font-size: 11px;">Avg Ratio</div>
          <div style="font-size: 16px;">${avgRatio > 0 ? (avgRatio * 100).toFixed(1) + "%" : "—"}</div>
        </div>
        <div>
          <div class="muted" style="font-size: 11px;">CCR Entries</div>
          <div style="font-size: 16px;">${ccrEntries}</div>
        </div>
        <div>
          <div class="muted" style="font-size: 11px;">CCR Retrievals</div>
          <div style="font-size: 16px;">${ccrRetrievals}</div>
        </div>
      </div>
    </div>
  `;
}
