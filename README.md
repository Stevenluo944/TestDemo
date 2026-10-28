# codearts-req — 华为云 CodeArts 需求管理 MCP Server

基于 Node.js 标准 MCP SDK（`@modelcontextprotocol/sdk`）实现的本地 **stdio** 类型 MCP Server，
封装华为云 CodeArts 需求管理（Req）API（参考《需求管理 CodeArts Req API 参考》）。
鉴权采用 AK/SK 签名（**SDK-HMAC-SHA256**，请求头 `Authorization` + `X-Sdk-Date`）。

服务名：`codearts-req`

## 目录结构

```
codearts-req-mcp-server/
├── server.mjs            # 完整可运行的 MCP Server（入口 + 可测试模块）
├── package.json
├── README.md
└── test/
    └── server.test.mjs   # 单元测试（node:test，离线可跑）
```

## 环境要求

- Node.js **18.17+**（依赖内置 `fetch` / `AbortController`，推荐 Node 20/22/24）
- Windows / macOS / Linux 均可

## 安装依赖

```bash
cd codearts-req-mcp-server
npm install
```

如网络受限，可指定镜像：

```bash
npm install --registry=https://repo.huaweicloud.com/repository/npm/
```

## 环境变量

| 变量 | 必填 | 说明 |
| --- | --- | --- |
| `CODEARTS_REQ_ENDPOINT` | 是 | 终端节点，例如 `https://codearts.cn-north-4.myhuaweicloud.com`（`cn-north-4` 替换为实际区域） |
| `CODEARTS_REQ_AK` | 是 | 华为云 Access Key |
| `CODEARTS_REQ_SK` | 是 | 华为云 Secret Key |

缺少任一变量时，工具调用不会崩溃，而是返回 `MISSING_CONFIG` 结构化的中文错误。

设置示例：

```bash
# Git Bash / macOS / Linux
export CODEARTS_REQ_ENDPOINT="https://codearts.cn-north-4.myhuaweicloud.com"
export CODEARTS_REQ_AK="<your-ak>"
export CODEARTS_REQ_SK="<your-sk>"
```

```cmd
:: Windows CMD
set CODEARTS_REQ_ENDPOINT=https://codearts.cn-north-4.myhuaweicloud.com
set CODEARTS_REQ_AK=<your-ak>
set CODEARTS_REQ_SK=<your-sk>
```

```powershell
# Windows PowerShell
$env:CODEARTS_REQ_ENDPOINT = "https://codearts.cn-north-4.myhuaweicloud.com"
$env:CODEARTS_REQ_AK = "<your-ak>"
$env:CODEARTS_REQ_SK = "<your-sk>"
```

## 启动命令

该 Server 通过 **stdio** 与客户端通信，通常由 MCP 客户端自动拉起，无需手动常驻。
如需手动验证握手：

```bash
node server.mjs
# 或
npm start
```

启动成功时 stderr 输出：`[codearts-req] MCP server started (stdio), version 1.0.0`
（stdio 传输下所有日志仅写 stderr，避免污染 MCP 协议。）

## 码道（CodeArts）配置

在项目级 MCP 配置文件 `.codeartsdoer/mcp/mcp_settings.json` 的 `mcpServers` 节点下新增 stdio 服务：

```json
{
  "mcpServers": {
    "codearts-req": {
      "type": "stdio",
      "command": "node",
      "args": ["D:/codearts-ai-basics-res/codearts-req-mcp-server/server.mjs"],
      "env": {
        "CODEARTS_REQ_ENDPOINT": "https://codearts.cn-north-4.myhuaweicloud.com",
        "CODEARTS_REQ_AK": "<your-ak>",
        "CODEARTS_REQ_SK": "<your-sk>"
      }
    }
  }
}
```

说明：

- `command` 建议填 `node` 可执行文件的绝对路径（如 `C:/Program Files/nodejs/node.exe`），避免 PATH 缺失。
- `args[0]` 必须是 `server.mjs` 的绝对路径。Windows 路径在 JSON 中用正斜杠 `/` 或双反斜杠 `\\`。
- 若客户端要求“用户级”配置，也可写入用户目录下的 MCP 配置，节点结构与上例一致。
- 新增后重启 CodeArts，即可在 MCP 工具列表看到 `create_project`、`list_projects`。

> 安全提示：AK/SK 会以明文保存在配置文件中，请勿提交到代码仓库；建议在 IAM 控制台定期轮换。

## 提供的工具

### 1. `create_project`

创建项目，对应 `POST /v4/project`。

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `project_name` | string | 是 | 1-128 字符 |
| `project_type` | enum | 是 | `scrum` / `normal` / `xboard` / `basic` / `phoenix` / `ipd` |
| `description` | string | 否 | 项目描述 |
| `enterprise_id` | string | 否 | 企业 ID |
| `source` | string | 否 | 0-64 字符 |
| `template_id` | enum | 否 | `10001` / `10002` / `10003`；`project_type=ipd` 时**必传** |

返回：`project_id`、`project_num_id`、`project_name`、`project_type`、`user_num_id`

### 2. `list_projects`

查询项目列表，对应 `GET /v4/projects`。

| 参数 | 类型 | 必填 | 约束 |
| --- | --- | --- | --- |
| `offset` | integer | 否 | 默认 `0`，范围 `0-10000`，须为 `limit` 的整数倍 |
| `limit` | integer | 否 | 默认 `10`，范围 `1-1000` |
| `search` | string | 否 | 名称模糊搜索关键字 |
| `project_type` | enum | 否 | `scrum` / `normal` / `xboard` |
| `sort` | string | 否 | 格式 `字段:方向`（方向 `asc`/`desc`），多组用逗号分隔，最多 4 组 |
| `archive` | boolean | 否 | 是否查询已归档项目 |
| `query_type` | enum | 否 | `domain_projects` / `absent` |

返回：`projects`（数组）与 `total`（项目总数）

## 错误处理

所有工具错误均返回 `isError: true` 的结构化中文提示，不会静默吞错，也不会导致进程崩溃。

| 错误码 | 触发场景 |
| --- | --- |
| `INVALID_ARGUMENTS` | 参数缺失、类型错误、取值非法、超出范围 |
| `MISSING_CONFIG` | 缺少或非法的环境变量配置 |
| `API_ERROR` | API 返回非 2xx，透传 `error_code` / `error_msg` / `http_status` |
| `NETWORK_ERROR` | 网络异常、DNS 失败、请求超时（默认 30s） |

错误返回示例（文本内容为 JSON）：

```json
{
  "ok": false,
  "code": "API_ERROR",
  "message": "CodeArts Req API 调用失败（HTTP 400）：[REQ.0101] 项目名称已存在",
  "error_code": "REQ.0101",
  "error_msg": "项目名称已存在",
  "http_status": 400
}
```

成功返回示例：

```json
{
  "ok": true,
  "project_id": "xxx",
  "project_num_id": 1001,
  "project_name": "示例项目",
  "project_type": "scrum",
  "user_num_id": 88
}
```

## 测试

```bash
npm test
```

测试基于 Node 内置 `node:test`，不依赖网络与华为云环境，覆盖：

- AK/SK 签名（与独立实现交叉验证规范请求串、待签串、签名值）
- 参数校验（必填、枚举、范围、`offset`/`limit` 整数倍、`sort` 格式与组数）
- 配置缺失、参数非法、API 报错透传、网络异常等错误分支
- `create_project` / `list_projects` 的成功路径（注入 mock `fetch`）

## 实现要点

- **签名算法**：`SDK-HMAC-SHA256`。规范请求串 = `Method + \n + CanonicalURI + \n + CanonicalQueryString + \n + CanonicalHeaders + \n + SignedHeaders + \n + HexEncode(SHA256(Payload))`；待签串 = `SDK-HMAC-SHA256\n + X-Sdk-Date + \n + HexEncode(SHA256(CanonicalRequest))`；签名 = `HMAC-SHA256(StringToSign, SK)` 的 hex。
- **请求头**：`X-Sdk-Date`（UTC，`YYYYMMDDTHHMMSSZ`）与 `Authorization: SDK-HMAC-SHA256 Access=<AK>, SignedHeaders=<...>, Signature=<...>`；POST 时 `Content-Type` 一并纳入签名。
- **参数校验**：MCP SDK 的 `inputSchema` 仅声明结构，业务校验统一在 handler 中完成，确保所有非法参数都以 `INVALID_ARGUMENTS` 返回。