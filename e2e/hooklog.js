// E2E only: runs guard.js on the hook input, appends {event, tool, command, file, exit} to
// hook-log.jsonl next to it, and passes the guard's stderr and exit code on unchanged.
// The smoke test reads the log, so "refused" means the hook saw the call and said no --
// not just that a file is missing because the model skipped a step.
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

let data = '';
process.stdin.on('data', (c) => (data += c));
process.stdin.on('end', () => {
  const r = spawnSync(process.execPath, [path.join(__dirname, 'guard.js')], { input: data, encoding: 'utf8' });
  let input = {};
  try {
    input = JSON.parse(data);
  } catch (e) {
    input = { unparsed: e.message };
  }
  const ti = input.tool_input || {};
  const entry = { event: input.hook_event_name, tool: input.tool_name, command: ti.command, file: ti.file_path,
    exit: r.status };
  fs.appendFileSync(path.join(__dirname, 'hook-log.jsonl'), `${JSON.stringify(entry)}\n`);
  if (r.stderr) process.stderr.write(r.stderr);
  process.exit(r.status === null ? 1 : r.status);
});
