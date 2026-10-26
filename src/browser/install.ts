/** Must match the playwright-core version in package.json. A test checks it. */
export const PLAYWRIGHT_VERSION = "1.64.1";

/** Debian's nodejs is 18; Playwright needs 20+, so the sandbox gets its own Node. */
export const BROWSER_NODE_VERSION = "22.23.2";

export const BROWSER_DIR = "/opt/mockbot-browser";

export type BrowserPaths = {
  /** Node binary that runs the daemon. */
  node: string;
  /** Directory that holds playwright-core, passed as NODE_PATH. */
  nodePath: string;
  /** PLAYWRIGHT_BROWSERS_PATH, when Chromium lives outside the default cache. */
  browsersPath?: string;
};

export const SANDBOX_BROWSER_PATHS: BrowserPaths = {
  node: `${BROWSER_DIR}/node/bin/node`,
  nodePath: `${BROWSER_DIR}/lib/node_modules`,
  browsersPath: `${BROWSER_DIR}/browsers`,
};

/**
 * Idempotent installer for Node, playwright-core, and headless Chromium.
 * python3 downloads Node because the slim image has no curl.
 */
export function browserInstallScript(): string {
  const dir = BROWSER_DIR;
  const node = BROWSER_NODE_VERSION;
  return [
    "set -eu",
    `DIR=${dir}`,
    `if [ -x "$DIR/node/bin/node" ] && [ -f "$DIR/lib/node_modules/playwright-core/package.json" ] && [ -d "$DIR/browsers" ]; then exit 0; fi`,
    `case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac`,
    `mkdir -p "$DIR/lib"`,
    `python3 -c 'import sys, tarfile, urllib.request; tarfile.open(fileobj=urllib.request.urlopen(sys.argv[1]), mode="r|gz").extractall(sys.argv[2], filter="data")' "https://nodejs.org/dist/v${node}/node-v${node}-linux-$ARCH.tar.gz" "$DIR"`,
    `rm -rf "$DIR/node" && mv "$DIR/node-v${node}-linux-$ARCH" "$DIR/node"`,
    `export PATH="$DIR/node/bin:$PATH"`,
    `npm install --prefix "$DIR/lib" --no-save --no-audit --no-fund playwright-core@${PLAYWRIGHT_VERSION}`,
    `PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers" "$DIR/node/bin/node" "$DIR/lib/node_modules/playwright-core/cli.js" install --with-deps --only-shell chromium`,
    "",
  ].join("\n");
}

/** Runs the installer as root, or with passwordless sudo, like the CLI toolchain. */
export function browserInstallCommand(scriptPath: string): string {
  return `if [ "$(id -u)" -eq 0 ]; then sh ${scriptPath}; else sudo -n sh ${scriptPath}; fi`;
}
