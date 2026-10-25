#!/usr/bin/env python3
"""Drive `opencode acp` over newline-delimited JSON-RPC.

Default mode expects a text reply of OK-FROM-MOCK.
`--permission` expects a bash tool call, approves it once, and expects completion.
"""

import argparse
import json
import os
import select
import subprocess
import sys
import time


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--opencode", required=True)
    parser.add_argument("--cwd", required=True)
    parser.add_argument("--permission", action="store_true")
    args = parser.parse_args()

    proc = subprocess.Popen(
        [args.opencode, "acp", "--cwd", args.cwd],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        env=os.environ.copy(),
    )
    buf = b""

    def send(obj):
        proc.stdin.write((json.dumps(obj) + "\n").encode())
        proc.stdin.flush()

    def read_for(seconds):
        nonlocal buf
        end = time.time() + seconds
        lines = []
        while time.time() < end:
            ready, _, _ = select.select([proc.stdout], [], [], 0.2)
            if not ready:
                if lines or proc.poll() is not None:
                    break
                continue
            chunk = os.read(proc.stdout.fileno(), 65536)
            if not chunk:
                break
            buf += chunk
            while b"\n" in buf:
                line, buf = buf.split(b"\n", 1)
                if line.strip():
                    lines.append(json.loads(line.decode()))
        return lines

    try:
        send(
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": 1,
                    "clientCapabilities": {},
                    "clientInfo": {"name": "spike", "version": "0.0.1"},
                },
            }
        )
        init = read_for(4)
        result = next(msg["result"] for msg in init if msg.get("id") == 1)
        if result.get("protocolVersion") != 1:
            raise SystemExit(f"unexpected protocol {result.get('protocolVersion')}")
        print("acp initialize protocolVersion=1 agent", result.get("agentInfo"))
        caps = result.get("agentCapabilities") or {}
        print("acp mcpCapabilities", caps.get("mcpCapabilities"))
        print("acp sessionCapabilities", sorted((caps.get("sessionCapabilities") or {})))

        send({"jsonrpc": "2.0", "method": "notifications/initialized"})
        send(
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "session/new",
                "params": {"cwd": args.cwd, "mcpServers": []},
            }
        )
        created = read_for(5)
        sid = next(msg["result"]["sessionId"] for msg in created if msg.get("id") == 2)
        print("acp session", sid)

        send(
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "session/prompt",
                "params": {
                    "sessionId": sid,
                    "prompt": [{"type": "text", "text": "Reply with exactly OK-FROM-MOCK"}],
                },
            }
        )
        approved = False
        saw_text = False
        saw_completed = False
        stop = None
        deadline = time.time() + 20
        while time.time() < deadline:
            batch = read_for(1.2)
            if not batch and proc.poll() is not None:
                break
            for msg in batch:
                if msg.get("method") == "session/request_permission":
                    options = [opt["optionId"] for opt in msg["params"]["options"]]
                    print("acp permission options", options)
                    send(
                        {
                            "jsonrpc": "2.0",
                            "id": msg["id"],
                            "result": {"outcome": {"outcome": "selected", "optionId": "once"}},
                        }
                    )
                    approved = True
                elif msg.get("method") == "session/update":
                    update = msg["params"]["update"]
                    kind = update.get("sessionUpdate")
                    if kind == "agent_message_chunk":
                        text = (update.get("content") or {}).get("text")
                        if text:
                            saw_text = text
                            print("acp chunk", text)
                    if kind == "tool_call_update" and update.get("status") == "completed":
                        saw_completed = True
                        print("acp tool completed", update.get("title"))
                elif msg.get("id") == 3:
                    stop = (msg.get("result") or {}).get("stopReason")
                    print("acp stop", stop)
                    deadline = time.time()
        if args.permission:
            if not approved or not saw_completed or stop != "end_turn":
                raise SystemExit(
                    f"permission smoke failed approved={approved} completed={saw_completed} stop={stop}"
                )
        else:
            if saw_text != "OK-FROM-MOCK" or stop != "end_turn":
                raise SystemExit(f"text smoke failed text={saw_text!r} stop={stop}")
    finally:
        proc.kill()


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print(f"acp smoke error: {exc}", file=sys.stderr)
        raise
