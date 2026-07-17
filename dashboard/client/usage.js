// Usage view — token/cache analytics from model_calls.

import { h } from "https://esm.sh/preact@10.24.0";
import { useState } from "https://esm.sh/preact@10.24.0/hooks";
import htm from "https://esm.sh/htm@3.1.1";
import { UsageLimits } from "./usage-limits.js";

const html = htm.bind(h);

const DIMS = ["project", "workflow", "role", "model", "alias"];
const PERIODS = ["7d", "14d", "30d", "90d"];

function weighted(row) {
  return (row.inputTokens ?? 0)
    + 1.25 * (row.cacheCreationTokens ?? 0)
    + 0.1  * (row.cacheReadTokens ?? 0)
    + 5    * (row.outputTokens ?? 0);
}

function fmtK(n) {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + "M";
  if (n >= 1_000)     return (n / 1_000).toFixed(1) + "K";
  return String(Math.round(n));
}

// "2026-05-27" -> "5/27". String-split, no Date parsing (avoids UTC/local drift).
function shortDay(iso) {
  const p = String(iso).split("-");
  return p.length === 3 ? `${+p[1]}/${+p[2]}` : String(iso);
}

export function UsageView({ rollup, timeSeries, modelMix, groupBy, onGroupByChange, since, onSinceChange, planUsage, planUsageLoading, planUsageRefreshing, planUsageRefreshError, onRefreshPlanUsage }) {
  const [showFormula, setShowFormula] = useState(false);
  const now = Date.now();
  const days = parseInt(since);
  const periodMs = days * 86400_000;

  const lastN  = timeSeries.filter(r => now - new Date(r.date).getTime() <= periodMs);
  const priorN = timeSeries.filter(r => {
    const age = now - new Date(r.date).getTime();
    return age > periodMs && age <= 2 * periodMs;
  });

  const sumN      = lastN.reduce((a, r) => a + weighted(r), 0);
  const sumPriorN = priorN.reduce((a, r) => a + weighted(r), 0);

  const totalCacheReadN     = lastN.reduce((a, r) => a + (r.cacheReadTokens ?? 0), 0);
  const totalInputN         = lastN.reduce((a, r) => a + (r.inputTokens ?? 0), 0);
  const totalCacheCreationN = lastN.reduce((a, r) => a + (r.cacheCreationTokens ?? 0), 0);
  const cacheHitRate        = totalInputN + totalCacheReadN + totalCacheCreationN > 0
    ? (totalCacheReadN / (totalCacheReadN + totalInputN + totalCacheCreationN)) * 100
    : 0;
  const totalReqsN = lastN.reduce((a, r) => a + (r.requests ?? 0), 0);

  let deltaEl = null;
  if (sumPriorN > 0) {
    const pct    = ((sumN - sumPriorN) / sumPriorN) * 100;
    const better = pct < 0;
    const sign   = pct > 0 ? "↑" : "↓";
    deltaEl = html`<div class=${"usage-headline-delta " + (better ? "usage-delta-better" : "usage-delta-worse")}>
      ${sign} ${Math.abs(pct).toFixed(0)}% vs prior ${since}
    </div>`;
  } else if (sumN === 0) {
    deltaEl = html`<div class="usage-headline-delta usage-delta-same">no data</div>`;
  }

  const cacheQuality = cacheHitRate >= 80 ? "better" : cacheHitRate >= 50 ? "same" : "worse";
  const cacheLabel   = cacheHitRate >= 80 ? "good" : cacheHitRate >= 50 ? "fair" : "low";

  const maxW = rollup.reduce((m, r) => Math.max(m, weighted(r)), 0);

  const mixByBucket = new Map((modelMix ?? []).map(b => [b.bucket, b.models]));

  const [expandedBucket, setExpandedBucket] = useState(null);
  const toggleBucket = (name) => setExpandedBucket(prev => prev === name ? null : name);

  return html`
    <section class="usage-section">
      <${UsageLimits}
        data=${planUsage}
        loading=${planUsageLoading}
        refreshing=${planUsageRefreshing}
        refreshError=${planUsageRefreshError}
        onRefresh=${onRefreshPlanUsage}
      />
      <div class="usage-analytics-heading">
        <div class="plan-usage-kicker">forge activity</div>
        <h2>Token & cache analytics</h2>
      </div>
      <div class="usage-headline">
        <div class="usage-headline-card">
          <div class="usage-headline-label">weighted tokens (${since})</div>
          <div class="usage-headline-value" title="input + 1.25× cache_create + 0.1× cache_read + 5× output_tokens">${fmtK(sumN)}</div>
          ${deltaEl}
        </div>
        <div class="usage-headline-card">
          <div class="usage-headline-label">cache hit rate (${since})</div>
          <div class="usage-headline-value">${cacheHitRate.toFixed(1)}%</div>
          <div class=${"usage-headline-delta usage-delta-" + cacheQuality}>${cacheLabel}</div>
        </div>
        <div class="usage-headline-card">
          <div class="usage-headline-label">requests (${since})</div>
          <div class="usage-headline-value">${fmtK(totalReqsN)}</div>
        </div>
      </div>

      <div class="usage-dim-selector">
        ${DIMS.map(d => html`
          <button
            class=${"usage-dim-btn " + (groupBy === d ? "usage-dim-btn-active" : "")}
            onClick=${() => onGroupByChange(d)}
          >${d}</button>
        `)}
        <span style="margin: 0 8px; opacity: 0.3;">|</span>
        ${PERIODS.map(p => html`
          <button
            class=${"usage-dim-btn " + (since === p ? "usage-dim-btn-active" : "")}
            onClick=${() => onSinceChange(p)}
          >${p}</button>
        `)}
      </div>

      <div class="usage-rollup-header" style="margin-bottom: 8px;">
        <div style="font-size: 13px; font-weight: 500;">Weighted tokens by ${groupBy}</div>
        <span
          onClick=${() => setShowFormula(s => !s)}
          style="font-size: 12px; color: var(--fg-dim); cursor: pointer; user-select: none; text-decoration: underline; text-decoration-style: dotted; text-underline-offset: 3px;"
        >ℹ what are weighted tokens?</span>
        ${showFormula && html`
          <div style="margin-top: 8px; padding: 12px 16px; background: var(--bg-elev); border: 1px solid var(--border); border-radius: 8px; font-size: 12px;">
            <table style="border-collapse: collapse; width: 100%; margin-bottom: 10px;">
              <thead>
                <tr style="text-align: left; color: var(--fg-faint); font-size: 11px;">
                  <th style="padding: 4px 12px 4px 0; font-weight: 500;">Token type</th>
                  <th style="padding: 4px 12px 4px 0; font-weight: 500;">Multiplier</th>
                  <th style="padding: 4px 0; font-weight: 500;">Meaning</th>
                </tr>
              </thead>
              <tbody>
                <tr>
                  <td style="padding: 3px 12px 3px 0;">input</td>
                  <td style="padding: 3px 12px 3px 0;">1×</td>
                  <td style="padding: 3px 0; color: var(--fg-faint);">Fresh tokens sent to the model</td>
                </tr>
                <tr>
                  <td style="padding: 3px 12px 3px 0;">cache creation</td>
                  <td style="padding: 3px 12px 3px 0;">1.25×</td>
                  <td style="padding: 3px 0; color: var(--fg-faint);">25% more than input — you pay to store it</td>
                </tr>
                <tr>
                  <td style="padding: 3px 12px 3px 0;">cache read</td>
                  <td style="padding: 3px 12px 3px 0;">0.1×</td>
                  <td style="padding: 3px 0; color: var(--fg-faint);">90% cheaper than input — the payoff of caching</td>
                </tr>
                <tr>
                  <td style="padding: 3px 12px 3px 0;">output</td>
                  <td style="padding: 3px 12px 3px 0;">5×</td>
                  <td style="padding: 3px 0; color: var(--fg-faint);">~5× more expensive than input across providers</td>
                </tr>
              </tbody>
            </table>
            <div style="font-family: monospace; font-size: 11px; color: var(--fg-faint); margin-bottom: 8px;">
              weighted = input + 1.25 × cache_create + 0.1 × cache_read + 5 × output
            </div>
            <div style="font-size: 11px; color: var(--fg-faint);">
              Weighted tokens are a unitless proxy for relative cost. No dollar amounts — OAuth users have no per-token cost.
            </div>
          </div>
        `}
      </div>

      <div class="usage-rollup">
        ${rollup.length === 0
          ? html`<div class="muted" style="padding: 16px 0;">No usage data for this period.</div>`
          : rollup.map(r => html`<${UsageRow} key=${r.bucket} row=${r} maxW=${maxW} isExpanded=${expandedBucket === r.bucket} onToggle=${toggleBucket} modelModels=${mixByBucket.get(r.bucket) ?? []} />`)
        }
      </div>

      <${SparkLine} data=${lastN} since=${since} />
    </section>
  `;
}

function modelColor(model) {
  if (model.includes("opus"))   return "#9d7aff";
  if (model.includes("sonnet")) return "#7a9fff";
  if (model.includes("haiku"))  return "#4ade80";
  return "var(--fg-dim)";
}

function shortModel(model) {
  return model.replace(/^claude-/, "");
}

function UsageRow({ row, maxW, isExpanded, onToggle, modelModels }) {
  const w           = weighted(row);
  const barPct      = maxW > 0 ? (w / maxW) * 100 : 0;
  const cacheRead   = row.cacheReadTokens ?? 0;
  const cacheCreate = row.cacheCreationTokens ?? 0;
  const input       = row.inputTokens ?? 0;
  const output      = row.outputTokens ?? 0;
  const hitRate     = input + cacheRead + cacheCreate > 0 ? (cacheRead / (cacheRead + input + cacheCreate)) * 100 : 0;
  const reuseRatio  = cacheCreate > 0 ? cacheRead / cacheCreate : Infinity;

  const cacheClass = hitRate >= 80 ? "usage-cache-good" : hitRate >= 50 ? "usage-cache-mid" : "usage-cache-bad";
  const label = row.bucket.startsWith("/") ? row.bucket.split("/").pop() : row.bucket;

  const tokenTypes = [
    { name: "input",          raw: input,       weight: 1,    color: "var(--fg-dim)" },
    { name: "cache creation", raw: cacheCreate,  weight: 1.25, color: "var(--warn)"   },
    { name: "cache read",     raw: cacheRead,    weight: 0.1,  color: "var(--ok)"     },
    { name: "output",         raw: output,       weight: 5,    color: "var(--accent)" },
  ];
  const contribs   = tokenTypes.map(t => t.raw * t.weight);
  const maxContrib = Math.max(...contribs, 1);

  return html`
    <div class="usage-row-wrap">
      <div class="usage-row" onClick=${() => onToggle(row.bucket)}>
        <div class="usage-bucket" title=${row.bucket}>
          <span style="margin-right: 4px; font-size: 10px;">${isExpanded ? "▾" : "▸"}</span>${label}
        </div>
        <div class="usage-bar-wrap">
          <div class="usage-bar" style=${{ width: barPct + "%" }} title=${`${fmtK(w)} weighted tokens`}></div>
        </div>
        <div>
          <span class=${"usage-cache-badge " + cacheClass} title=${`Cache hit rate: ${hitRate.toFixed(0)}% of input tokens served from cache`}>${hitRate.toFixed(0)}% cache</span>
          ${reuseRatio < 5 && cacheCreate > 0
            ? html`<span class="usage-reuse-warn" title=${`Low cache reuse: ${reuseRatio.toFixed(1)}× reads per cache creation (healthy ≥ 5×)`}>⚠ ${reuseRatio.toFixed(1)}x reuse</span>`
            : null}
        </div>
        <div class="usage-req-count">${fmtK(row.requests)} requests</div>
      </div>
      <div class="usage-detail" style=${{ maxHeight: isExpanded ? "400px" : "0" }}>
        <div style="padding: 8px 0 4px;">
          ${tokenTypes.map((t, i) => {
            const contrib = contribs[i];
            const pct     = (contrib / maxContrib) * 100;
            return html`
              <div style="display: flex; align-items: center; gap: 8px; margin-bottom: 5px;">
                <div style="width: 110px; font-size: 11px; color: var(--fg-dim); flex-shrink: 0;">${t.name}</div>
                <div class="usage-bar-wrap" style="flex: 1;">
                  <div class="usage-bar" style=${{ width: pct + "%", background: t.color }}></div>
                </div>
                <div style="font-size: 11px; color: var(--fg-faint); white-space: nowrap; flex-shrink: 0;">${fmtK(t.raw)} tokens → ${fmtK(contrib)} weighted</div>
              </div>
            `;
          })}
        </div>
        ${modelModels.length > 0 && html`
          <div style="border-top: 1px solid var(--border); padding-top: 8px; margin-top: 2px;">
            <div style="font-size: 11px; color: var(--fg-faint); margin-bottom: 6px;">model mix</div>
            <div style="display: flex; height: 8px; border-radius: 3px; overflow: hidden; margin-bottom: 6px;">
              ${(() => {
                const total = modelModels.reduce((s, m) => s + m.weightedTokens, 0);
                return modelModels.map(m => html`
                  <div
                    style=${{ width: (total > 0 ? (m.weightedTokens / total) * 100 : 0) + "%", background: modelColor(m.model), flexShrink: 0 }}
                    title=${shortModel(m.model) + ": " + (total > 0 ? ((m.weightedTokens / total) * 100).toFixed(0) : 0) + "%"}
                  ></div>
                `);
              })()}
            </div>
            <div style="font-size: 11px; color: var(--fg-faint); flex-wrap: wrap; display: flex; gap: 0;">
              ${(() => {
                const total = modelModels.reduce((s, m) => s + m.weightedTokens, 0);
                return modelModels.map((m, i) => html`
                  <span>
                    <span style=${{ color: modelColor(m.model) }}>${shortModel(m.model)}</span>: ${total > 0 ? ((m.weightedTokens / total) * 100).toFixed(0) : 0}% (${fmtK(m.requests)} req)${i < modelModels.length - 1 ? " · " : ""}
                  </span>
                `);
              })()}
            </div>
          </div>
        `}
      </div>
    </div>
  `;
}

function SparkLine({ data, since }) {
  if (data.length === 0) {
    return html`
      <div class="usage-timeseries">
        <div class="muted" style="padding: 8px 0;">No time series data.</div>
      </div>
    `;
  }

  const VW = 1000;
  const VH = 120;
  const PAD_TOP    = 16;
  const PAD_BOTTOM = 24;
  const chartH = VH - PAD_TOP - PAD_BOTTOM;

  const values = data.map(r => weighted(r));
  const maxV   = Math.max(...values, 1);
  const n      = values.length;

  const xs = values.map((_, i) => n === 1 ? VW / 2 : Math.round((i / (n - 1)) * VW));
  const ys = values.map(v  => PAD_TOP + chartH - Math.round((v / maxV) * chartH));
  const pt = (i) => `${xs[i]},${ys[i]}`;

  // The trailing day is "partial" only when it's actually today — its tally is
  // still accumulating, so a straight line down to it reads as a fake decline.
  // Draw that last segment dashed and its point hollow so it's clearly not a
  // complete day. data dates are UTC (date(created_at)); compare in that basis.
  const todayStr    = new Date().toISOString().slice(0, 10);
  const lastPartial = data[n - 1].date === todayStr;
  const solidEnd    = lastPartial && n >= 2 ? n - 2 : n - 1; // last index of the complete-day line

  const solidPts = xs.slice(0, solidEnd + 1).map((_, i) => pt(i)).join(" L ");
  const linePath = `M ${solidPts}`;
  const dashPath = lastPartial && n >= 2 ? `M ${pt(n - 2)} L ${pt(n - 1)}` : null;
  // Area fills under complete days only — the partial day gets no "volume".
  const areaPath = `M ${xs[0]},${VH - PAD_BOTTOM} L ${solidPts} L ${xs[solidEnd]},${VH - PAD_BOTTOM} Z`;

  const peakIdx = values.indexOf(Math.max(...values));

  // With only a handful of days, label every point (compact M/D) — the old
  // first/last/peak thinning made a middle day look "missing". Past ~10 days,
  // fall back to first/last/peak so the axis doesn't crowd.
  const LABEL_ALL_MAX = 10;
  const labelIdxs = n <= LABEL_ALL_MAX
    ? values.map((_, i) => i)
    : [...new Set([0, peakIdx, n - 1])].sort((a, b) => a - b);

  const labels = labelIdxs.map(i => {
    const isPartial = i === n - 1 && lastPartial;
    const isPeak    = i === peakIdx;
    return {
      x: xs[i], y: ys[i],
      date: isPartial ? "today" : shortDay(data[i].date),
      value: values[i], isPeak, isPartial,
      // Value labels stay sparse to avoid clutter: peak + today always; first/last only in the thinned view.
      showValue: isPeak || isPartial || (n > LABEL_ALL_MAX && (i === 0 || i === n - 1)),
    };
  });

  return html`
    <div class="usage-timeseries">
      <div class="usage-timeseries-title">weighted tokens per day (${since})</div>
      <div style="font-size: 11px; color: var(--fg-faint); margin-top: 2px; margin-bottom: 6px;">Total weighted tokens generated each day across all projects. Trend line shows whether your token usage is increasing or decreasing.${lastPartial ? " Today is dashed — partial day, data incomplete." : ""}</div>
      <svg viewBox="0 0 ${VW} ${VH}" preserveAspectRatio="xMidYMid meet">
        <path d=${areaPath} fill="rgba(122,159,255,0.12)" />
        <path d=${linePath} fill="none" stroke="var(--accent)" stroke-width="1.5" />
        ${dashPath ? html`<path d=${dashPath} fill="none" stroke="var(--accent)" stroke-width="1.5" stroke-dasharray="4 4" opacity="0.7" />` : null}
        <text x="4" y=${PAD_TOP - 2} text-anchor="start" font-size="10" fill="var(--fg-faint)">peak: ${fmtK(maxV)}</text>
        ${labels.map(l => {
          const anchor = l.x < VW * 0.15 ? "start" : l.x > VW * 0.85 ? "end" : "middle";
          return html`
            <circle cx=${l.x} cy=${l.y} r="3"
              fill=${l.isPartial ? "var(--bg-elev)" : "var(--accent)"}
              stroke="var(--accent)" stroke-width=${l.isPartial ? 1.5 : 0} />
            <text x=${l.x} y=${VH - 4} text-anchor=${anchor} font-size="11" fill="var(--fg-faint)">${l.date}</text>
            ${l.showValue
              ? html`<text x=${l.x} y=${l.y - 7} text-anchor=${anchor} font-size="11" fill=${l.isPeak ? "var(--accent)" : "var(--fg-faint)"}>${fmtK(l.value)}</text>`
              : null
            }
          `;
        })}
      </svg>
    </div>
  `;
}
