/**
 * The browser daemon that runs inside the sandbox, as CommonJS source.
 * The host uploads it to `.mockbot/browserd.cjs` and runs
 * `node browserd.cjs send <base64 step>`. The first send starts `serve` in the
 * background, which keeps one headless Chromium page open between actions.
 * The daemon takes a lock before launching Chromium, and closes that browser
 * if it never binds its port, so a second starter cannot orphan a process.
 *
 * The daemon refuses form submits, login clicks, and password typing unless the
 * step has `allowSubmit`, which the host sets only after the approval layer.
 *
 * Written with String.raw, so the source must not contain backticks or `${`.
 */
export const BROWSERD_SOURCE = String.raw`"use strict";
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");
const { spawn } = require("node:child_process");

const PORT = Number(process.env.MOCKBOT_BROWSER_PORT || 9417);
const IDLE_MS = 10 * 60 * 1000;
const SHOT_DIR = "browser";
const MAX_TEXT = 4000;
const VIEWPORT = { width: 1024, height: 640 };

function message(error) {
  return error && error.message ? String(error.message).split("\n")[0] : String(error);
}

function isTimeout(error) {
  return Boolean(error && (error.name === "TimeoutError" || /Timeout \d+ms exceeded/.test(message(error))));
}

function clip(text) {
  const value = String(text || "").trim();
  return value.length > MAX_TEXT ? value.slice(0, MAX_TEXT) + "\n[truncated]" : value;
}

function classifyClick(el) {
  var LOGIN = /\b(log ?in|sign ?in)\b/i;
  // Clicking a label activates its control, including label[for] and a wrapped control.
  var label = null;
  if (el && el.tagName && String(el.tagName).toLowerCase() === "label") label = el;
  else if (el && el.closest) label = el.closest("label");
  var labeled = null;
  if (label) {
    labeled = label.control || (label.querySelector && label.querySelector("button, input, select, textarea"));
  }
  var inside = el && el.closest ? el.closest("button, input, select, textarea") : null;
  var resolved = inside || labeled || el;
  var target = (resolved.closest && resolved.closest("button, input")) || resolved;
  var tag = target.tagName.toLowerCase();
  var type = (target.getAttribute("type") || "").toLowerCase();
  var form = target.form || (target.closest && target.closest("form"));
  var submits =
    (tag === "button" && (type === "" || type === "submit")) ||
    (tag === "input" && (type === "submit" || type === "image"));
  if (submits && form) {
    if (form.querySelector("input[type=password]")) return "This click submits a login form.";
    return "This click submits a form.";
  }
  var words = [
    target.innerText,
    target.value,
    target.getAttribute("aria-label"),
    target.getAttribute("title"),
    target.id,
    target.getAttribute("name"),
  ];
  if (label && label !== target) {
    words.push(label.innerText, label.getAttribute("aria-label"), label.id, label.getAttribute("for"));
  }
  if (LOGIN.test(words.filter(Boolean).join(" "))) return "This click looks like a login.";
  return null;
}

function classifyType(el) {
  var type = (el.getAttribute("type") || "").toLowerCase();
  var hint = [el.getAttribute("name"), el.id, el.getAttribute("autocomplete")].filter(Boolean).join(" ");
  if (type === "password" || /password|passcode|one-time-code/i.test(hint)) {
    return "Typing here enters a password.";
  }
  return null;
}

function lockPath() {
  return path.join(__dirname, "browserd.lock");
}

function processAlive(pid) {
  if (!pid || pid < 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return Boolean(error && error.code === "EPERM");
  }
}

function readLockPid() {
  try {
    const pid = Number(fs.readFileSync(path.join(lockPath(), "pid"), "utf8").trim());
    return Number.isFinite(pid) ? pid : 0;
  } catch (error) {
    return 0;
  }
}

function lockHeldByOther() {
  const pid = readLockPid();
  if (pid === process.pid) return false;
  if (processAlive(pid)) return true;
  if (pid > 0) return false;
  try {
    const stat = fs.statSync(lockPath());
    return Date.now() - stat.mtimeMs < 3000;
  } catch (error) {
    return false;
  }
}

function acquireServeLock() {
  const dir = lockPath();
  for (let attempt = 0; attempt < 5; attempt += 1) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(path.join(dir, "pid"), String(process.pid));
      return true;
    } catch (error) {
      if (!error || error.code !== "EEXIST") throw error;
      const pid = readLockPid();
      if (processAlive(pid) || pid === process.pid) return false;
      if (pid < 1 && lockHeldByOther()) return false;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
      } catch (unlinkError) {
        return false;
      }
    }
  }
  return false;
}

function releaseServeLock() {
  try {
    if (readLockPid() !== process.pid) return;
    fs.rmSync(lockPath(), { recursive: true, force: true });
  } catch (error) {
    // Already released.
  }
}

function bindServer(server) {
  return new Promise((resolve, reject) => {
    const onError = (error) => {
      server.removeListener("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.listen(PORT, "127.0.0.1", onListening);
  });
}

async function serve() {
  if (!acquireServeLock()) {
    process.exit(0);
  }
  let browser = null;
  try {
    const { chromium } = require("playwright-core");
    browser = await chromium.launch({ headless: true });
    const context = await browser.newContext({ viewport: VIEWPORT, acceptDownloads: false });
    const page = await context.newPage();
    let shots = 0;
    let queue = Promise.resolve();
    let idle = null;
    let stopped = false;

    const shutdown = async () => {
      if (stopped) return;
      stopped = true;
      try {
        await browser.close();
      } finally {
        releaseServeLock();
        process.exit(0);
      }
    };
  const touch = () => {
    if (idle) clearTimeout(idle);
    idle = setTimeout(shutdown, IDLE_MS);
  };

  async function summary() {
    return { url: page.url(), title: await page.title() };
  }

  async function perform(step) {
    const timeout = Math.max(100, Number(step.timeoutMs) || 10000);
    page.setDefaultTimeout(timeout);
    page.setDefaultNavigationTimeout(timeout);
    if (step.action === "close") {
      setTimeout(shutdown, 10);
      return { ok: true };
    }
    if (step.action === "open") {
      const response = await page.goto(step.url, { waitUntil: "domcontentloaded", timeout });
      return Object.assign({ ok: true, status: response ? response.status() : null }, await summary());
    }
    if (step.action === "click") {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: "attached", timeout });
      const risk = await target.evaluate(classifyClick);
      if (risk && !step.allowSubmit) return { ok: false, needsApproval: true, error: risk };
      await target.click({ timeout });
      await page.waitForLoadState("domcontentloaded", { timeout }).catch(() => undefined);
      return Object.assign({ ok: true }, await summary());
    }
    if (step.action === "type") {
      const target = page.locator(step.selector).first();
      await target.waitFor({ state: "attached", timeout });
      const risk = await target.evaluate(classifyType);
      if (risk && !step.allowSubmit) return { ok: false, needsApproval: true, error: risk };
      await target.fill(String(step.text || ""), { timeout });
      return Object.assign({ ok: true }, await summary());
    }
    if (step.action === "extract") {
      const target = page.locator(step.selector || "body").first();
      const text = await target.innerText({ timeout });
      return Object.assign({ ok: true, text: clip(text) }, await summary());
    }
    if (step.action === "screenshot") {
      const buffer = await page.screenshot({ type: "png", timeout });
      shots += 1;
      fs.mkdirSync(SHOT_DIR, { recursive: true });
      const file = path.join(SHOT_DIR, "shot-" + shots + ".png");
      fs.writeFileSync(file, buffer);
      const screenshot = {
        path: file,
        mimeType: "image/png",
        bytes: buffer.length,
        sha256: crypto.createHash("sha256").update(buffer).digest("hex"),
        width: VIEWPORT.width,
        height: VIEWPORT.height,
        base64: buffer.toString("base64"),
      };
      return Object.assign({ ok: true, screenshot }, await summary());
    }
    return { ok: false, error: "Unknown browser action." };
  }

  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/ping") {
      res.end("ok");
      return;
    }
    if (req.method !== "POST" || req.url !== "/step") {
      res.statusCode = 404;
      res.end();
      return;
    }
    let body = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      body += chunk;
      if (body.length > 100000) req.destroy();
    });
    req.on("end", () => {
      touch();
      const run = queue.then(async () => {
        try {
          return await perform(JSON.parse(body));
        } catch (error) {
          return { ok: false, error: message(error), timedOut: isTimeout(error) };
        }
      });
      queue = run.then(() => undefined);
      run.then((result) => {
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      });
    });
  });
    await bindServer(server);
    server.on("error", (error) => {
      process.stderr.write(message(error) + "\n");
      shutdown();
    });
    touch();
  } catch (error) {
    if (browser) {
      try {
        await browser.close();
      } catch (closeError) {
        process.stderr.write(message(closeError) + "\n");
      }
    }
    releaseServeLock();
    throw error;
  }
}

function ping() {
  return new Promise((resolve) => {
    const req = http.get({ host: "127.0.0.1", port: PORT, path: "/ping", timeout: 1000 }, (res) => {
      res.resume();
      resolve(res.statusCode === 200);
    });
    req.on("error", () => resolve(false));
    req.on("timeout", () => {
      req.destroy();
      resolve(false);
    });
  });
}

async function ensureServer(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let spawned = false;
  while (Date.now() < deadline) {
    if (await ping()) return true;
    if (!spawned && !lockHeldByOther()) {
      spawned = true;
      const log = fs.openSync(path.join(__dirname, "browserd.log"), "a");
      const child = spawn(process.execPath, [__filename, "serve"], {
        detached: true,
        stdio: ["ignore", log, log],
        env: process.env,
      });
      child.unref();
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return ping();
}

function post(step, timeoutMs) {
  return new Promise((resolve) => {
    const body = JSON.stringify(step);
    const req = http.request(
      {
        host: "127.0.0.1",
        port: PORT,
        path: "/step",
        method: "POST",
        headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(body) },
        timeout: timeoutMs,
      },
      (res) => {
        let data = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => (data += chunk));
        res.on("end", () => {
          try {
            resolve(JSON.parse(data));
          } catch (error) {
            resolve({ ok: false, error: "The browser returned malformed output." });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, timedOut: true, error: "The browser action timed out." });
    });
    req.on("error", (error) => resolve({ ok: false, error: message(error) }));
    req.end(body);
  });
}

async function send(encoded) {
  let step;
  try {
    step = JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
  } catch (error) {
    process.stdout.write(JSON.stringify({ ok: false, error: "The browser step is not valid JSON." }));
    return;
  }
  if (step.action === "close" && !(await ping())) {
    process.stdout.write(JSON.stringify({ ok: true }));
    return;
  }
  const started = await ensureServer(Number(step.startTimeoutMs) || 20000);
  if (!started) {
    process.stdout.write(JSON.stringify({ ok: false, error: "The sandbox browser did not start." }));
    return;
  }
  const result = await post(step, (Number(step.timeoutMs) || 10000) + 2000);
  process.stdout.write(JSON.stringify(result));
}

const mode = process.argv[2];
if (mode === "serve") {
  serve().catch((error) => {
    process.stderr.write(message(error) + "\n");
    process.exit(1);
  });
} else if (mode === "send") {
  send(process.argv[3] || "");
} else {
  process.stderr.write("usage: browserd.cjs serve | send <base64-step>\n");
  process.exit(2);
}
`;
