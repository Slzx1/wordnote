import { expect, test, type APIRequestContext } from "@playwright/test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

async function createCopy(request: APIRequestContext) {
  const name = (await readdir(process.cwd()))
    .filter((name) => name.endsWith(".pdf"))
    .sort()[0];
  const response = await request.post("/api/documents?duplicate=true", {
    multipart: {
      file: {
        name,
        mimeType: "application/pdf",
        buffer: await readFile(join(process.cwd(), name)),
      },
    },
  });
  expect(response.status()).toBe(200);
  return (await response.json()).id as string;
}

test("delete confirmation can cancel or retry and removes only the selected document", async ({
  page,
  request,
}) => {
  const before = await (await request.get("/api/documents")).json();
  const id = await createCopy(request);
  await page.addInitScript(
    (id) => localStorage.setItem("wordnote.document", id),
    id,
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto("/");
  await expect(page.locator(".document-item")).toHaveCount(before.length + 1);
  await page.getByRole("button", { name: "删除资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除这份资料？" });
  await expect(dialog).toContainText("30 道题目");
  await expect(dialog).toContainText("无法撤销");
  await page.screenshot({ path: "test-results/delete-desktop.png" });
  await page.getByRole("button", { name: "取消", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await request.get("/api/documents/" + id)).status()).toBe(200);
  await page.getByRole("button", { name: "删除资料", exact: true }).click();
  await page.route("**/api/documents/" + id, (route) =>
    route.request().method() === "DELETE"
      ? route.fulfill({
          status: 409,
          json: { detail: "任务尚未结束，请稍后重试" },
        })
      : route.continue(),
  );
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog.getByRole("alert")).toContainText("请稍后重试");
  await expect(page.locator(".document-item")).toHaveCount(before.length + 1);
  await page.unroute("**/api/documents/" + id);
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.locator(".document-item")).toHaveCount(before.length);
  await expect(page.locator(".question")).toHaveCount(30);
  expect((await request.get("/api/documents/" + id)).status()).toBe(404);
  const selected = await page.evaluate(() =>
    localStorage.getItem("wordnote.document"),
  );
  expect(before.map((doc: { id: string }) => doc.id)).toContain(selected);
  await page.reload();
  await expect(page.locator(".document-item")).toHaveCount(before.length);
  await expect(page.locator(".question")).toHaveCount(30);
});

test("deleting the last visible document returns to an importable empty library on mobile", async ({
  page,
  request,
}) => {
  const id = await createCopy(request);
  // Give this browser its own one-document library while exercising the real
  // deletion endpoint against a disposable copy in the test database.
  await page.route("**/api/documents", async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const response = await request.get("/api/documents/" + id);
    const summary = response.ok() ? await response.json() : null;
    await route.fulfill({
      json: summary
        ? [
            {
              ...summary,
              total: summary.questions.length,
              completed: 0,
              review_count: 0,
            },
          ]
        : [],
    });
  });
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto("/");
  await page.getByRole("button", { name: "删除资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除这份资料？" });
  await expect(dialog).toBeVisible();
  const box = await dialog.boundingBox();
  expect(box!.x).toBeGreaterThanOrEqual(0);
  expect(box!.x + box!.width).toBeLessThanOrEqual(320);
  expect(box!.y + box!.height).toBeLessThanOrEqual(740);
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBeTruthy();
  await page.screenshot({ path: "test-results/delete-mobile.png" });
  await page.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(
    page.getByRole("button", { name: "导入词汇练习", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".question")).toHaveCount(0);
  await expect(page.locator(".document-item")).toHaveCount(0);
  expect(
    await page.evaluate(() => localStorage.getItem("wordnote.document")),
  ).toBeNull();
  await page.reload();
  await expect(
    page.getByRole("button", { name: "导入词汇练习", exact: true }),
  ).toBeEnabled();
  expect((await request.get("/api/documents/" + id)).status()).toBe(404);
});

test("a generating document offers stop before deletion", async ({
  page,
  request,
}) => {
  const id = await createCopy(request);
  let stopped = false;
  await page.addInitScript(
    (id) => localStorage.setItem("wordnote.document", id),
    id,
  );
  await page.route("**/api/documents/" + id, async (route) => {
    if (route.request().method() !== "GET") return route.continue();
    const detail = await (await request.get("/api/documents/" + id)).json();
    await route.fulfill({
      json: {
        ...detail,
        job: {
          id: "ui-test",
          status: stopped ? "stopped" : "running",
          total: 30,
          completed: 0,
          failed: 0,
          error: "",
          stop: Number(stopped),
        },
      },
    });
  });
  await page.route("**/api/documents/" + id + "/stop", (route) => {
    stopped = true;
    return route.fulfill({ json: { ok: true } });
  });
  await page.goto("/");
  await page.getByRole("button", { name: "删除资料", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "删除这份资料？" });
  await expect(dialog).toContainText("生成任务尚未结束");
  await expect(
    dialog.getByRole("button", { name: "确认删除", exact: true }),
  ).toHaveCount(0);
  await dialog.getByRole("button", { name: "停止生成", exact: true }).click();
  await dialog.getByRole("button", { name: "确认删除", exact: true }).click();
  await expect(dialog).toHaveCount(0);
  expect((await request.get("/api/documents/" + id)).status()).toBe(404);
});
