# QuarkDownloader Frontend

基于 React 19 + TypeScript + TailwindCSS 构建的现代化夸克网盘链接解析工具。

## 配置

复制示例环境文件（仓库中已提供 `frontend/.env.example`，复制出的 `.env.local` 不会被提交）：

```bash
cp .env.example .env.local
```

主要变量（默认值取自 `frontend/.env.example`、`vite.config.ts:5-16` 与 `src/services/http.ts:4-6`）：

- `VITE_API_BASE_URL`: Axios 请求前缀。**不设置或留空**时使用内嵌 axum 服务的绝对地址 `http://127.0.0.1:3000/api`——`src/services/http.ts:5` 写的是 `import.meta.env.VITE_API_BASE_URL || 'http://127.0.0.1:3000/api'`，空字符串同样为假值，所以「留空」走的是绝对地址而不是相对路径；只有显式设为 `/api` 时才会走 Vite 开发服务器的 `/api` 代理（转发到 `VITE_DEV_API_TARGET`，仅开发模式有效）。
- `VITE_DEV_API_TARGET`: Vite 代理后端地址，默认 `http://localhost:3000`
- `VITE_DEV_HOST`: 开发服务器 host，默认 `127.0.0.1`
- `VITE_DEV_PORT`: 开发服务器 port，默认 `1420`

示例（开发时想走代理）：

```env
VITE_API_BASE_URL=/api
VITE_DEV_API_TARGET=http://localhost:3000
VITE_DEV_HOST=127.0.0.1
VITE_DEV_PORT=1420
```
