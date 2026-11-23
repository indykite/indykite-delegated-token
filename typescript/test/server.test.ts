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

import { request } from "node:http";

import express from "express";
import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";

import { getDelegatedToken, runWithToken } from "../src/index.js";
import { delegatedToken as expressDelegatedToken } from "../src/server/express.js";
import { delegatedToken as honoDelegatedToken } from "../src/server/hono.js";
import { withDelegatedToken } from "../src/server/mcp-handler.js";

import { serveForTest } from "./harness.js";

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
    const url = await serveForTest(() => app);

    // A body large enough to arrive in several chunks
    const body = JSON.stringify({ data: "x".repeat(200_000) });
    const post = (headers: Record<string, string>) =>
      fetch(url, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body });
    expect(await (await post({ "X-IK-Token": "tok" })).json()).toEqual({ token: "tok" });
    expect(await (await post({})).json()).toEqual({ token: null });
  });
});

interface Seen {
  token: string | null;
  headers: Record<string, unknown>;
  headersDistinct: Record<string, unknown>;
  rawHeaders: string[];
}

/** Send a GET with raw headers, as name-value pairs, and return what the handler saw. */
function getRaw(url: string, rawHeaders: string[]): Promise<Seen> {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: rawHeaders }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve(JSON.parse(Buffer.concat(chunks).toString("utf8")) as Seen);
      });
    });
    req.on("error", reject);
    req.end();
  });
}

describe("express stripHeader", () => {
  const sent = [
    "Host",
    "localhost",
    "Connection",
    "close",
    "X-Dup",
    "a",
    "x-ik-token",
    "tok",
    "Authorization",
    "Bearer b",
    "X-Dup",
    "b",
  ];

  /** With `readFirst`, a middleware before `delegatedToken()` reads `req.headersDistinct`. */
  function serveWith(stripHeader?: boolean, readFirst = false): Promise<string> {
    const app = express();
    if (readFirst) {
      app.use((req, _res, next) => {
        expect(req.headersDistinct["x-ik-token"]).toEqual(["tok"]);
        next();
      });
    }
    app.use(expressDelegatedToken(stripHeader === undefined ? undefined : { stripHeader }));
    app.get("/", (req, res) => {
      const { headers, headersDistinct, rawHeaders } = req;
      res.json({ token: getDelegatedToken() ?? null, headers, headersDistinct, rawHeaders });
    });
    return serveForTest(() => app);
  }

  it.each([false, true])(
    "removes the header and keeps the token and the other headers in order, read first %s",
    async (readFirst) => {
      const seen = await getRaw(await serveWith(true, readFirst), sent);

      expect(seen.token).toBe("tok");
      expect(seen.headers).not.toHaveProperty("x-ik-token");
      expect(seen.headers).toMatchObject({ "x-dup": "a, b", authorization: "Bearer b" });
      expect(seen.headersDistinct).not.toHaveProperty("x-ik-token");
      expect(seen.headersDistinct).toMatchObject({ "x-dup": ["a", "b"], authorization: ["Bearer b"] });
      expect(seen.rawHeaders).toEqual([
        "Host",
        "localhost",
        "Connection",
        "close",
        "X-Dup",
        "a",
        "Authorization",
        "Bearer b",
        "X-Dup",
        "b",
      ]);
    },
  );

  it("removes every copy of the header", async () => {
    const seen = await getRaw(await serveWith(true), [
      "Host",
      "localhost",
      "Connection",
      "close",
      "X-IK-Token",
      "a",
      "x-ik-token",
      "b",
    ]);

    expect(seen.token).toBeNull();
    expect(seen.headers).not.toHaveProperty("x-ik-token");
    expect(seen.headersDistinct).not.toHaveProperty("x-ik-token");
    expect(seen.rawHeaders.map((value) => value.toLowerCase())).not.toContain("x-ik-token");
  });

  it.each([undefined, false])("keeps the header with stripHeader %s", async (stripHeader) => {
    const seen = await getRaw(await serveWith(stripHeader), sent);

    expect(seen.token).toBe("tok");
    expect(seen.headers).toHaveProperty("x-ik-token", "tok");
    expect(seen.headersDistinct).toHaveProperty("x-ik-token", ["tok"]);
    expect(seen.rawHeaders).toContain("x-ik-token");
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
