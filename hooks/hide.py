"""Run a command with NO console window and forward stdin/stdout/stderr +
exit code. Invoke via pythonw.exe (GUI subsystem) so the launcher itself shows
no console, and pass CREATE_NO_WINDOW to the child so it stays hidden too.

Used to run Claude Code hooks on Windows without a flashing conhost window.
Usage (from .claude/settings.json):
    pythonw.exe .claude/hooks/hide.py node .claude/hooks/guard.js

Uses raw fds 0/1/2 (not sys.stdin/out) because pythonw may set sys.* to None
when there's no console, even though the parent pipes the handles. Fails OPEN
(echo stdin, exit 0) on any wrapper error so a bug here never blocks a tool.
"""
import os
import subprocess
import sys

CREATE_NO_WINDOW = 0x08000000  # 0 effect on non-Windows; we only run on Windows


def _read_stdin() -> bytes:
    chunks = []
    while True:
        try:
            chunk = os.read(0, 65536)
        except OSError:
            break
        if not chunk:
            break
        chunks.append(chunk)
    return b"".join(chunks)


def main() -> int:
    data = _read_stdin()
    if len(sys.argv) < 2:
        os.write(1, data)
        return 0
    try:
        proc = subprocess.run(
            sys.argv[1:], input=data, capture_output=True,
            creationflags=CREATE_NO_WINDOW,
        )
        if proc.stdout:
            os.write(1, proc.stdout)
        if proc.stderr:
            os.write(2, proc.stderr)
        return proc.returncode
    except OSError:
        # fail-open: never block the tool because the wrapper broke (e.g. node missing)
        os.write(1, data)
        return 0


if __name__ == "__main__":
    sys.exit(main())
