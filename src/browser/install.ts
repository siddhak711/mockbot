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

/** Written only after Node, playwright-core, and Chromium have all finished installing. */
export const INSTALL_COMPLETE_NAME = ".install-complete";

/**
 * Idempotent installer for Node, playwright-core, and headless Chromium.
 * python3 downloads Node because the slim image has no curl.
 *
 * A `browsers` directory is not success: Playwright creates it before Chromium
 * is downloaded. The script exits early only when the completion stamp matches
 * this Playwright version and a browser binary is present.
 */
export function browserInstallScript(): string {
  const dir = BROWSER_DIR;
  const node = BROWSER_NODE_VERSION;
  const ready = installReady('"$DIR"');
  const browser = chromiumReady('"$DIR"');
  return [
    "set -eu",
    `DIR=${dir}`,
    `if ${ready}; then exit 0; fi`,
    `rm -f "$DIR/${INSTALL_COMPLETE_NAME}"`,
    `case "$(uname -m)" in x86_64) ARCH=x64 ;; aarch64|arm64) ARCH=arm64 ;; *) echo "unsupported arch $(uname -m)" >&2; exit 1 ;; esac`,
    `mkdir -p "$DIR/lib"`,
    `python3 -c 'import sys, tarfile, urllib.request; tarfile.open(fileobj=urllib.request.urlopen(sys.argv[1]), mode="r|gz").extractall(sys.argv[2], filter="data")' "https://nodejs.org/dist/v${node}/node-v${node}-linux-$ARCH.tar.gz" "$DIR"`,
    `rm -rf "$DIR/node" && mv "$DIR/node-v${node}-linux-$ARCH" "$DIR/node"`,
    `export PATH="$DIR/node/bin:$PATH"`,
    `npm install --prefix "$DIR/lib" --no-save --no-audit --no-fund playwright-core@${PLAYWRIGHT_VERSION}`,
    `PLAYWRIGHT_BROWSERS_PATH="$DIR/browsers" "$DIR/node/bin/node" "$DIR/lib/node_modules/playwright-core/cli.js" install --with-deps --only-shell chromium`,
    `if ! ${browser}; then echo "Chromium install did not finish" >&2; exit 1; fi`,
    `printf '%s\\n' '${PLAYWRIGHT_VERSION}' > "$DIR/${INSTALL_COMPLETE_NAME}"`,
    "",
  ].join("\n");
}

/** Shell test, true only after a finished install of this Playwright version. */
export function browserInstallReadyCommand(dir: string): string {
  return installReady(shellQuote(dir));
}

function installReady(dirExpr: string): string {
  return `[ "$(cat ${dirExpr}/${INSTALL_COMPLETE_NAME} 2>/dev/null)" = "${PLAYWRIGHT_VERSION}" ] && [ -x ${dirExpr}/node/bin/node ] && [ -f ${dirExpr}/lib/node_modules/playwright-core/package.json ] && ${chromiumReady(dirExpr)}`;
}

function chromiumReady(dirExpr: string): string {
  return `find ${dirExpr}/browsers -type f \\( -name chrome-headless-shell -o -name chrome -o -name chromium \\) 2>/dev/null | grep -q .`;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** Runs the installer as root, or with passwordless sudo, like the CLI toolchain. */
export function browserInstallCommand(scriptPath: string): string {
  return `if [ "$(id -u)" -eq 0 ]; then sh ${scriptPath}; else sudo -n sh ${scriptPath}; fi`;
}
