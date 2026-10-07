import { test, expect, type Page } from "@playwright/test";
const password = "Synthetic-password-2026!";
async function register(page: Page, name: string) {
  await page.goto("/");
  await page
    .getByRole("button", { name: "New to TaskForge? Create an account" })
    .click();
  await page.getByLabel("Your name").fill(name);
  await page
    .getByLabel("Email address")
    .fill(name.toLowerCase() + "@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page
    .getByRole("button", { name: "Create account", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
}

test("owner creates, edits, filters, comments, reviews history and changes password", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await register(page, "Workflow");
  await page.getByLabel("Project name").fill("Release planning");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("button", { name: "+ New task", exact: true }).click();
  await page.getByLabel("Title", { exact: true }).fill("Write release notes");
  await page
    .getByLabel("Description", { exact: true })
    .fill("Summarize the improvements.");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await page.getByRole("link", { name: /Write release notes/ }).click();
  await page.getByLabel("Title", { exact: true }).fill("Publish release notes");
  await page
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("done");
  await page.getByRole("button", { name: "Save changes", exact: true }).click();
  await expect(page.getByText("Changes saved.", { exact: true })).toBeVisible();
  await expect(
    page.getByRole("heading", { name: "Publish release notes" }),
  ).toBeVisible();
  await page.getByLabel("Add a comment").fill("Ready for review");
  await page.getByRole("button", { name: "Post comment" }).click();
  await expect(
    page.getByText("Ready for review", { exact: true }),
  ).toBeVisible();
  await page.reload();
  await expect(page.getByLabel("Title", { exact: true })).toHaveValue(
    "Publish release notes",
  );
  await expect(
    page.getByText("Ready for review", { exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "All tasks" }).click();
  await expect(page.getByRole("heading", { name: /^Tasks/ })).toBeVisible();
  await page
    .getByRole("combobox", { name: "Status", exact: true })
    .selectOption("todo");
  await page.getByRole("button", { name: "Apply filters" }).click();
  await expect(page.getByText("No tasks match your filters.")).toBeVisible();
  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await page.getByRole("link", { name: /Publish release notes/ }).click();
  page.on("dialog", (d) => d.accept());
  await page
    .getByRole("button", { name: "Delete comment by Workflow" })
    .click();
  await expect(page.getByText("No comments yet.")).toBeVisible();
  await page.getByRole("button", { name: "Delete task", exact: true }).click();
  await page.getByRole("link", { name: "activity", exact: true }).click();
  await expect(page.getByText(/task deleted/)).toBeVisible();
  await page.getByRole("link", { name: "settings", exact: true }).click();
  await page.getByLabel("Project name").fill("Release archive");
  await page.getByRole("button", { name: "Rename project" }).click();
  await expect(
    page.getByRole("heading", { name: "Release archive" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Delete project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Projects", exact: true }),
  ).toBeVisible();
  await page.getByRole("link", { name: "Workflow", exact: true }).click();
  await page.getByLabel("Current password").fill(password);
  await page
    .getByLabel("New password (12–128 characters)")
    .fill(password + "new");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(
    page.getByText("Password changed. Please sign in with your new password."),
  ).toBeVisible();
  expect(errors).toEqual([]);
});

test("shareable invitation, read-only viewer, editor promotion and removal", async ({
  page,
  browser,
}) => {
  await register(page, "Teamowner");
  await page.getByLabel("Project name").fill("Team project");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Team project", exact: true }),
  ).toBeVisible();
  const projectUrl = page.url();
  await page.getByRole("link", { name: "Members & invites" }).click();
  await page.getByLabel("Email address").fill("teammate@example.test");
  await page
    .getByRole("combobox", { name: "Role", exact: true })
    .selectOption("viewer");
  await page.getByRole("button", { name: "Generate invitation" }).click();
  const invitation = await page
    .getByLabel("Share this invitation link")
    .inputValue();
  const context = await browser.newContext();
  const member = await context.newPage();
  try {
    await member.goto(invitation);
    await member
      .getByRole("button", { name: "New to TaskForge? Create an account" })
      .click();
    await member.getByLabel("Your name").fill("Teammate");
    await member.getByLabel("Email address").fill("teammate@example.test");
    await member.getByLabel("Password", { exact: true }).fill(password);
    await member
      .getByRole("button", { name: "Create account", exact: true })
      .click();
    await member.getByRole("button", { name: "Join project" }).click();
    await expect(
      member.getByRole("heading", { name: "Team project", exact: true }),
    ).toBeVisible();
    await expect(
      member.getByRole("button", { name: "+ New task" }),
    ).toHaveCount(0);
    await page.reload();
    await page.getByLabel("Role for Teammate").selectOption("editor");
    await expect(page.getByLabel("Role for Teammate")).toHaveValue("editor");
    await member.reload();
    await member.getByRole("button", { name: "+ New task" }).click();
    await member.getByLabel("Title", { exact: true }).fill("Editor task");
    await member
      .getByRole("button", { name: "Create task", exact: true })
      .click();
    await expect(
      member.getByRole("link", { name: /Editor task/ }),
    ).toBeVisible();
    page.on("dialog", (d) => d.accept());
    await page.getByRole("button", { name: "Remove", exact: true }).click();
    await expect(page.getByLabel("Role for Teammate")).toHaveCount(0);
    await member.goto(projectUrl);
    await member.reload();
    await expect(member.getByRole("alert")).toContainText("Project not found");
  } finally {
    await context.close();
  }
});

test("mobile layout is usable and expired sessions return to sign in", async ({
  page,
  context,
}) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await register(page, "Mobile");
  await page.getByLabel("Project name").fill("Mobile work");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await page.getByRole("button", { name: "+ New task" }).click();
  await page.getByLabel("Title", { exact: true }).fill("A small-screen task");
  await page.getByRole("button", { name: "Create task", exact: true }).click();
  await expect(
    page.getByRole("link", { name: /A small-screen task/ }),
  ).toBeVisible();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
  ).toBe(true);
  await context.clearCookies();
  await page.getByRole("link", { name: /A small-screen task/ }).click();
  await expect(
    page.getByText("Your session expired. Please sign in again."),
  ).toBeVisible();
});

test("account reports wrong password but signs out an expired session", async ({
  page,
  context,
}) => {
  await register(page, "Accountstate");
  await page.getByRole("link", { name: "Accountstate", exact: true }).click();
  await page.getByLabel("Current password").fill("wrong-password");
  await page
    .getByLabel("New password (12–128 characters)")
    .fill(password + "new");
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "Invalid email or password",
  );
  await expect(
    page.getByRole("heading", { name: "Accountstate" }),
  ).toBeVisible();
  await context.clearCookies();
  await page.getByLabel("Current password").fill(password);
  await page.getByRole("button", { name: "Update password" }).click();
  await expect(
    page.getByText("Your session expired. Please sign in again."),
  ).toBeVisible();
});

test("read errors offer retry and invalid submissions show server validation", async ({
  page,
}) => {
  await register(page, "Recovery");
  await page.getByLabel("Project name").fill("   ");
  await page
    .getByRole("button", { name: "Create project", exact: true })
    .click();
  await expect(page.getByRole("alert")).toContainText("Project name must be");
  await page.route("**/api/projects", (route) =>
    route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "Synthetic temporary failure" }),
    }),
  );
  await page.reload();
  await expect(page.getByRole("alert")).toContainText(
    "Synthetic temporary failure",
  );
  await page.unroute("**/api/projects");
  await page.getByRole("button", { name: "Try again" }).click();
  await expect(
    page.getByText(
      "No projects yet. Create your first one or accept an invitation.",
    ),
  ).toBeVisible();
});

test("runtime serves SPA and JSON failures, including oversized input", async ({
  request,
}) => {
  const spa = await request.get("/projects/a-direct-link");
  expect(spa.status()).toBe(200);
  expect(spa.headers()["content-type"]).toContain("text/html");
  const unknown = await request.get("/api/unknown");
  expect(unknown.status()).toBe(404);
  expect((await unknown.json()).error).toBeTruthy();
  const directory = await request.get("/assets/");
  expect(directory.status()).toBe(404);
  const large = await request.post("/api/auth/register", {
    data: { name: "x".repeat(70000) },
  });
  expect(large.status()).toBe(400);
  expect((await large.json()).error).toContain("large");
});
