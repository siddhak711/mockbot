#!/usr/bin/env python3
"""OpenAI-compatible /v1/chat/completions stand-in for the OpenCode spike.

Modes (MOCK_MODE):
  text   always return the assistant text OK-FROM-MOCK
  tools  return tool calls for the first MOCK_TOOL_TURNS requests, then text
  error  return HTTP 401
  slow   sleep MOCK_DELAY seconds, then return text
"""

import json
import os
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

LOG = Path(os.environ.get("MOCK_LOG", "/tmp/opencode-spike-requests.jsonl"))
STATE = Path(os.environ.get("MOCK_STATE", "/tmp/opencode-spike-state.json"))
MODE = os.environ.get("MOCK_MODE", "text")
DELAY = float(os.environ.get("MOCK_DELAY", "3"))
TOOL_TURNS = int(os.environ.get("MOCK_TOOL_TURNS", "5"))
PORT = int(os.environ.get("MOCK_PORT", "8765"))
EXPECTED_KEY = os.environ.get("MOCK_EXPECTED_KEY", "spike-key")


def load_state():
    if STATE.exists():
        return json.loads(STATE.read_text())
    return {"n": 0}


def save_state(state):
    STATE.parent.mkdir(parents=True, exist_ok=True)
    STATE.write_text(json.dumps(state))


def tool_defs(req):
    found = []
    for tool in req.get("tools") or []:
        fn = (tool or {}).get("function") or {}
        if fn.get("name"):
            found.append(fn)
    return found


def arguments_for(fn):
    name = fn["name"]
    params = (fn.get("parameters") or {}).get("properties") or {}
    required = (fn.get("parameters") or {}).get("required") or list(params)
    if name in ("bash", "shell"):
        key = next((k for k in ("command", "cmd", "script") if k in params or k in required), "command")
        return {key: "printf 'spike-bash\\n' > spike-out.txt"}
    if name == "read":
        key = next((k for k in ("filePath", "path", "file_path") if k in params or k in required), "filePath")
        return {key: "README.md"}
    blob = {}
    for key in required:
        if "path" in key.lower():
            blob[key] = "spike-out.txt"
        elif "content" in key.lower() or "string" in key.lower():
            blob[key] = "spike"
        else:
            blob[key] = "spike"
    return blob


def chunks(text, finish, tool_calls=None):
    if tool_calls:
        call = tool_calls[0]
        first = {
            "role": "assistant",
            "tool_calls": [
                {
                    "index": 0,
                    "id": call["id"],
                    "type": "function",
                    "function": {"name": call["function"]["name"], "arguments": ""},
                }
            ],
        }
        second_delta = {
            "tool_calls": [{"index": 0, "function": {"arguments": call["function"]["arguments"]}}]
        }
        deltas = [first, second_delta]
    else:
        deltas = [{"role": "assistant", "content": text}]
    out = []
    for delta in deltas:
        out.append(
            {
                "id": "chatcmpl-spike",
                "object": "chat.completion.chunk",
                "choices": [{"index": 0, "delta": delta, "finish_reason": None}],
            }
        )
    out.append(
        {
            "id": "chatcmpl-spike",
            "object": "chat.completion.chunk",
            "choices": [{"index": 0, "delta": {}, "finish_reason": finish}],
            "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
        }
    )
    return out


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, fmt, *args):
        return

    def _json(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json(
                200,
                {
                    "object": "list",
                    "data": [{"id": "deepseek/deepseek-v4.1-flash", "object": "model"}],
                },
            )
            return
        self._json(200, {"ok": True})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0") or 0)
        raw = self.rfile.read(length)
        try:
            req = json.loads(raw.decode() or "{}")
        except json.JSONDecodeError:
            req = {}
        auth = self.headers.get("Authorization", "")
        messages = req.get("messages") or []
        names = [fn["name"] for fn in tool_defs(req)]
        last = ""
        if messages:
            content = messages[-1].get("content")
            last = content if isinstance(content, str) else json.dumps(content)[:240]
        record = {
            "path": self.path,
            "auth_scheme": auth.split(" ", 1)[0] if auth else "",
            "auth_ok": auth == f"Bearer {EXPECTED_KEY}",
            "model": req.get("model"),
            "max_tokens": req.get("max_tokens"),
            "stream": req.get("stream"),
            "n_messages": len(messages),
            "n_tools": len(names),
            "tool_names": names,
            "last": last[:400],
        }
        LOG.parent.mkdir(parents=True, exist_ok=True)
        with LOG.open("a") as handle:
            handle.write(json.dumps(record) + "\n")

        if MODE == "error":
            self._json(401, {"error": {"message": "invalid api key", "type": "authentication_error"}})
            return
        if MODE == "slow":
            time.sleep(DELAY)

        state = load_state()
        state["n"] = state.get("n", 0) + 1
        save_state(state)
        text = "OK-FROM-MOCK"
        finish = "stop"
        tool_calls = None
        if MODE == "tools" and state["n"] <= TOOL_TURNS:
            fns = tool_defs(req)
            preferred = next((fn for fn in fns if fn["name"] in ("bash", "shell", "read", "write")), None)
            chosen = preferred or (fns[0] if fns else None)
            if chosen:
                tool_calls = [
                    {
                        "id": f"call_{state['n']}",
                        "type": "function",
                        "function": {
                            "name": chosen["name"],
                            "arguments": json.dumps(arguments_for(chosen)),
                        },
                    }
                ]
                finish = "tool_calls"
                text = None
            else:
                text = "NO-TOOLS-IN-REQUEST"
        elif MODE == "tools":
            text = "DONE-AFTER-TOOLS"

        if req.get("stream"):
            payload = "".join(f"data: {json.dumps(chunk)}\n\n" for chunk in chunks(text or "", finish, tool_calls))
            payload += "data: [DONE]\n\n"
            body = payload.encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-cache")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return

        message = {"role": "assistant", "content": text}
        if tool_calls:
            message = {"role": "assistant", "content": None, "tool_calls": tool_calls}
        self._json(
            200,
            {
                "id": "chatcmpl-spike",
                "object": "chat.completion",
                "choices": [{"index": 0, "message": message, "finish_reason": finish}],
                "usage": {"prompt_tokens": 12, "completion_tokens": 4, "total_tokens": 16},
            },
        )


def main():
    server = ThreadingHTTPServer(("127.0.0.1", PORT), Handler)
    print(f"mock listening {PORT} mode={MODE}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
