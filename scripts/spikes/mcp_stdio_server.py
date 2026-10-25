#!/usr/bin/env python3
"""Minimal MCP server. OpenCode 1.19.4 speaks newline-delimited JSON-RPC on stdio."""

import json
import sys


def read_message():
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        line = line.strip()
        if not line:
            continue
        return json.loads(line.decode())


def write_message(obj):
    sys.stdout.buffer.write((json.dumps(obj) + "\n").encode())
    sys.stdout.buffer.flush()


def main():
    while True:
        msg = read_message()
        if msg is None:
            return
        method = msg.get("method")
        mid = msg.get("id")
        if method == "initialize":
            params = msg.get("params") or {}
            write_message(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {
                        "protocolVersion": params.get("protocolVersion", "2025-11-25"),
                        "capabilities": {"tools": {}},
                        "serverInfo": {"name": "spike-mcp", "version": "0.0.1"},
                    },
                }
            )
        elif method == "notifications/initialized":
            continue
        elif method == "tools/list":
            write_message(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {
                        "tools": [
                            {
                                "name": "spike_ping",
                                "description": "Return the fixed token spike-pong",
                                "inputSchema": {"type": "object", "properties": {}},
                            }
                        ]
                    },
                }
            )
        elif method == "tools/call":
            write_message(
                {
                    "jsonrpc": "2.0",
                    "id": mid,
                    "result": {"content": [{"type": "text", "text": "spike-pong"}]},
                }
            )
        elif mid is not None:
            write_message({"jsonrpc": "2.0", "id": mid, "result": {}})


if __name__ == "__main__":
    main()
