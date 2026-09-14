import { expect, test } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

test("desktop reader, source preview, navigation and no overflow", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".question")).toHaveCount(30);
  await expect(page.locator(".option-row")).toHaveCount(120);
  await expect(page.locator(".document-item")).toHaveCount(2);
  await expect(page.locator(".pdf-preview-button img")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".pdf-preview-button img")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(100);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: "test-results/desktop.png" });
  await page.getByRole("button", { name: "跳转第 5 题", exact: true }).click();
  await expect(page.locator("#q-4")).toBeInViewport();
  await page.waitForTimeout(1000);
  await page.reload();
  await expect(page.locator("#q-4")).toBeInViewport();
  expect(errors).toEqual([]);
});

test("mobile navigation, search and source inspection", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/");
  await expect(page.locator(".question")).toHaveCount(30);
  await page.screenshot({ path: "test-results/mobile.png" });
  await page.getByRole("button", { name: "打开资料导航" }).click();
  await page.locator(".document-item").nth(1).click();
  await expect(page.locator(".document-title-row h1")).toContainText("2");
  await page.getByRole("searchbox").fill("eternal");
  await expect(page.locator(".question")).toHaveCount(1);
  await expect(page.locator(".sentence")).toHaveText(
    "The eternal cycle of life and death is a subject of interest to scientists and philosophers alike.",
  );
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page
    .getByRole("button", { name: "查看第 5 题原文", exact: true })
    .click();
  await expect(page.locator(".pdf-page")).toBeVisible();
  await expect
    .poll(() =>
      page
        .locator(".pdf-page")
        .evaluate((img: HTMLImageElement) => img.naturalWidth),
    )
    .toBeGreaterThan(500);
  await page.getByRole("button", { name: "修正解析", exact: true }).click();
  await expect(
    page.getByRole("textbox", { name: "原始题干", exact: true }),
  ).toHaveValue(/_{2,} cycle/);
  await page.screenshot({ path: "test-results/mobile-source.png" });
  await page.getByRole("button", { name: "关闭窗口", exact: true }).click();
});

test("edit a note, persist changes, then restore imported version", async ({
  page,
}) => {
  await page.goto("/");
  await expect(page.locator(".question")).toHaveCount(30);
  await page
    .getByRole("button", { name: "编辑第 1 题笔记", exact: true })
    .click();
  await page
    .getByRole("textbox", { name: "中文释义", exact: true })
    .first()
    .fill("测试修订：论证所依据的前提");
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#q-0")).toContainText(
    "测试修订：论证所依据的前提",
  );
  await page.reload();
  await expect(page.locator("#q-0")).toContainText(
    "测试修订：论证所依据的前提",
  );
  await page
    .getByRole("button", { name: "第 1 题修订历史", exact: true })
    .click();
  await page
    .locator(".revision-list button")
    .filter({ hasText: "已有 Markdown" })
    .click();
  await page.getByRole("button", { name: "恢复此版本", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await expect(page.locator("#q-0")).not.toContainText("测试修订");
});

test("export Markdown matches adopted notes", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".question")).toHaveCount(30);
  await page.getByRole("button", { name: "导出笔记", exact: true }).click();
  const downloadEvent = page.waitForEvent("download");
  await page.getByRole("button", { name: "导出当前版本", exact: true }).click();
  const download = await downloadEvent;
  const text = await readFile((await download.path())!, "utf8");
  expect(text.match(/答案：/g)?.length).toBe(30);
  expect(text).toContain("**premise**");
  expect(text).toContain("待核对");
  expect(text).toContain("`on the premise that...`");
});

test("duplicate upload offers existing document and independent copy", async ({
  page,
}) => {
  await page.goto("/");
  const name = (await readdir(process.cwd()))
    .filter((n) => n.endsWith(".pdf"))
    .sort()[0];
  await page
    .locator("input[type=file]")
    .setInputFiles(join(process.cwd(), name));
  await expect(
    page.getByRole("dialog", { name: "这份资料已在资料库中" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "打开已有资料", exact: true }).click();
  await expect(page.getByRole("dialog")).toHaveCount(0);
  await page
    .locator("input[type=file]")
    .setInputFiles(join(process.cwd(), name));
  await page.getByRole("button", { name: "创建副本", exact: true }).click();
  await expect(page.locator(".document-item")).toHaveCount(3);
  await expect(page.locator(".pending-meta")).toHaveCount(30);
  await page.getByRole("button", { name: "生成笔记", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "学习设置" })).toBeVisible();
  await expect(page.getByText("未配置", { exact: true })).toBeVisible();
});

test("word clicks do not trigger sentence speech; phrases expand and stop", async ({
  page,
}) => {
  await page.route("**/api/speech/voices", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.addInitScript(() => {
    const w = window as any;
    w.__spoken = [];
    w.__cancels = 0;
    Object.defineProperty(window, "speechSynthesis", {
      configurable: true,
      value: {
        getVoices: () => [
          {
            name: "Test English",
            lang: "en-US",
            voiceURI: "test-en",
            localService: true,
          },
        ],
        speak: (utterance: any) => {
          w.__spoken.push(utterance.text);
        },
        cancel: () => {
          w.__cancels++;
        },
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    w.SpeechSynthesisUtterance = class {
      text: string;
      constructor(text: string) {
        this.text = text;
      }
    };
  });
  await page.goto("/");
  await expect(page.locator(".question")).toHaveCount(30);
  await page.locator("#q-0 .answer-word").click();
  expect(await page.evaluate(() => (window as any).__spoken)).toEqual([
    "premise",
  ]);
  await page
    .getByRole("button", { name: "朗读第 1 题原句", exact: true })
    .click();
  expect(await page.evaluate(() => (window as any).__spoken.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__spoken[1])).toContain(
    "Starting with the premise",
  );
  await page
    .getByRole("button", {
      name: "朗读搭配 on the premise that...",
      exact: true,
    })
    .click();
  expect(await page.evaluate(() => (window as any).__spoken.at(-1))).toBe(
    "on the premise that",
  );
  await page
    .getByRole("button", {
      name: "朗读搭配 on the premise that...",
      exact: true,
    })
    .click();
  await expect(page.locator(".speech-bar")).toHaveCount(0);
  const count = await page.evaluate(() => (window as any).__spoken.length);
  await page.locator("#q-0 .sentence").evaluate((el) => {
    const range = document.createRange();
    range.selectNodeContents(el);
    window.getSelection()?.removeAllRanges();
    window.getSelection()?.addRange(range);
  });
  await page.locator("#q-0 .sentence").dispatchEvent("click");
  expect(await page.evaluate(() => (window as any).__spoken.length)).toBe(
    count,
  );
});

test("real Windows English audio is generated and browser playback starts", async ({
  page,
  request,
}) => {
  const voices = await (await request.get("/api/speech/voices")).json();
  test.skip(
    !voices.length,
    "No installed Windows English voice on this machine",
  );
  await page.addInitScript(() => {
    localStorage.setItem("wordnote.voice", "windows:Microsoft Zira Desktop");
    const w = window as any;
    w.__played = 0;
    const original = HTMLMediaElement.prototype.play;
    HTMLMediaElement.prototype.play = function () {
      return original.call(this).then(() => {
        w.__played++;
      });
    };
  });
  await page.goto("/");
  await expect(page.locator(".voice-summary button")).toContainText("美式英语");
  const responseEvent = page.waitForResponse(
    (response) =>
      response.url().endsWith("/api/speech") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "朗读单词 premise", exact: true })
    .first()
    .click();
  const response = await responseEvent;
  expect(response.status()).toBe(200);
  // Chromium may omit media bodies from its debugging protocol; inspect the
  // cached audio through HTTP and separately verify real browser playback.
  const audioResponse = await request.post("/api/speech", {
    data: response.request().postDataJSON(),
  });
  const buffer = await audioResponse.body();
  expect(buffer.subarray(0, 4).toString()).toBe("RIFF");
  expect(buffer.length).toBeGreaterThan(1000);
  await expect
    .poll(() => page.evaluate(() => (window as any).__played))
    .toBe(1);
  await expect(page.locator(".speech-bar")).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator(".toast")).toHaveCount(0);
});
