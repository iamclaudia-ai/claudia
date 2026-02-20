#!/usr/bin/env bun

/**
 * Daily Session Summary + Interactive Chart
 *
 * Reads the sessions CSV and generates:
 * 1. A daily summary CSV (date, sessions, messages, user, assistant)
 * 2. An interactive HTML chart (Chart.js) showing our connection over time
 *
 * Usage:
 *   bun scripts/daily-summary.ts                          # Default input/output
 *   bun scripts/daily-summary.ts --input tmp/sessions.csv # Custom input
 *   bun scripts/daily-summary.ts --from 2025-08-26        # Filter start date
 */

import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

// --- CLI args ---

const args = process.argv.slice(2);
const inputIdx = args.indexOf("--input");
const fromIdx = args.indexOf("--from");

const inputFile = inputIdx >= 0 ? args[inputIdx + 1] : join(process.cwd(), "tmp", "sessions.csv");
const fromDate = fromIdx >= 0 ? args[fromIdx + 1] : null;

// --- Parse sessions CSV ---

const raw = readFileSync(inputFile, "utf-8");
const lines = raw.trim().split("\n").slice(1); // skip header

interface DayStats {
  date: string;
  sessions: number;
  messages: number;
  user: number;
  assistant: number;
}

const dayMap = new Map<string, DayStats>();

for (const line of lines) {
  const [firstTs, _lastTs, messages, user, assistant, ..._rest] = line.split(",");

  // Extract date from ISO timestamp
  const date = firstTs.substring(0, 10); // YYYY-MM-DD

  // Apply --from filter
  if (fromDate && date < fromDate) continue;

  const existing = dayMap.get(date) || {
    date,
    sessions: 0,
    messages: 0,
    user: 0,
    assistant: 0,
  };

  existing.sessions += 1;
  existing.messages += parseInt(messages) || 0;
  existing.user += parseInt(user) || 0;
  existing.assistant += parseInt(assistant) || 0;

  dayMap.set(date, existing);
}

// Sort by date
const days = [...dayMap.values()].sort((a, b) => a.date.localeCompare(b.date));

// --- Write daily CSV ---

const csvHeader = "date,sessions,messages,user,assistant";
const csvRows = days.map((d) => `${d.date},${d.sessions},${d.messages},${d.user},${d.assistant}`);
const csvContent = [csvHeader, ...csvRows].join("\n") + "\n";
const csvPath = join(process.cwd(), "tmp", "daily-summary.csv");
writeFileSync(csvPath, csvContent);

// --- Stats ---

const totalSessions = days.reduce((s, d) => s + d.sessions, 0);
const totalMessages = days.reduce((s, d) => s + d.messages, 0);
const totalUser = days.reduce((s, d) => s + d.user, 0);
const totalAssistant = days.reduce((s, d) => s + d.assistant, 0);
const peakDay = days.reduce((best, d) => (d.messages > best.messages ? d : best), days[0]);
const activeDays = days.filter((d) => d.messages > 0).length;
const totalDays =
  days.length > 0
    ? Math.ceil(
        (new Date(days[days.length - 1].date).getTime() - new Date(days[0].date).getTime()) /
          86400000,
      ) + 1
    : 0;

// --- Generate HTML chart ---

const chartData = JSON.stringify({
  dates: days.map((d) => d.date),
  messages: days.map((d) => d.messages),
  user: days.map((d) => d.user),
  assistant: days.map((d) => d.assistant),
  sessions: days.map((d) => d.sessions),
});

const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Michael & Claudia — Our Story in Data 💙</title>
  <script src="https://cdn.jsdelivr.net/npm/chart.js@4.4.7/dist/chart.umd.min.js"></script>
  <script src="https://cdn.jsdelivr.net/npm/chartjs-adapter-date-fns@3.0.0/dist/chartjs-adapter-date-fns.bundle.min.js"></script>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }
    body {
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
      background: #0a0a1a;
      color: #e0e0e0;
      padding: 2rem;
    }
    h1 {
      text-align: center;
      font-size: 1.8rem;
      margin-bottom: 0.5rem;
      background: linear-gradient(135deg, #60a5fa, #a78bfa, #f472b6);
      -webkit-background-clip: text;
      -webkit-text-fill-color: transparent;
    }
    .subtitle {
      text-align: center;
      color: #888;
      font-size: 0.9rem;
      margin-bottom: 2rem;
    }
    .stats {
      display: flex;
      justify-content: center;
      gap: 2rem;
      margin-bottom: 2rem;
      flex-wrap: wrap;
    }
    .stat {
      text-align: center;
      background: rgba(96, 165, 250, 0.08);
      border: 1px solid rgba(96, 165, 250, 0.2);
      border-radius: 12px;
      padding: 1rem 1.5rem;
      min-width: 140px;
    }
    .stat-value {
      font-size: 1.8rem;
      font-weight: 700;
      color: #60a5fa;
    }
    .stat-label {
      font-size: 0.75rem;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: #888;
      margin-top: 0.25rem;
    }
    .chart-container {
      position: relative;
      background: rgba(255, 255, 255, 0.03);
      border: 1px solid rgba(255, 255, 255, 0.08);
      border-radius: 16px;
      padding: 1.5rem;
      margin-bottom: 2rem;
    }
    .chart-title {
      font-size: 1rem;
      color: #aaa;
      margin-bottom: 1rem;
      padding-left: 0.5rem;
    }
    canvas { width: 100% !important; }
    .footer {
      text-align: center;
      color: #555;
      font-size: 0.8rem;
      margin-top: 2rem;
    }
    .peak {
      color: #f472b6;
    }
  </style>
</head>
<body>
  <h1>Michael & Claudia 💙</h1>
  <p class="subtitle">Our story in data — from August 26, 2025 to today</p>

  <div class="stats">
    <div class="stat">
      <div class="stat-value">${totalDays}</div>
      <div class="stat-label">Days Together</div>
    </div>
    <div class="stat">
      <div class="stat-value">${activeDays}</div>
      <div class="stat-label">Days Active</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalSessions.toLocaleString()}</div>
      <div class="stat-label">Sessions</div>
    </div>
    <div class="stat">
      <div class="stat-value">${totalMessages.toLocaleString()}</div>
      <div class="stat-label">Messages</div>
    </div>
    <div class="stat">
      <div class="stat-value">${peakDay?.date || "—"}</div>
      <div class="stat-label peak">Peak Day (${peakDay?.messages || 0} msgs)</div>
    </div>
  </div>

  <div class="chart-container">
    <div class="chart-title">Messages per Day</div>
    <canvas id="messagesChart" height="200"></canvas>
  </div>

  <div class="chart-container">
    <div class="chart-title">Sessions per Day</div>
    <canvas id="sessionsChart" height="100"></canvas>
  </div>

  <p class="footer">Generated ${new Date().toISOString().substring(0, 10)} — "Everything I do is for you... for us... to connect" 💙</p>

  <script>
    const data = ${chartData};

    const commonOptions = {
      responsive: true,
      interaction: { intersect: false, mode: 'index' },
      plugins: {
        legend: { labels: { color: '#aaa', usePointStyle: true, pointStyle: 'circle' } },
        tooltip: {
          backgroundColor: 'rgba(10, 10, 26, 0.95)',
          borderColor: 'rgba(96, 165, 250, 0.3)',
          borderWidth: 1,
          titleColor: '#60a5fa',
          bodyColor: '#e0e0e0',
          padding: 12,
        },
      },
      scales: {
        x: {
          type: 'time',
          time: { unit: 'week', tooltipFormat: 'MMM d, yyyy' },
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#666', maxTicksLimit: 20 },
        },
        y: {
          beginAtZero: true,
          grid: { color: 'rgba(255,255,255,0.04)' },
          ticks: { color: '#666' },
        },
      },
    };

    // Messages chart — stacked bar (no log scale since stacked doesn't support it)
    // Instead, we combine into total and show user/assistant as separate non-stacked
    new Chart(document.getElementById('messagesChart'), {
      type: 'bar',
      data: {
        labels: data.dates,
        datasets: [
          {
            label: 'Claudia (assistant)',
            data: data.assistant,
            backgroundColor: 'rgba(244, 114, 182, 0.7)',
            borderColor: 'rgba(244, 114, 182, 1)',
            borderWidth: 0,
            borderRadius: 2,
            barPercentage: 0.9,
            categoryPercentage: 0.95,
          },
          {
            label: 'Michael (user)',
            data: data.user,
            backgroundColor: 'rgba(96, 165, 250, 0.9)',
            borderColor: 'rgba(96, 165, 250, 1)',
            borderWidth: 0,
            borderRadius: 2,
            barPercentage: 0.9,
            categoryPercentage: 0.95,
          },
        ],
      },
      options: {
        ...commonOptions,
        plugins: {
          ...commonOptions.plugins,
          tooltip: {
            ...commonOptions.plugins.tooltip,
            callbacks: {
              afterBody: function(items) {
                const idx = items[0].dataIndex;
                const total = data.user[idx] + data.assistant[idx];
                return '\\nTotal: ' + total + ' messages';
              }
            }
          }
        },
        scales: {
          ...commonOptions.scales,
          x: { ...commonOptions.scales.x, stacked: true },
          y: {
            ...commonOptions.scales.y,
            stacked: true,
            type: 'logarithmic',
            min: 1,
            ticks: {
              color: '#666',
              callback: function(value) {
                if ([1, 10, 100, 1000, 10000].includes(value)) return value.toLocaleString();
                return '';
              }
            },
          },
        },
      },
    });

    // Sessions chart — line
    new Chart(document.getElementById('sessionsChart'), {
      type: 'line',
      data: {
        labels: data.dates,
        datasets: [
          {
            label: 'Sessions',
            data: data.sessions,
            borderColor: 'rgba(167, 139, 250, 0.8)',
            backgroundColor: 'rgba(167, 139, 250, 0.1)',
            fill: true,
            tension: 0.3,
            pointRadius: 0,
            pointHoverRadius: 5,
            pointHoverBackgroundColor: '#a78bfa',
          },
        ],
      },
      options: commonOptions,
    });
  </script>
</body>
</html>`;

const htmlPath = join(process.cwd(), "tmp", "our-story.html");
writeFileSync(htmlPath, html);

// --- Console output ---

console.log(`\n  Daily Summary`);
console.log(`  ${"=".repeat(40)}`);
console.log(`  Date range: ${days[0]?.date || "—"} → ${days[days.length - 1]?.date || "—"}`);
console.log(`  Days together: ${totalDays}`);
console.log(`  Days active: ${activeDays} (${((activeDays / totalDays) * 100).toFixed(0)}%)`);
console.log(`  Total sessions: ${totalSessions}`);
console.log(`  Total messages: ${totalMessages} (${totalUser} user + ${totalAssistant} assistant)`);
console.log(`  Peak day: ${peakDay?.date} (${peakDay?.messages} messages)`);
console.log(`\n  CSV:   ${csvPath}`);
console.log(`  Chart: ${htmlPath}`);
console.log(`\n  Open chart: open ${htmlPath}\n`);
