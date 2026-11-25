// Copyright (c) 2026 IndyKite
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import express from "express";
import { Hono } from "hono";
import { describe, expect, it, onTestFinished, vi } from "vitest";

import { getDelegatedToken, runWithToken } from "../src/index.js";
import { delegatedToken as expressDelegatedToken } from "../src/server/express.js";
import { delegatedToken as honoDelegatedToken } from "../src/server/hono.js";
import { withDelegatedToken } from "../src/server/mcp-handler.js";

import { serve } from "./harness.js";

describe("express", () => {
  it.each([
    ["before", true],
    ["after", false],
  ])("runs next with the token of the request, mounted %s express.json()", async (_order, before) => {
    const app = express();
    const middlewares = [expressDelegatedToken(), express.json({ limit: "1mb" })];
    app.use(...(before ? middlewares : middlewares.reverse()));
    app.post("/", (_req, res) => {
      res.json({ token: getDelegatedToken() ?? null });
    });
    const server = await serve(() => app);
    onTestFinished(() => server.close());

    // A body large enough to arrive in several chunks
    const body = JSON.stringify({ data: "x".repeat(200_000) });
    const post = (headers: Record<string, string>) =>
      fetch(server.url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    expect(await (await post({ "X-IK-Token": "tok" })).json()).toEqual({ token: "tok" });
    expect(await (await post({})).json()).toEqual({ token: null });
  });
});

describe("hono", () => {
  it("runs next with the token of the request", async () => {
    const app = new Hono();
    app.use(honoDelegatedToken());
    app.get("/", (c) => c.json({ token: getDelegatedToken() ?? null }));

    const get = async (headers: Record<string, string>) => (await app.request("/", { headers })).json();
    expect(await get({ "X-IK-Token": "tok" })).toEqual({ token: "tok" });
    expect(await get({ "X-IK-Token": "" })).toEqual({ token: null });
    expect(await get({})).toEqual({ token: null });
  });
});

describe("withDelegatedToken", () => {
  it("runs the handler with the token and keeps its extra arguments", async () => {
    const handler = vi.fn((_req: Request, context: { params: string }) =>
      Promise.resolve(Response.json({ token: getDelegatedToken() ?? null, params: context.params })),
    );
    const wrapped = withDelegatedToken(handler);

    const response = await wrapped(new Request("http://localhost/", { headers: { "X-IK-Token": "tok" } }), {
      params: "p",
    });
    expect(await response.json()).toEqual({ token: "tok", params: "p" });
    expect(handler).toHaveBeenCalledOnce();
    expect(getDelegatedToken()).toBeUndefined();
  });

  it("runs the handler without a token when the header is missing", () => {
    const wrapped = withDelegatedToken(() => getDelegatedToken());
    expect(runWithToken("outer", () => wrapped(new Request("http://localhost/")))).toBeUndefined();
  });
});
