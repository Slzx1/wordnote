import { defineConfig } from "@playwright/test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const testData = mkdtempSync(join(tmpdir(), "wordnote-browser-"));

export default defineConfig({
  testDir: "./tests/browser",
  workers: 1,
  timeout: 45000,
  use: {
    baseURL: "http://127.0.0.1:8776",
    channel: process.env.PLAYWRIGHT_CHANNEL || "msedge",
    headless: true,
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command:
      ".\\.venv\\Scripts\\python.exe -m uvicorn backend.app:app --host 127.0.0.1 --port 8776",
    url: "http://127.0.0.1:8776/api/health",
    timeout: 30000,
    reuseExistingServer: false,
    env: {
      WORDNOTE_DATA_DIR: testData,
      WORDNOTE_ENV_FILE: join(testData, ".env"),
      DEEPSEEK_API_KEY: "",
      DEEPSEEK_MODEL: "deepseek-flash",
      PYTHONUTF8: "1",
    },
  },
});
