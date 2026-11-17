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

import { describe, expect, it } from "vitest";

import {
  A2A_EXTENSION_URI,
  A2A_EXTENSIONS_HEADER,
  DELEGATED_TOKEN_HEADER,
  getDelegatedToken,
  type HeadersLike,
  MCP_EXTENSION_ID,
  runWithToken,
  tokenFromContext,
  tokenFromHeaders,
  type ToolContext,
} from "../src/index.js";

describe("constants", () => {
  it("match the gateway", () => {
    expect(DELEGATED_TOKEN_HEADER).toBe("X-IK-Token");
    expect(MCP_EXTENSION_ID).toBe("com.indykite/delegated-token");
    expect(A2A_EXTENSION_URI).toBe("https://indykite.com/extensions/delegated-token/v1");
    expect(A2A_EXTENSIONS_HEADER).toBe("A2A-Extensions");
  });
});

describe("runWithToken", () => {
  it("has no token outside a request", () => {
    expect(getDelegatedToken()).toBeUndefined();
  });

  it("restores the outer token", () => {
    runWithToken("outer", () => {
      runWithToken("inner", () => {
        expect(getDelegatedToken()).toBe("inner");
      });
      expect(getDelegatedToken()).toBe("outer");
    });
    expect(getDelegatedToken()).toBeUndefined();
  });

  it("restores the outer token on errors", () => {
    expect(() =>
      runWithToken("token", () => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(getDelegatedToken()).toBeUndefined();
  });

  it("keeps the token across async work", async () => {
    const seen = await runWithToken("token", async () => {
      await new Promise((resolve) => setTimeout(resolve, 1));
      return getDelegatedToken();
    });
    expect(seen).toBe("token");
  });

  it.each([[""], [null], [undefined]])("treats %j as no token", (token) => {
    runWithToken("outer", () => {
      runWithToken(token, () => {
        expect(getDelegatedToken()).toBeUndefined();
      });
    });
  });
});

describe("tokenFromHeaders", () => {
  it.each<[HeadersLike | null | undefined, string | undefined]>([
    [{ "X-IK-Token": "a" }, "a"],
    [{ "x-ik-token": "b" }, "b"],
    [{ "X-Ik-Token": "c" }, "c"],
    [{ "x-ik-token": ["d"] }, "d"],
    [{ "x-ik-token": ["d", "e"] }, undefined],
    [{ "x-ik-token": "d, e" }, undefined],
    [{ "X-IK-Token": "d", "x-ik-token": "e" }, undefined],
    [{ "x-ik-token": [] }, undefined],
    [{ "x-ik-token": "" }, undefined],
    [{ "x-ik-token": undefined }, undefined],
    [{ other: "x" }, undefined],
    [{}, undefined],
    [new Headers({ "X-IK-Token": "f" }), "f"],
    [new Headers({ "x-ik-token": "" }), undefined],
    [
      new Headers([
        ["X-IK-Token", "d"],
        ["X-IK-Token", "e"],
      ]),
      undefined,
    ],
    [new Headers(), undefined],
    [null, undefined],
    [undefined, undefined],
  ])("reads %j as %j", (headers, expected) => {
    expect(tokenFromHeaders(headers)).toBe(expected);
  });
});

describe("tokenFromContext", () => {
  it.each<[ToolContext | null | undefined, string | undefined]>([
    [{ requestInfo: { headers: { "x-ik-token": "v1" } } }, "v1"],
    [{ http: { req: new Request("http://localhost/", { headers: { "X-IK-Token": "v2" } }) } }, "v2"],
    [{ requestInfo: {} }, undefined],
    [{ http: {} }, undefined],
    [{}, undefined],
    [null, undefined],
    [undefined, undefined],
  ])("reads %o as %j", (context, expected) => {
    expect(tokenFromContext(context)).toBe(expected);
  });
});
