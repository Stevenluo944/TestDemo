import { test } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";

import {
  ERROR_CODE,
  ToolError,
  readConfig,
  uriEncode,
  formatSdkDate,
  canonicalQueryString,
  canonicalHeaders,
  buildSignedHeaders,
  toSigningPath,
  callApi,
  normalizeSort,
  validateCreateProject,
  validateListProjects,
  executeTool,
  buildToolDefinitions,
  TOOL_CREATE_PROJECT,
  TOOL_LIST_PROJECTS,
  PATH_CREATE_PROJECT,
  PATH_LIST_PROJECTS,
} from "../server.mjs";

const ENV = {
  CODEARTS_REQ_ENDPOINT: "https://codearts.cn-north-4.myhuaweicloud.com",
  CODEARTS_REQ_AK: "AKIDEXAMPLE",
  CODEARTS_REQ_SK: "SKIDEXAMPLE",
};
const FIXED_DATE = new Date(Date.UTC(2026, 9, 28, 12, 0, 0)); // 20261028T120000Z

/** 解析工具返回文本 */
function parseResult(result) {
  return JSON.parse(result.content[0].text);
}

/** 独立实现的签名字段，用于交叉验证 server 的实现 */
function independentSignature({ method, path, query, body, host, ak, sk, sdkDate, contentType }) {
  const enc = (v, keepSlash) => {
    let out = encodeURIComponent(String(v)).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
    if (!keepSlash) out = out.replace(/%2F/gi, "/");
    return out;
  };
  const headers = { host, "x-sdk-date": sdkDate };
  if (contentType) headers["content-type"] = contentType;
  const names = Object.keys(headers).sort();
  const canonicalHeaders = names.map((n) => `${n}:${headers[n]}\n`).join("");
  const signedHeaders = names.join(";");
  const queryKeys = Object.keys(query || {}).sort();
  const canonicalQuery = queryKeys.map((k) => `${enc(k, true)}=${enc(query[k], true)}`).join("&");
  const payloadHash = crypto.createHash("sha256").update(body, "utf8").digest("hex");
  const canonicalRequest = [
    method.toUpperCase(),
    enc(path, false),
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join("\n");
  const stringToSign = `SDK-HMAC-SHA256\n${sdkDate}\n` + crypto.createHash("sha256").update(canonicalRequest, "utf8").digest("hex");
  const signature = crypto.createHmac("sha256", sk).update(stringToSign, "utf8").digest("hex");
  return {
    signedHeaders,
    signature,
    canonicalRequest,
    stringToSign,
    authorization: `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`,
  };
}

/* ------------------------------ 配置 ------------------------------ */

test("readConfig：缺少配置返回 MISSING_CONFIG 且列出缺失项", () => {
  assert.throws(
    () => readConfig({}),
    (err) => {
      assert.ok(err instanceof ToolError);
      assert.equal(err.code, ERROR_CODE.MISSING_CONFIG);
      assert.deepEqual(err.details.missing, [
        "CODEARTS_REQ_ENDPOINT",
        "CODEARTS_REQ_AK",
        "CODEARTS_REQ_SK",
      ]);
      return true;
    },
  );
});

test("readConfig：合法配置解析出 host 并去除末尾斜杠", () => {
  const config = readConfig({ ...ENV, CODEARTS_REQ_ENDPOINT: ENV.CODEARTS_REQ_ENDPOINT + "/" });
  assert.equal(config.endpoint, ENV.CODEARTS_REQ_ENDPOINT);
  assert.equal(config.host, "codearts.cn-north-4.myhuaweicloud.com");
  assert.equal(config.ak, ENV.CODEARTS_REQ_AK);
  assert.equal(config.sk, ENV.CODEARTS_REQ_SK);
});

test("readConfig：非法 URL 返回 MISSING_CONFIG", () => {
  assert.throws(
    () => readConfig({ ...ENV, CODEARTS_REQ_ENDPOINT: "not-a-url" }),
    (err) => err.code === ERROR_CODE.MISSING_CONFIG,
  );
});

/* ------------------------------ 签名 ------------------------------ */

test("formatSdkDate：输出 UTC 紧凑时间", () => {
  assert.equal(formatSdkDate(FIXED_DATE), "20261028T120000Z");
});

test("uriEncode：保留斜杠与 RFC3986 转义", () => {
  assert.equal(uriEncode("/v4/project", false), "/v4/project");
  assert.equal(uriEncode("a b", true), "a%20b");
  assert.equal(uriEncode("a/b", true), "a%2Fb");
  assert.equal(uriEncode("(x)", true), "%28x%29");
});

test("canonicalQueryString：按参数名升序并编码拼接", () => {
  assert.equal(canonicalQueryString({ b: "2", a: "1", empty: undefined }), "a=1&b=2");
});

test("canonicalHeaders：小写排序并折叠空白", () => {
  const { canonical, signedHeaders } = canonicalHeaders({ "X-Sdk-Date": "20261028T120000Z", Host: "example.com" });
  assert.equal(canonical, "host:example.com\nx-sdk-date:20261028T120000Z\n");
  assert.equal(signedHeaders, "host;x-sdk-date");
});

test("buildSignedHeaders：与独立实现交叉验证，且格式符合规范", () => {
  const params = {
    method: "GET",
    path: "/v4/projects",
    query: { limit: 10, offset: 0 },
    body: "",
    host: "codearts.cn-north-4.myhuaweicloud.com",
    ak: ENV.CODEARTS_REQ_AK,
    sk: ENV.CODEARTS_REQ_SK,
    date: FIXED_DATE,
  };
  const signed = buildSignedHeaders(params);
  const expected = independentSignature({
    method: params.method,
    path: params.path,
    query: params.query,
    body: params.body,
    host: params.host,
    ak: params.ak,
    sk: params.sk,
    sdkDate: "20261028T120000Z",
  });

  assert.equal(signed.signature, expected.signature);
  assert.equal(signed.signedHeaders, expected.signedHeaders);
  assert.equal(signed.canonicalRequest, expected.canonicalRequest);
  assert.equal(signed.stringToSign, expected.stringToSign);

  assert.equal(signed.headers["X-Sdk-Date"], "20261028T120000Z");
  assert.equal(signed.headers.Authorization, expected.authorization);
  assert.match(signed.headers.Authorization, /^SDK-HMAC-SHA256 Access=AKIDEXAMPLE, SignedHeaders=host;x-sdk-date, Signature=[0-9a-f]{64}$/);
});

test("buildSignedHeaders：POST 请求将 content-type 纳入签名", () => {
  const signed = buildSignedHeaders({
    method: "POST",
    path: "/v4/project",
    query: {},
    body: JSON.stringify({ a: 1 }),
    host: "codearts.cn-north-4.myhuaweicloud.com",
    ak: ENV.CODEARTS_REQ_AK,
    sk: ENV.CODEARTS_REQ_SK,
    date: FIXED_DATE,
    contentType: "application/json;charset=utf8",
  });
  assert.match(signed.signedHeaders, /content-type/);
  assert.equal(signed.headers["Content-Type"], "application/json;charset=utf8");
  assert.ok(signed.headers.Authorization.includes("Signature="));
});

/* ------------------------------ 参数校验 ------------------------------ */

test("validateCreateProject：合法参数生成请求体", () => {
  const body = validateCreateProject({
    project_name: "  示例项目  ",
    project_type: "scrum",
    description: "desc",
    source: "src",
  });
  assert.deepEqual(body, {
    project_name: "示例项目",
    project_type: "scrum",
    description: "desc",
    source: "src",
  });
});

test("validateCreateProject：project_name 必填/超长报 INVALID_ARGUMENTS", () => {
  assert.throws(() => validateCreateProject({ project_type: "scrum" }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(
    () => validateCreateProject({ project_name: "x".repeat(129), project_type: "scrum" }),
    (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS,
  );
});

test("validateCreateProject：project_type 枚举校验", () => {
  assert.throws(
    () => validateCreateProject({ project_name: "p", project_type: "unknown" }),
    (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS,
  );
});

test("validateCreateProject：ipd 必须带合法 template_id", () => {
  assert.throws(
    () => validateCreateProject({ project_name: "p", project_type: "ipd" }),
    (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS,
  );
  assert.throws(
    () => validateCreateProject({ project_name: "p", project_type: "ipd", template_id: "99999" }),
    (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS,
  );
  const body = validateCreateProject({ project_name: "p", project_type: "ipd", template_id: 10002 });
  assert.equal(body.template_id, "10002");
});

test("validateCreateProject：source 超长报错", () => {
  assert.throws(
    () => validateCreateProject({ project_name: "p", project_type: "scrum", source: "s".repeat(65) }),
    (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS,
  );
});

test("validateListProjects：默认 offset/limit", () => {
  assert.deepEqual(validateListProjects({}), { offset: 0, limit: 10 });
});

test("validateListProjects：offset 必须是 limit 整数倍", () => {
  assert.throws(
    () => validateListProjects({ offset: 15, limit: 10 }),
    (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS,
  );
  assert.deepEqual(validateListProjects({ offset: 20, limit: 10 }), { offset: 20, limit: 10 });
});

test("validateListProjects：范围校验", () => {
  assert.throws(() => validateListProjects({ offset: 10001 }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(() => validateListProjects({ limit: 0 }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(() => validateListProjects({ limit: 1001 }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(() => validateListProjects({ limit: 1.5 }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
});

test("validateListProjects：project_type/query_type 枚举与 archive 布尔", () => {
  assert.throws(() => validateListProjects({ project_type: "ipd" }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(() => validateListProjects({ query_type: "foo" }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(() => validateListProjects({ archive: "yes" }), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.deepEqual(validateListProjects({ archive: true, query_type: "domain_projects" }), {
    offset: 0,
    limit: 10,
    archive: true,
    query_type: "domain_projects",
  });
});

test("normalizeSort：格式与组数校验", () => {
  assert.equal(normalizeSort("name:asc,age:desc"), "name:asc,age:desc");
  assert.equal(normalizeSort("name:ASC"), "name:asc");
  assert.throws(() => normalizeSort("name"), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(() => normalizeSort("a:up"), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
  assert.throws(() => normalizeSort("a:1,b:2,c:3,d:4,e:5"), (e) => e.code === ERROR_CODE.INVALID_ARGUMENTS);
});

test("toSigningPath：为规范 URI 补尾斜杠", () => {
  assert.equal(toSigningPath("/v4/projects"), "/v4/projects/");
  assert.equal(toSigningPath("/v4/project/"), "/v4/project/");
  assert.equal(toSigningPath(""), "/");
});

test("callApi：签名 URI 补尾斜杠，而实际请求 URL 保持原样", async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return { ok: true, status: 200, text: async () => JSON.stringify({ projects: [], total: 0 }) };
  };
  const config = {
    endpoint: ENV.CODEARTS_REQ_ENDPOINT,
    host: "codearts.cn-north-4.myhuaweicloud.com",
    ak: ENV.CODEARTS_REQ_AK,
    sk: ENV.CODEARTS_REQ_SK,
  };
  const res = await callApi({
    config,
    method: "GET",
    path: PATH_LIST_PROJECTS,
    query: { offset: 0, limit: 10 },
    fetchImpl: fakeFetch,
    date: FIXED_DATE,
  });

  assert.ok(captured.url.startsWith(`${ENV.CODEARTS_REQ_ENDPOINT}${PATH_LIST_PROJECTS}?`));
  assert.ok(!captured.url.includes("/v4/projects/?"));
  const lines = res.sdk_request.canonicalRequest.split("\n");
  assert.equal(lines[0], "GET");
  assert.equal(lines[1], "/v4/projects/");
});

/* ------------------------------ 工具执行 ------------------------------ */

test("executeTool：缺配置返回 MISSING_CONFIG（isError）", async () => {
  const res = await executeTool(TOOL_CREATE_PROJECT, { project_name: "p", project_type: "scrum" }, { env: {} });
  assert.equal(res.isError, true);
  const payload = parseResult(res);
  assert.equal(payload.ok, false);
  assert.equal(payload.code, ERROR_CODE.MISSING_CONFIG);
  assert.ok(payload.message.includes("CODEARTS_REQ_ENDPOINT"));
});

test("executeTool：参数非法返回 INVALID_ARGUMENTS（isError）", async () => {
  const res = await executeTool(TOOL_LIST_PROJECTS, { offset: 3, limit: 2 }, { env: ENV });
  assert.equal(res.isError, true);
  const payload = parseResult(res);
  assert.equal(payload.code, ERROR_CODE.INVALID_ARGUMENTS);
});

test("executeTool：create_project 成功（POST /v4/project）", async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      status: 200,
      text: async () =>
        JSON.stringify({
          project_id: "pid-1",
          project_num_id: 1001,
          project_name: "示例项目",
          project_type: "scrum",
          user_num_id: 88,
          extra: "ignored",
        }),
    };
  };

  const res = await executeTool(
    TOOL_CREATE_PROJECT,
    { project_name: "示例项目", project_type: "scrum" },
    { env: ENV, fetchImpl: fakeFetch, date: FIXED_DATE },
  );

  assert.equal(res.isError, undefined);
  const payload = parseResult(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.project_id, "pid-1");
  assert.equal(payload.project_num_id, 1001);
  assert.equal(payload.project_name, "示例项目");
  assert.equal(payload.project_type, "scrum");
  assert.equal(payload.user_num_id, 88);

  assert.equal(captured.url, "https://codearts.cn-north-4.myhuaweicloud.com" + PATH_CREATE_PROJECT);
  assert.equal(captured.opts.method, "POST");
  assert.equal(captured.opts.headers["X-Sdk-Date"], "20261028T120000Z");
  assert.match(captured.opts.headers.Authorization, /^SDK-HMAC-SHA256 Access=/);
  assert.deepEqual(JSON.parse(captured.opts.body), { project_name: "示例项目", project_type: "scrum" });
});

test("executeTool：list_projects 成功（GET /v4/projects，含 query）", async () => {
  let captured;
  const fakeFetch = async (url, opts) => {
    captured = { url, opts };
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ projects: [{ project_id: "a" }, { project_id: "b" }], total: 42 }),
    };
  };

  const res = await executeTool(
    TOOL_LIST_PROJECTS,
    { offset: 20, limit: 10, search: "demo", archive: false },
    { env: ENV, fetchImpl: fakeFetch, date: FIXED_DATE },
  );

  assert.equal(res.isError, undefined);
  const payload = parseResult(res);
  assert.equal(payload.ok, true);
  assert.equal(payload.total, 42);
  assert.equal(payload.projects.length, 2);
  assert.equal(payload.projects[0].project_id, "a");

  assert.ok(captured.url.startsWith("https://codearts.cn-north-4.myhuaweicloud.com" + PATH_LIST_PROJECTS + "?"));
  assert.match(captured.url, /offset=20/);
  assert.match(captured.url, /limit=10/);
  assert.match(captured.url, /search=demo/);
  assert.match(captured.url, /archive=false/);
  assert.equal(captured.opts.method, "GET");
  assert.equal(captured.opts.body, undefined);
});

test("executeTool：API 报错透传 error_code/error_msg/http_status", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 400,
    text: async () => JSON.stringify({ error_code: "REQ.0101", error_msg: "项目名称已存在" }),
  });

  const res = await executeTool(
    TOOL_CREATE_PROJECT,
    { project_name: "p", project_type: "scrum" },
    { env: ENV, fetchImpl: fakeFetch, date: FIXED_DATE },
  );

  assert.equal(res.isError, true);
  const payload = parseResult(res);
  assert.equal(payload.ok, false);
  assert.equal(payload.error_code, "REQ.0101");
  assert.equal(payload.error_msg, "项目名称已存在");
  assert.equal(payload.http_status, 400);
});

test("executeTool：嵌套 error 结构也能透传", async () => {
  const fakeFetch = async () => ({
    ok: false,
    status: 403,
    text: async () => JSON.stringify({ error: { code: "APIGW.0301", message: "permission denied" } }),
  });

  const res = await executeTool(TOOL_LIST_PROJECTS, {}, { env: ENV, fetchImpl: fakeFetch, date: FIXED_DATE });
  const payload = parseResult(res);
  assert.equal(res.isError, true);
  assert.equal(payload.error_code, "APIGW.0301");
  assert.equal(payload.error_msg, "permission denied");
  assert.equal(payload.http_status, 403);
});

test("executeTool：网络异常返回 NETWORK_ERROR", async () => {
  const fakeFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND");
  };

  const res = await executeTool(TOOL_LIST_PROJECTS, {}, { env: ENV, fetchImpl: fakeFetch, date: FIXED_DATE });
  assert.equal(res.isError, true);
  const payload = parseResult(res);
  assert.equal(payload.code, ERROR_CODE.NETWORK_ERROR);
  assert.ok(payload.message.includes("网络异常"));
});

test("executeTool：未知工具返回 INVALID_ARGUMENTS", async () => {
  const res = await executeTool("nope", {}, { env: ENV });
  assert.equal(res.isError, true);
  assert.equal(parseResult(res).code, ERROR_CODE.INVALID_ARGUMENTS);
});

/* ------------------------------ 工具定义 ------------------------------ */

test("buildToolDefinitions：暴露 create_project 与 list_projects", () => {
  const defs = buildToolDefinitions();
  assert.deepEqual(
    defs.map((d) => d.name),
    [TOOL_CREATE_PROJECT, TOOL_LIST_PROJECTS],
  );
  for (const def of defs) {
    assert.equal(def.config.inputSchema.type, "object");
    assert.ok(typeof def.config.description === "string" && def.config.description.length > 0);
  }
  const createSchema = defs[0].config.inputSchema;
  assert.deepEqual(createSchema.required, ["project_name", "project_type"]);
  assert.deepEqual(createSchema.properties.project_type.enum, [
    "scrum",
    "normal",
    "xboard",
    "basic",
    "phoenix",
    "ipd",
  ]);
});