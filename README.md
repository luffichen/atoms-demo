# Atoms Demo

一个由 DeepSeek 与 Pi agent 驱动的真实代码生成工作台。需求基线见
[`docs/README.md`](./docs/README.md)。

## 本地运行

要求 Node.js 22.19+。DeepSeek API Key 放在仓库根目录 `deepseek.key`，或沿用
`docs/deepseek.key`。

```bash
npm install
npm run dev
```

生产构建与验证：

```bash
npm test
npm run test:coverage
npm run typecheck
npm run build
NODE_ENV=production npm start
```

默认开发数据位于 `./workspace`。生产部署必须把 `ATOMS_WORKSPACE_ROOT` 和
`ATOMS_DATABASE_PATH` 指向持久磁盘。

## GCE 部署

部署脚本创建单台 GCE、100GB 持久磁盘、HTTP/HTTPS 防火墙规则，安装 Node.js 22、
bubblewrap、Caddy 和 systemd 服务。实例使用保留公网 IP，默认使用该 IP 对应的 `sslip.io`
域名签发 HTTPS 证书。

```bash
GCLOUD_PROJECT=your-project \
GCLOUD_ZONE=asia-east1-b \
bash scripts/deploy-gce.sh
```

可通过 `ATOMS_DOMAIN` 使用自有域名。脚本不会把 DeepSeek Key 打进发布包；密钥以
`0600` 权限单独传到实例。部署结束前会真实调用 DeepSeek，验证 bubblewrap 终端、
文件写入、预览和 60 次页面 API 性能采样。
