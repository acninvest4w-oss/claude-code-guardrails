// Wall-clock cost of one hook call, process start included, as Claude Code pays it.
//
//   node bench/latency.js [--runs 40] -- <hook command...>
//   node bench/latency.js -- node hooks/guard.js
//   node bench/latency.js -- C:/Python313/pythonw.exe hooks/hide.py node hooks/guard.js
//
// Feeds a mix of typical PreToolUse inputs (Bash, PowerShell, Write; allowed and blocked) on stdin
// and prints p50 / p95 / max in milliseconds per input kind.
const { spawnSync } = require('child_process');
const { performance } = require('perf_hooks');

const INPUTS = {
  'bash allowed': { tool_name: 'Bash', tool_input: { command: 'git status && ls -la src' } },
  'bash blocked': { tool_name: 'Bash', tool_input: { command: 'cd x && git add -A' } },
  'powershell allowed': { tool_name: 'PowerShell', tool_input: { command: 'Get-ChildItem src | Select-Object Name' } },
  'powershell blocked': { tool_name: 'PowerShell', tool_input: { command: 'Set-Content .claude\\settings.json x' } },
  'write allowed': { tool_name: 'Write', tool_input: { file_path: 'src/app.py', content: 'x = 1\n' } },
};

function main() {
  const argv = process.argv.slice(2);
  const sep = argv.indexOf('--');
  const runsAt = argv.indexOf('--runs');
  const runs = runsAt >= 0 && runsAt < sep ? Number(argv[runsAt + 1]) : 40;
  const cmd = argv.slice(sep + 1);
  if (sep < 0 || !cmd.length) {
    console.error('usage: node bench/latency.js [--runs N] -- <hook command...>');
    process.exit(2);
  }
  const report = {};
  for (const [kind, body] of Object.entries(INPUTS)) {
    const input = JSON.stringify({ hook_event_name: 'PreToolUse', cwd: process.cwd(), ...body });
    const times = [];
    for (let i = 0; i < runs; i++) {
      const t0 = performance.now();
      const r = spawnSync(cmd[0], cmd.slice(1), { input, encoding: 'utf8', windowsHide: true });
      times.push(performance.now() - t0);
      if (r.error) throw r.error;
      if (i === 0) report[kind] = { exit: r.status };
    }
    times.sort((a, b) => a - b);
    const at = (p) => Math.round(times[Math.min(times.length - 1, Math.floor(times.length * p))]);
    Object.assign(report[kind], { p50: at(0.5), p95: at(0.95), max: at(1) });
  }
  console.log(JSON.stringify({ runs, command: cmd.join(' '), ms: report }, null, 2));
}

main();
