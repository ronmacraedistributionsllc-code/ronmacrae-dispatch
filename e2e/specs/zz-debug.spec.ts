import { test } from "@playwright/test";

test("debug8: two parallel contexts same user", async ({ browser }) => {
  const login = async (page: import("@playwright/test").Page, tag: string) => {
    page.on("response", (res) => {
      if (res.url().includes("/api/auth/refresh") || res.url().includes("/api/auth/login")) {
        const setCookie = res.headers()["set-cookie"] ?? "";
        console.log(`[${tag}] ${res.status()} ${res.request().method()} ${res.url().replace("http://localhost:3000", "")} set-cookie=${setCookie.slice(0, 45)}…`);
      }
    });
  };

  const c1 = await browser.newContext();
  const c2 = await browser.newContext();
  const p1 = await c1.newPage();
  const p2 = await c2.newPage();
  login(p1, "ctx1");
  login(p2, "ctx2");

  for (const [p, tag] of [
    [p1, "ctx1"],
    [p2, "ctx2"],
  ] as const) {
    await p.goto("/login");
    await p.getByLabel("Email or phone").fill("dispatcher@ronmacrae.example");
    await p.getByLabel("Password").fill("dispatch1234");
    await p.getByRole("button", { name: "Sign in" }).click();
    await p.waitForTimeout(1500);
    const cs = await p.context().cookies();
    console.log(`[${tag}] after login: ${cs.map((c) => `${c.name}=${c.value.slice(30, 45)}… path=${c.path}`).join(" | ") || "(empty)"}`);
  }

  console.log("--- both goto /jobs (parallel) ---");
  await Promise.all([p1.goto("/jobs"), p2.goto("/jobs")]);
  await p1.waitForTimeout(6000);
  await p2.waitForTimeout(6000);

  for (const [c, tag] of [
    [c1, "ctx1"],
    [c2, "ctx2"],
  ] as const) {
    const cs = await c.cookies();
    console.log(`[${tag}] after reload: ${cs.map((c) => `${c.name}=${c.value.slice(30, 45)}… path=${c.path}`).join(" | ") || "(empty)"}`);
  }
  console.log(`final: ctx1 url=${(await p1.evaluate(() => location.href))} ctx2 url=${(await p2.evaluate(() => location.href))}`);
});
