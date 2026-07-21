import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";
import vm from "node:vm";

const script = await readFile(
  new URL("../src/mo_speech/web/app_public_users.js", import.meta.url),
  "utf8",
);

async function runPublicUsersScript(payload) {
  const fetchCalls = [];
  const status = { textContent: "", dataset: {} };
  const body = {
    children: [],
    replaceChildren() {
      this.children = [];
    },
    append(item) {
      this.children.push(item);
    },
  };
  const root = {
    querySelector(selector) {
      if (selector === "[data-public-users-reload]") {
        return { addEventListener() {} };
      }
      if (selector === "[data-public-users-body]") {
        return body;
      }
      if (selector === "[data-public-users-status]") {
        return status;
      }
      return null;
    },
  };
  const document = {
    querySelectorAll(selector) {
      return selector === "[data-public-users]" ? [root] : [];
    },
    createElement(tagName) {
      return {
        tagName,
        className: "",
        textContent: "",
        children: [],
        append(...items) {
          this.children.push(...items);
        },
      };
    },
  };
  const context = vm.createContext({
    document,
    fetch: async (url) => {
      fetchCalls.push(url);
      return { ok: true, json: async () => payload };
    },
    console,
    Date,
    Error,
    Number,
    Object,
    String,
  });

  vm.runInContext(script, context);
  await new Promise((resolve) => setImmediate(resolve));
  return { fetchCalls, status, body };
}

test("public user list requests the largest page supported by the API", async () => {
  const result = await runPublicUsersScript({ users: [], limit: 2000, stored: 0 });

  assert.deepEqual(result.fetchCalls, ["/api/public-users?limit=2000"]);
});

test("public user list reports omitted users when the stored total exceeds the response", async () => {
  const result = await runPublicUsersScript({
    users: [{ email: "viewer@example.com", usage: {} }],
    limit: 2000,
    stored: 2450,
  });

  assert.equal(result.status.textContent, "全2450件中1件を表示しています。");
});
