#!/usr/bin/env node
/**
 * codearts-req — 华为云 CodeArts 需求管理（Req）本地 stdio MCP Server
 *
 * 环境变量：
 *   CODEARTS_REQ_ENDPOINT  终端节点，例如 https://codearts.cn-north-4.myhuaweicloud.com
 *   CODEARTS_REQ_AK        Access Key
 *   CODEARTS_REQ_SK        Secret Key
 *
 * 鉴权：SDK-HMAC-SHA256（请求头 Authorization + X-Sdk-Date）
 *
 * 该文件同时是「可运行入口」与「可测试模块」：
 *   - 直接 `node server.mjs` 时启动 stdio MCP Server（动态 import SDK，避免测试环境强依赖）。
 *   - 被测试 import 时只导出纯函数，不触碰 stdio。
 */

import crypto from "node:crypto";
import { pathToFileURL } from "node:url";

export const SERVER_NAME = "codearts-req";
export const SERVER_VERSION = "1.0.0";

export const TOOL_CREATE_PROJECT = "create_project";
export const TOOL_LIST_PROJECTS = "list_projects";

export const PROJECT_TYPES = Object.freeze(["scrum", "normal", "xboard", "basic", "phoenix", "ipd"]);
export const LIST_PROJECT_TYPES = Object.freeze(["scrum", "normal", "xboard"]);
export const TEMPLATE_IDS = Object.freeze(["10001", "10002", "10003"]);
export const QUERY_TYPES = Object.freeze(["domain_projects", "absent"]);

export const PATH_CREATE_PROJECT = "/v4/project";
export const PATH_LIST_PROJECTS = "/v4/projects";

export const ERROR_CODE = Object.freeze({
  INVALID_ARGUMENTS: "INVALID_ARGUMENTS",
  MISSING_CONFIG: "MISSING_CONFIG",
  API_ERROR: "API_ERROR",
  NETWORK_ERROR: "NETWORK_ERROR",
});

const DEFAULT_TIMEOUT_MS = 30000;

/** 结构化工具错误：携带稳定 error code 与可选 details */
export class ToolError extends Error {
  constructor(code, message, details) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.details = details || {};
  }
}

/* -------------------------------------------------------------------------- */
/* 配置                                                                        */
/* -------------------------------------------------------------------------- */

export function readConfig(env = process.env) {
  const endpoint = String(env.CODEARTS_REQ_ENDPOINT || "").trim();
  const ak = String(env.CODEARTS_REQ_AK || "").trim();
  const sk = String(env.CODEARTS_REQ_SK || "").trim();

  const missing = [];
  if (!endpoint) missing.push("CODEARTS_REQ_ENDPOINT");
  if (!ak) missing.push("CODEARTS_REQ_AK");
  if (!sk) missing.push("CODEARTS_REQ_SK");
  if (missing.length > 0) {
    throw new ToolError(
      ERROR_CODE.MISSING_CONFIG,
      `缺少必需的环境变量：${missing.join("、")}。请在启动 MCP Server 前完成配置后重试。`,
      { missing },
    );
  }

  let url;
  try {
    url = new URL(endpoint);
  } catch {
    throw new ToolError(
      ERROR_CODE.MISSING_CONFIG,
      `环境变量 CODEARTS_REQ_ENDPOINT 不是合法的 URL：${endpoint}`,
      { endpoint },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new ToolError(
      ERROR_CODE.MISSING_CONFIG,
      `环境变量 CODEARTS_REQ_ENDPOINT 仅支持 http/https 协议，实际为：${url.protocol}`,
      { endpoint },
    );
  }

  return { endpoint: endpoint.replace(/\/+$/, ""), host: url.host, ak, sk };
}

/* -------------------------------------------------------------------------- */
/* AK/SK 签名（SDK-HMAC-SHA256）                                                */
/* -------------------------------------------------------------------------- */

function sha256Hex(data) {
  return crypto.createHash("sha256").update(data, "utf8").digest("hex");
}

function hmacSha256Hex(key, data) {
  return crypto.createHmac("sha256", key).update(data, "utf8").digest("hex");
}

/** RFC3986 URI 编码；encodeSlash=false 时保留 "/" */
export function uriEncode(value, encodeSlash = true) {
  let out = encodeURIComponent(String(value));
  out = out.replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
  if (!encodeSlash) out = out.replace(/%2F/gi, "/");
  return out;
}

/** X-Sdk-Date：UTC 时间，格式 YYYYMMDDTHHMMSSZ */
export function formatSdkDate(date = new Date()) {
  const p = (n, len = 2) => String(n).padStart(len, "0");
  return (
    `${p(date.getUTCFullYear(), 4)}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}` +
    `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`
  );
}

/** 规范化查询串：按参数名 ASCII 升序，key/value 均做 URI 编码 */
export function canonicalQueryString(query = {}) {
  return Object.keys(query)
    .filter((k) => query[k] !== undefined && query[k] !== null)
    .sort()
    .map((k) => `${uriEncode(k, true)}=${uriEncode(query[k], true)}`)
    .join("&");
}

/** 规范化请求头：小写、按名排序、值折叠空白，返回 { canonical, signedHeaders } */
export function canonicalHeaders(headers) {
  const normalized = {};
  for (const [k, v] of Object.entries(headers)) {
    if (v === undefined || v === null) continue;
    normalized[k.toLowerCase()] = String(v).trim().replace(/\s+/g, " ");
  }
  const names = Object.keys(normalized).sort();
  const canonical = names.map((n) => `${n}:${normalized[n]}\n`).join("");
  return { canonical, signedHeaders: names.join(";") };
}

/**
 * 构造签名头。返回可直接发送的请求头以及调试字段（下划线前缀）。
 */
export function buildSignedHeaders({
  method,
  path,
  query = {},
  body = "",
  host,
  ak,
  sk,
  date = new Date(),
  contentType,
}) {
  const sdkDate = formatSdkDate(date);
  const headers = { host, "x-sdk-date": sdkDate };
  if (contentType) headers["content-type"] = contentType;

  const { canonical, signedHeaders } = canonicalHeaders(headers);
  const payloadHash = sha256Hex(body);
  const canonicalRequest = [
    String(method).toUpperCase(),
    uriEncode(path, false),
    canonicalQueryString(query),
    canonical,
    signedHeaders,
    payloadHash,
  ].join("\n");

  const stringToSign = `SDK-HMAC-SHA256\n${sdkDate}\n${sha256Hex(canonicalRequest)}`;
  const signature = hmacSha256Hex(sk, stringToSign);
  const authorization = `SDK-HMAC-SHA256 Access=${ak}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const sendable = { "X-Sdk-Date": sdkDate };
  if (contentType) sendable["Content-Type"] = contentType;
  sendable.Authorization = authorization;

  return {
    headers: sendable,
    sdkDate,
    signedHeaders,
    signature,
    canonicalRequest,
    stringToSign,
  };
}

/* -------------------------------------------------------------------------- */
/* HTTP 调用                                                                    */
/* -------------------------------------------------------------------------- */

function buildQueryString(query = {}) {
  return canonicalQueryString(query);
}

/**
 * CodeArts Req 网关（projectman-ext）在验签阶段会把请求 URI 补尾斜杠做规范化
 * （例：`/v4/projects` 验签时按 `/v4/projects/` 计算），而路由匹配仍使用原始路径。
 * 因此：签名用的 CanonicalURI 需要补 "/"，实际请求 URL 保持原样。
 */
export function toSigningPath(path) {
  const p = String(path || "/");
  return p.endsWith("/") ? p : `${p}/`;
}

export async function callApi({
  config,
  method,
  path,
  query = {},
  body,
  fetchImpl = globalThis.fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  date,
}) {
  if (typeof fetchImpl !== "function") {
    throw new ToolError(ERROR_CODE.NETWORK_ERROR, "当前 Node.js 运行时不支持 fetch，请升级到 Node 18+。");
  }

  const bodyStr = body === undefined || body === null ? "" : JSON.stringify(body);
  const contentType = bodyStr ? "application/json;charset=utf8" : undefined;

  const signed = buildSignedHeaders({
    method,
    path: toSigningPath(path),
    query,
    body: bodyStr,
    host: config.host,
    ak: config.ak,
    sk: config.sk,
    date,
    contentType,
  });

  const queryString = buildQueryString(query);
  const url = `${config.endpoint}${path}${queryString ? "?" + queryString : ""}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let response;
  try {
    response = await fetchImpl(url, {
      method: String(method).toUpperCase(),
      headers: signed.headers,
      body: bodyStr ? bodyStr : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    const reason = err && err.name === "AbortError" ? `请求超时（${timeoutMs}ms）` : err && err.message;
    throw new ToolError(
      ERROR_CODE.NETWORK_ERROR,
      `调用 CodeArts Req API 网络异常：${reason || "请求失败"}。请检查终端节点可达性与网络连接。`,
      { url, method, cause: reason || "unknown", sdk_request: signed },
    );
  } finally {
    clearTimeout(timer);
  }

  const rawText = await response.text();
  let data;
  try {
    data = rawText ? JSON.parse(rawText) : {};
  } catch {
    data = { _raw: rawText };
  }

  return { httpStatus: response.status, ok: response.ok, data, rawText, sdk_request: signed };
}

function toApiError(result) {
  const data = result && result.data ? result.data : {};
  const nested = data.error && typeof data.error === "object" ? data.error : {};
  const errorCode = data.error_code || nested.error_code || data.code || nested.code || "API_ERROR";
  const errorMsg =
    data.error_msg ||
    data.error_message ||
    nested.error_msg ||
    nested.message ||
    data.message ||
    (result && result.rawText ? String(result.rawText).slice(0, 500) : "") ||
    "CodeArts Req API 返回未知错误";

  return new ToolError(
    ERROR_CODE.API_ERROR,
    `CodeArts Req API 调用失败（HTTP ${result.httpStatus}）：[${errorCode}] ${errorMsg}`,
    {
      error_code: errorCode,
      error_msg: errorMsg,
      http_status: result.httpStatus,
      response: data,
    },
  );
}

/* -------------------------------------------------------------------------- */
/* 参数校验                                                                    */
/* -------------------------------------------------------------------------- */

function isBlank(v) {
  return v === undefined || v === null || (typeof v === "string" && v.trim() === "");
}

function toInteger(value, name) {
  let n = value;
  if (typeof n === "string" && n.trim() !== "") n = Number(n);
  if (typeof n !== "number" || !Number.isFinite(n) || !Number.isInteger(n)) {
    throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `参数 ${name} 必须是整数，实际收到：${JSON.stringify(value)}。`);
  }
  return n;
}

export function validateCreateProject(args = {}) {
  const body = {};

  if (typeof args.project_name !== "string" || args.project_name.trim() === "") {
    throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, "参数 project_name 为必填项，且必须是非空字符串（1-128 字符）。");
  }
  const projectName = args.project_name.trim();
  if (projectName.length > 128) {
    throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `参数 project_name 长度必须为 1-128 字符，实际为 ${projectName.length} 字符。`);
  }
  body.project_name = projectName;

  if (typeof args.project_type !== "string" || !PROJECT_TYPES.includes(args.project_type)) {
    throw new ToolError(
      ERROR_CODE.INVALID_ARGUMENTS,
      `参数 project_type 为必填项，取值必须是以下之一：${PROJECT_TYPES.join(" / ")}。实际收到：${JSON.stringify(args.project_type)}。`,
    );
  }
  body.project_type = args.project_type;

  if (args.description !== undefined && args.description !== null) {
    if (typeof args.description !== "string") {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, "参数 description 必须是字符串。");
    }
    body.description = args.description;
  }

  if (args.enterprise_id !== undefined && args.enterprise_id !== null && args.enterprise_id !== "") {
    if (typeof args.enterprise_id !== "string") {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, "参数 enterprise_id 必须是字符串。");
    }
    body.enterprise_id = args.enterprise_id;
  }

  if (args.source !== undefined && args.source !== null) {
    if (typeof args.source !== "string") {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, "参数 source 必须是字符串。");
    }
    if (args.source.length > 64) {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `参数 source 长度必须为 0-64 字符，实际为 ${args.source.length} 字符。`);
    }
    body.source = args.source;
  }

  const hasTemplate = !isBlank(args.template_id) && String(args.template_id) !== "";
  if (body.project_type === "ipd" && !hasTemplate) {
    throw new ToolError(
      ERROR_CODE.INVALID_ARGUMENTS,
      "参数 template_id 在 project_type=ipd 时为必传项，取值必须是 10001 / 10002 / 10003 之一。",
    );
  }
  if (hasTemplate) {
    const templateId = String(args.template_id);
    if (!TEMPLATE_IDS.includes(templateId)) {
      throw new ToolError(
        ERROR_CODE.INVALID_ARGUMENTS,
        `参数 template_id 取值必须是以下之一：${TEMPLATE_IDS.join(" / ")}。实际收到：${JSON.stringify(args.template_id)}。`,
      );
    }
    body.template_id = templateId;
  }

  return body;
}

const SORT_DIRECTIONS = ["asc", "desc"];
const SORT_GROUP_RE = /^([A-Za-z0-9_.]+):(asc|desc)$/i;

export function normalizeSort(value) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, "参数 sort 必须是形如 `字段:方向` 的字符串。");
  }
  const groups = value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s !== "");
  if (groups.length === 0 || groups.length > 4) {
    throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `参数 sort 最多支持 4 组排序，实际为 ${groups.length} 组。`);
  }
  return groups
    .map((group) => {
      const m = SORT_GROUP_RE.exec(group);
      if (!m) {
        throw new ToolError(
          ERROR_CODE.INVALID_ARGUMENTS,
          `参数 sort 格式非法：${group}。期望格式为 \`字段:方向\`，方向只能是 ${SORT_DIRECTIONS.join(" / ")}。`,
        );
      }
      return `${m[1]}:${m[2].toLowerCase()}`;
    })
    .join(",");
}

export function validateListProjects(args = {}) {
  const query = {};

  let offset = 0;
  if (args.offset !== undefined && args.offset !== null && args.offset !== "") {
    offset = toInteger(args.offset, "offset");
    if (offset < 0 || offset > 10000) {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `参数 offset 取值范围为 0-10000，实际为 ${offset}。`);
    }
  }

  let limit = 10;
  if (args.limit !== undefined && args.limit !== null && args.limit !== "") {
    limit = toInteger(args.limit, "limit");
    if (limit < 1 || limit > 1000) {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `参数 limit 取值范围为 1-1000，实际为 ${limit}。`);
    }
  }

  if (offset % limit !== 0) {
    throw new ToolError(
      ERROR_CODE.INVALID_ARGUMENTS,
      `参数 offset（${offset}）必须是 limit（${limit}）的整数倍。`,
    );
  }

  query.offset = offset;
  query.limit = limit;

  if (args.search !== undefined && args.search !== null && args.search !== "") {
    if (typeof args.search !== "string") {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, "参数 search 必须是字符串。");
    }
    query.search = args.search;
  }

  if (args.project_type !== undefined && args.project_type !== null && args.project_type !== "") {
    if (typeof args.project_type !== "string" || !LIST_PROJECT_TYPES.includes(args.project_type)) {
      throw new ToolError(
        ERROR_CODE.INVALID_ARGUMENTS,
        `参数 project_type 取值必须是以下之一：${LIST_PROJECT_TYPES.join(" / ")}。实际收到：${JSON.stringify(args.project_type)}。`,
      );
    }
    query.project_type = args.project_type;
  }

  if (args.sort !== undefined && args.sort !== null && args.sort !== "") {
    query.sort = normalizeSort(args.sort);
  }

  if (args.archive !== undefined && args.archive !== null) {
    if (typeof args.archive !== "boolean") {
      throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `参数 archive 必须是布尔值，实际收到：${JSON.stringify(args.archive)}。`);
    }
    query.archive = args.archive;
  }

  if (args.query_type !== undefined && args.query_type !== null && args.query_type !== "") {
    if (typeof args.query_type !== "string" || !QUERY_TYPES.includes(args.query_type)) {
      throw new ToolError(
        ERROR_CODE.INVALID_ARGUMENTS,
        `参数 query_type 取值必须是以下之一：${QUERY_TYPES.join(" / ")}。实际收到：${JSON.stringify(args.query_type)}。`,
      );
    }
    query.query_type = args.query_type;
  }

  return query;
}

/* -------------------------------------------------------------------------- */
/* 结果整形                                                                     */
/* -------------------------------------------------------------------------- */

function unwrap(data) {
  if (data && typeof data === "object" && data.result && typeof data.result === "object") {
    return data.result;
  }
  return data && typeof data === "object" ? data : {};
}

function pickCreateProject(data) {
  const src = unwrap(data);
  const out = {};
  for (const key of ["project_id", "project_num_id", "project_name", "project_type", "user_num_id"]) {
    if (src[key] !== undefined) out[key] = src[key];
  }
  return Object.keys(out).length > 0 ? out : src;
}

function pickListProjects(data) {
  const src = unwrap(data);
  const projects = Array.isArray(src.projects) ? src.projects : [];
  const total = typeof src.total === "number" ? src.total : projects.length;
  return { projects, total };
}

/* -------------------------------------------------------------------------- */
/* 工具执行 / 结果封装                                                          */
/* -------------------------------------------------------------------------- */

function okResult(payload) {
  return { content: [{ type: "text", text: JSON.stringify({ ok: true, ...payload }, null, 2) }] };
}

export function errorResult(err) {
  const code = (err && err.code) || "UNKNOWN_ERROR";
  const message = (err && err.message) || "未知错误";
  const details = (err && err.details) || {};
  const body = { ok: false, code, message, ...details };
  return { isError: true, content: [{ type: "text", text: JSON.stringify(body, null, 2) }] };
}

export async function executeTool(name, args, ctx = {}) {
  const env = ctx.env || process.env;
  const fetchImpl = ctx.fetchImpl || globalThis.fetch;
  const timeoutMs = ctx.timeoutMs || DEFAULT_TIMEOUT_MS;
  const date = ctx.date;

  try {
    const config = readConfig(env);

    if (name === TOOL_CREATE_PROJECT) {
      const body = validateCreateProject(args || {});
      const res = await callApi({
        config,
        method: "POST",
        path: PATH_CREATE_PROJECT,
        body,
        fetchImpl,
        timeoutMs,
        date,
      });
      if (!res.ok) throw toApiError(res);
      return okResult(pickCreateProject(res.data));
    }

    if (name === TOOL_LIST_PROJECTS) {
      const query = validateListProjects(args || {});
      const res = await callApi({
        config,
        method: "GET",
        path: PATH_LIST_PROJECTS,
        query,
        fetchImpl,
        timeoutMs,
        date,
      });
      if (!res.ok) throw toApiError(res);
      return okResult(pickListProjects(res.data));
    }

    throw new ToolError(ERROR_CODE.INVALID_ARGUMENTS, `未知工具：${name}`);
  } catch (err) {
    return errorResult(err);
  }
}

/* -------------------------------------------------------------------------- */
/* 工具 schema（JSON Schema，交由 handler 统一校验）                             */
/* -------------------------------------------------------------------------- */

const createProjectInputSchema = {
  type: "object",
  properties: {
    project_name: { type: "string", description: "项目名称，必填，1-128 字符。" },
    project_type: {
      type: "string",
      enum: [...PROJECT_TYPES],
      description: `项目类型，必填。可选值：${PROJECT_TYPES.join(" / ")}。`,
    },
    description: { type: "string", description: "项目描述，选填。" },
    enterprise_id: { type: "string", description: "企业 ID，选填。" },
    source: { type: "string", description: "项目来源，选填，0-64 字符。" },
    template_id: {
      type: "string",
      enum: [...TEMPLATE_IDS],
      description: `模板 ID，选填；project_type=ipd 时必传。可选值：${TEMPLATE_IDS.join(" / ")}。`,
    },
  },
  required: ["project_name", "project_type"],
  additionalProperties: false,
};

const listProjectsInputSchema = {
  type: "object",
  properties: {
    offset: { type: "integer", minimum: 0, maximum: 10000, description: "分页偏移量，选填，默认 0，范围 0-10000，且必须是 limit 的整数倍。" },
    limit: { type: "integer", minimum: 1, maximum: 1000, description: "每页条数，选填，默认 10，范围 1-1000。" },
    search: { type: "string", description: "按名称模糊搜索关键字，选填。" },
    project_type: {
      type: "string",
      enum: [...LIST_PROJECT_TYPES],
      description: `项目类型过滤，选填。可选值：${LIST_PROJECT_TYPES.join(" / ")}。`,
    },
    sort: { type: "string", description: "排序，选填，格式为 `字段:方向`（方向为 asc/desc），多组用逗号分隔，最多 4 组。" },
    archive: { type: "boolean", description: "是否查询已归档项目，选填。" },
    query_type: {
      type: "string",
      enum: [...QUERY_TYPES],
      description: `查询范围，选填。可选值：${QUERY_TYPES.join(" / ")}。`,
    },
  },
  additionalProperties: false,
};

export function buildToolDefinitions() {
  return [
    {
      name: TOOL_CREATE_PROJECT,
      config: {
        title: "创建 CodeArts 项目",
        description:
          "在华为云 CodeArts 需求管理中创建项目（POST /v4/project）。返回 project_id、project_num_id、project_name、project_type、user_num_id。",
        inputSchema: createProjectInputSchema,
      },
      handler: (args) => executeTool(TOOL_CREATE_PROJECT, args),
    },
    {
      name: TOOL_LIST_PROJECTS,
      config: {
        title: "查询 CodeArts 项目列表",
        description:
          "查询华为云 CodeArts 需求管理中的项目列表（GET /v4/projects）。返回 projects 数组与 total。",
        inputSchema: listProjectsInputSchema,
      },
      handler: (args) => executeTool(TOOL_LIST_PROJECTS, args),
    },
  ];
}

/**
 * 构造 zod raw shape（MCP SDK 要求 inputSchema 为 Zod）。
 * 类型保持宽松，避免 SDK 在 handler 之前拦截；所有业务校验统一在 handler 完成，
 * 从而保证非法参数始终返回中文 INVALID_ARGUMENTS。约束信息通过 describe 传递给模型。
 */
export function buildZodInputSchema(z, toolName) {
  if (toolName === TOOL_CREATE_PROJECT) {
    return {
      project_name: z.string().optional().describe("项目名称，必填，1-128 字符。"),
      project_type: z
        .string()
        .optional()
        .describe(`项目类型，必填。可选值：${PROJECT_TYPES.join(" / ")}。`),
      description: z.string().optional().describe("项目描述，选填。"),
      enterprise_id: z.string().optional().describe("企业 ID，选填。"),
      source: z.string().optional().describe("项目来源，选填，0-64 字符。"),
      template_id: z
        .union([z.string(), z.number()])
        .optional()
        .describe(`模板 ID，选填；project_type=ipd 时必传。可选值：${TEMPLATE_IDS.join(" / ")}。`),
    };
  }

  if (toolName === TOOL_LIST_PROJECTS) {
    return {
      offset: z
        .union([z.number(), z.string()])
        .optional()
        .describe("分页偏移量，选填，默认 0，范围 0-10000，且必须是 limit 的整数倍。"),
      limit: z
        .union([z.number(), z.string()])
        .optional()
        .describe("每页条数，选填，默认 10，范围 1-1000。"),
      search: z.string().optional().describe("按名称模糊搜索关键字，选填。"),
      project_type: z
        .string()
        .optional()
        .describe(`项目类型过滤，选填。可选值：${LIST_PROJECT_TYPES.join(" / ")}。`),
      sort: z
        .string()
        .optional()
        .describe("排序，选填，格式为 `字段:方向`（方向为 asc/desc），多组用逗号分隔，最多 4 组。"),
      archive: z.union([z.boolean(), z.string()]).optional().describe("是否查询已归档项目，选填。"),
      query_type: z
        .string()
        .optional()
        .describe(`查询范围，选填。可选值：${QUERY_TYPES.join(" / ")}。`),
    };
  }

  return {};
}

/* -------------------------------------------------------------------------- */
/* 启动 stdio MCP Server                                                        */
/* -------------------------------------------------------------------------- */

export async function startServer() {
  const { McpServer } = await import("@modelcontextprotocol/sdk/server/mcp.js");
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { z } = await import("zod");

  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION });

  for (const def of buildToolDefinitions()) {
    const config = {
      title: def.config.title,
      description: def.config.description,
      inputSchema: buildZodInputSchema(z, def.name),
    };
    server.registerTool(def.name, config, async (args) => def.handler(args || {}));
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdio 传输下只能写 stderr，避免污染 MCP 协议
  console.error(`[${SERVER_NAME}] MCP server started (stdio), version ${SERVER_VERSION}`);
  return server;
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  startServer().catch((err) => {
    console.error(`[${SERVER_NAME}] 启动失败：${err && err.stack ? err.stack : err}`);
    process.exit(1);
  });
}