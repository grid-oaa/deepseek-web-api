/** Connects to a clean CDP browser or launches a managed Chrome without extensions. */
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import type { Browser, BrowserContext, Page } from "playwright-core";
import { chromium } from "playwright-core";

import type { AppConfig } from "../config/env.js";
import type { Logger } from "../utils/logger.js";
import { errorMessage } from "../utils/errors.js";
import {
  cdpIsExtensionFree,
  cdpIsHeadless,
  cdpVersionOk,
  clearStaleProfileLocks,
  existingManagedEndpoint,
  freePort,
  killChromeOnPort,
  killManagedChrome,
  localDebugPort,
  readSavedCdp,
  waitForCdp,
  waitForProfileRelease,
  writeSavedCdp,
} from "./chromeCdp.js";
import { findChromeExecutable } from "./chromePaths.js";

export { findChromeExecutable } from "./chromePaths.js";

export interface ConnectOptions {
  /** Force a visible window for interactive login. */
  visible?: boolean;
  /** Open chat.deepseek.com after connect (login UX only). */
  openDeepSeek?: boolean;
}

/** Owns the reusable CDP connection and DeepSeek page selection. */
export class ChromeManager {
  private browser: Browser | null = null;
  private launchedVisible: boolean | null = null;
  private cdpEndpoint: string;
  private readonly cdpFile: string;

  constructor(
    private readonly config: AppConfig,
    private readonly logger: Logger,
  ) {
    this.cdpEndpoint = config.cdpEndpoint;
    this.cdpFile = path.join(config.dataDir, "chrome.cdp");
  }

  /**
   * Connect order:
   * 1) already-connected instance
   * 2) saved managed CDP (data/chrome.cdp)
   * 3) live process holding chrome-profile SingletonLock
   * 4) clean configured DS_CDP
   * 5) launch new managed Chrome (never against a foreign locked profile)
   */
  async connect(options: ConnectOptions = {}): Promise<Browser> {
    const wantVisible = options.visible ?? this.config.showBrowser;
    if (this.browser?.isConnected()) {
      if (wantVisible && this.launchedVisible === false) await this.disconnect();
      else return this.browser;
    }

    const candidates = this.candidateEndpoints();
    for (const endpoint of candidates) {
      if (!(await cdpIsExtensionFree(endpoint))) {
        if (await cdpVersionOk(endpoint)) {
          this.logger.debug("跳过带扩展的 CDP", { endpoint });
        }
        continue;
      }
      // A headless browser can never show a window, so it cannot serve a visible request.
      if (wantVisible && (await cdpIsHeadless(endpoint))) {
        this.logger.debug("跳过无头 CDP（当前需要可见窗口）", { endpoint });
        continue;
      }
      try {
        this.browser = await chromium.connectOverCDP(endpoint, { timeout: 5_000 });
        this.cdpEndpoint = endpoint;
        this.launchedVisible = wantVisible;
        writeSavedCdp(this.cdpFile, endpoint);
        this.logger.info("已连接 Chrome CDP", { endpoint });
        return this.browser;
      } catch (error) {
        this.logger.debug("CDP 连接失败", { endpoint, error: errorMessage(error) });
      }
    }

    const endpoint = await this.ensureManagedChrome(wantVisible);
    this.browser = await chromium.connectOverCDP(endpoint, { timeout: 10_000 });
    this.launchedVisible = wantVisible;
    writeSavedCdp(this.cdpFile, endpoint);
    this.logger.info(wantVisible ? "已启动可见 Chrome" : "已启动无界面 Chrome", {
      profile: this.config.chromeProfileDir,
      endpoint,
    });
    return this.browser;
  }

  async context(options: ConnectOptions = {}): Promise<BrowserContext> {
    const browser = await this.connect(options);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome CDP 没有可用的浏览器上下文");
    return context;
  }

  /** Reuse a page already on the given origin, otherwise open a visible one there. */
  async pageFor(url: string, options: ConnectOptions = {}): Promise<Page> {
    const context = await this.context({ visible: true, ...options });
    const host = new URL(url).hostname;
    let page = context.pages().find((candidate) => candidate.url().includes(host));
    if (!page) page = context.pages()[0] ?? (await context.newPage());
    if (!page.url().startsWith(url)) {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    return page;
  }

  async deepSeekPage(options: ConnectOptions = {}): Promise<Page> {
    const openDeepSeek = options.openDeepSeek ?? true;
    const context = await this.context(options);
    let page = context.pages().find((candidate) => candidate.url().includes("chat.deepseek.com"));
    if (!page) page = context.pages()[0] ?? (await context.newPage());
    if (openDeepSeek && !page.url().startsWith(this.config.baseUrl)) {
      await page.goto(this.config.baseUrl, { waitUntil: "domcontentloaded", timeout: 60_000 });
    }
    return page;
  }

  isConnected(): boolean {
    return this.browser?.isConnected() === true;
  }

  async disconnect(): Promise<void> {
    if (!this.browser) return;
    try {
      await this.browser.close();
    } catch {
      // already gone
    }
    this.browser = null;
    this.launchedVisible = null;
  }

  private candidateEndpoints(): string[] {
    const list: string[] = [];
    const push = (value: string | null | undefined): void => {
      if (value && !list.includes(value)) list.push(value);
    };
    push(readSavedCdp(this.cdpFile));
    push(existingManagedEndpoint(this.config.chromeProfileDir));
    push(this.config.cdpEndpoint);
    return list;
  }

  private async ensureManagedChrome(visible: boolean): Promise<string> {
    // Live owner of the profile -> must reconnect, never double-launch.
    const live = existingManagedEndpoint(this.config.chromeProfileDir);
    if (live) {
      if (!(await cdpVersionOk(live))) {
        throw new Error(
          `Managed Chrome profile is locked but CDP is unavailable (${live}). Kill the process and retry.`,
        );
      }
      if (!(visible && (await cdpIsHeadless(live)))) {
        this.cdpEndpoint = live;
        return live;
      }
      // Interactive login needs a window; replace the leftover headless instance.
      this.logger.info("检测到无头 Chrome，正在重启为可见窗口", { endpoint: live });
      if (!killManagedChrome(this.config.chromeProfileDir)) {
        throw new Error(`无法关闭无头 Chrome (${live})，请手动结束该进程后重试。`);
      }
      if (!(await waitForProfileRelease(this.config.chromeProfileDir))) {
        throw new Error(`无头 Chrome 未及时退出 (${live})，请手动结束该进程后重试。`);
      }
    }
    clearStaleProfileLocks(this.config.chromeProfileDir);

    let port = localDebugPort(this.config.cdpEndpoint) ?? 9333;
    const configured = `http://127.0.0.1:${port}`;
    if (await cdpVersionOk(configured)) {
      // A leftover instance on the configured port keeps the profile busy, so a visible
      // replacement cannot start there. Headless is the case interactive login must fix.
      if (visible && (await cdpIsHeadless(configured))) {
        this.logger.info("关闭占用端口的无头 Chrome", { endpoint: configured });
        await killChromeOnPort(configured);
      }
      if (await cdpVersionOk(configured)) port = await freePort();
    }
    this.cdpEndpoint = `http://127.0.0.1:${port}`;
    this.launchManagedChrome(port, visible);
    await waitForCdp(this.cdpEndpoint);
    return this.cdpEndpoint;
  }

  private launchManagedChrome(port: number, visible: boolean): void {
    fs.mkdirSync(this.config.chromeProfileDir, { recursive: true, mode: 0o700 });
    const executable = findChromeExecutable(this.config.chromePath);
    const args = [
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
      `--user-data-dir=${this.config.chromeProfileDir}`,
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--disable-component-extensions-with-background-pages",
      "--disable-default-apps",
      "--disable-background-networking",
    ];
    if (!visible) args.push("--headless=new", "--disable-gpu");
    if (visible) args.push(this.config.baseUrl);
    const child = spawn(executable, args, {
      detached: true,
      stdio: ["ignore", "ignore", "pipe"],
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      const text = chunk.toString("utf8").trim();
      if (text) this.logger.debug("Chrome stderr", { text: text.slice(0, 400) });
    });
    child.on("exit", (code) => {
      this.logger.debug("Chrome 进程退出", { code, port });
    });
    child.unref();
  }
}
