import { expect, test, type Page, type Locator } from "@playwright/test";

async function openFirstQuestion(page: Page) {
  await page.goto("/");
  await page.getByRole("searchbox").fill("Starting with the");
  await expect(page.locator(".question")).toHaveCount(1);
  await page.locator(".sentence").scrollIntoViewIfNeeded();
}

async function selectContents(locator: Locator) {
  await locator.evaluate((element) => {
    const selection = window.getSelection()!;
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges();
    selection.addRange(range);
  });
}

async function dragWord(page: Page, locator: Locator, word: string) {
  await locator.scrollIntoViewIfNeeded();
  const rect = await locator.evaluate((element, text) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      const index = node.textContent!.indexOf(text);
      if (index < 0) continue;
      const range = document.createRange();
      range.setStart(node, index);
      range.setEnd(node, index + text.length);
      const box = range.getBoundingClientRect();
      return { x: box.x, y: box.y, width: box.width, height: box.height };
    }
    throw new Error("Selection text not found: " + text);
  }, word);
  await page.mouse.move(rect.x + 1, rect.y + rect.height / 2);
  await page.mouse.down();
  await page.mouse.move(rect.x + rect.width - 1, rect.y + rect.height / 2, {
    steps: 12,
  });
  await page.mouse.up();
  await expect(page.getByRole("menu", { name: "划词菜单" })).toBeVisible();
}

async function query(page: Page) {
  await page.getByRole("menuitem", { name: "查词 / 翻译" }).click();
  await expect(page.getByRole("dialog", { name: "英汉词典" })).toBeVisible();
}

test("global selection finds ordinary sentence words, option text and collocations offline", async ({
  page,
}) => {
  await page.route("**/api/speech/voices", (route) =>
    route.fulfill({ json: [] }),
  );
  await page.addInitScript(() => {
    const w = window as any;
    w.__spoken = [];
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
        speak: (utterance: any) => w.__spoken.push(utterance.text),
        cancel: () => {},
        addEventListener: () => {},
        removeEventListener: () => {},
      },
    });
    w.SpeechSynthesisUtterance = class {
      constructor(public text: string) {}
    };
  });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await openFirstQuestion(page);
  await dragWord(page, page.locator(".sentence"), "scientist");
  expect(await page.evaluate(() => (window as any).__spoken)).toEqual([]);
  await page.getByRole("button", { name: "朗读所选文字", exact: true }).click();
  expect(await page.evaluate(() => (window as any).__spoken)).toEqual([
    "scientist",
  ]);
  await query(page);
  await expect(page.locator(".dictionary-translation").first()).toContainText(
    "科学家",
  );
  await expect(page.locator(".dictionary-footer")).toContainText("ECDICT");
  await page.screenshot({ path: "test-results/dictionary-desktop.png" });
  await page.keyboard.press("Escape");
  await expect(page.locator(".selection-dictionary")).toHaveCount(0);
  await dragWord(page, page.locator(".word-button").nth(1), "pretext");
  expect(await page.evaluate(() => (window as any).__spoken)).toEqual([
    "scientist",
  ]);
  await query(page);
  await expect(page.locator(".dictionary-translation").first()).toContainText(
    "借口",
  );
  await page.getByRole("button", { name: "关闭词典", exact: true }).click();
  await selectContents(page.locator(".phrase").first());
  await query(page);
  await expect(page.locator(".dictionary-term h3")).toHaveText(
    "on the premise that...",
  );
  await expect(page.locator(".dictionary-translation").first()).toContainText(
    "前提",
  );
  await expect(page.locator(".dictionary-footer")).toContainText(
    "内置搭配词库",
  );
});

test("selection across bold target word supports full sentences and settings for missing key", async ({
  page,
}) => {
  await openFirstQuestion(page);
  await selectContents(page.locator(".sentence"));
  await query(page);
  await expect(page.locator(".dictionary-term h3")).toContainText(
    "Starting with the premise that",
  );
  await expect(page.locator(".dictionary-unavailable")).toContainText(
    "需要配置 DeepSeek",
  );
  await page
    .getByRole("button", { name: "配置 DeepSeek", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "学习设置" })).toBeVisible();
  await expect(page.locator(".selection-dictionary")).toHaveCount(0);
});

test("new selection cancels stale responses; Escape dismisses lookup inside a dialog", async ({
  page,
}) => {
  await page.route("**/api/dictionary/lookup", async (route) => {
    const { text } = route.request().postDataJSON();
    if (text === "premise")
      await new Promise((resolve) => setTimeout(resolve, 800));
    await route.fulfill({
      json: {
        text,
        kind: "local",
        translation: text === "premise" ? "旧查询结果" : "借口",
        source: "测试词典",
      },
    });
  });
  await openFirstQuestion(page);
  await selectContents(page.locator(".answer-word"));
  await query(page);
  await selectContents(page.locator(".word-button").nth(1));
  await query(page);
  await expect(page.locator(".dictionary-translation")).toContainText("借口");
  await page.waitForTimeout(1000);
  await expect(page.locator(".dictionary-translation")).not.toContainText(
    "旧查询结果",
  );
  await page.keyboard.press("Escape");
  await page
    .getByRole("button", { name: "第 1 题修订历史", exact: true })
    .click();
  await page
    .locator(".revision-list button")
    .filter({ hasText: "已有 Markdown" })
    .first()
    .click();
  await page.locator(".read-note b").first().scrollIntoViewIfNeeded();
  await selectContents(page.locator(".read-note b").first());
  await query(page);
  await page.keyboard.press("Escape");
  await expect(page.locator(".selection-dictionary")).toHaveCount(0);
  await expect(page.locator(".modal")).toBeVisible();
});

test("narrow viewport contains word and long sentence lookup panels", async ({
  page,
}) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await openFirstQuestion(page);
  await selectContents(page.locator(".answer-word"));
  await query(page);
  await expect(page.locator(".dictionary-translation").first()).toContainText(
    "前提",
  );
  const assertBounds = async () => {
    const box = await page.locator(".selection-dictionary").boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(320);
    expect(box!.y).toBeGreaterThanOrEqual(0);
    expect(box!.y + box!.height).toBeLessThanOrEqual(740);
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    ).toBeTruthy();
  };
  await assertBounds();
  await page.screenshot({ path: "test-results/dictionary-mobile.png" });
  await page.keyboard.press("Escape");
  await selectContents(page.locator(".sentence"));
  await query(page);
  await expect(page.locator(".dictionary-unavailable")).toBeVisible();
  await assertBounds();
});

test("all four options have explanations and edits require each explanation", async ({
  page,
  request,
}) => {
  await openFirstQuestion(page);
  await page.getByRole("searchbox").clear();
  await expect(page.locator(".reason")).toHaveCount(120);
  await expect(page.locator(".reason-missing")).toHaveCount(0);
  const docs = await (await request.get("/api/documents")).json();
  for (const doc of docs.filter((d: { filename: string; total: number }) =>
    d.filename.endsWith(".pdf"),
  )) {
    const detail = await (await request.get("/api/documents/" + doc.id)).json();
    if (!detail.questions.every((q: { note: unknown }) => q.note)) continue;
    expect(
      detail.questions.every(
        (q: { missing_explanations: string[] }) =>
          !q.missing_explanations.length,
      ),
    ).toBeTruthy();
    const markdown = await (
      await request.get(`/api/documents/${doc.id}/markdown`)
    ).text();
    expect(markdown.match(/解释：/g)).toHaveLength(120);
  }
  await page
    .getByRole("button", { name: "编辑第 1 题笔记", exact: true })
    .click();
  const reason = page
    .getByRole("textbox", { name: "简要解释（必填）", exact: true })
    .nth(3);
  await reason.clear();
  await page.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(page.locator(".modal")).toBeVisible();
  expect(
    await reason.evaluate((e: HTMLTextAreaElement) => e.validity.valueMissing),
  ).toBeTruthy();
});
