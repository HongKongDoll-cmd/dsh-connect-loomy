<p align="center">
  <img src="icons/dsh-connect-loomy-128.png" width="96" alt="dsh-connect-loomy icon">
</p>

# dsh-connect-loomy

[English](README.en.md) | 中文

[![CI](https://img.shields.io/github/actions/workflow/status/HongKongDoll-cmd/dsh-connect-loomy/ci.yml?branch=main)](https://github.com/HongKongDoll-cmd/dsh-connect-loomy/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)

将讯飞 **Loomy**（`loomy.xunfei.cn`）模型与多账号池接入 **DeepSeek Harness (DSH)**：无需安装 Loomy 客户端即可微信扫码/短信登录、自动同步官方模型目录与积分倍率、多账号同模型故障自动换号，并在界面展示实时余额、兑换码兑换与模型测速。

## 功能特性

- **不装客户端也能登录**：内置 **微信扫码登录**（支持未绑手机时短信绑定）与 **手机验证码登录**，也支持自动读取本机 Loomy 桌面端登录态（`auth-session.json` / LevelDB）或手动填入 Token。
- **多账号池与同模型自动换号**：支持同时管理多个 Loomy 账号，实时展示可用总积分、每日赠送余额、永久余额与健康/冷却状态；遇到会话失效（`100002`）、积分不足、限流（429）或模型暂不可用时，在回环网关内透明切换至账号池其他可用账号的同模型。
- **分区控制台与侧边栏整页入口**：提供 **账号 / 模型 / 能力 / 诊断 / SDK** 五个分区；支持模型可用性及延迟探测（Probe）、积分兑换码兑换、兼容模式（强制关闭思考输出），以及可选「在侧边栏显示 Loomy」整页视图。
- **安全与隐私**：Session Token 与手机号仅存于本机 `$DSH_HOME/loomy-vault/accounts.json`（`0600`），前端与日志仅显示脱敏信息，详见 [docs/PRIVACY.md](docs/PRIVACY.md)。

## 安装方式

- **通过 DSH 插件市场 / Release 预构建包安装（推荐，免构建脚本）**：
  在插件市场收录后直接搜索 `dsh-connect-loomy` 一键安装；或安装 GitHub Release 发布的 `.tgz` 预构建包：
  ```sh
  dsh plugin add https://github.com/HongKongDoll-cmd/dsh-connect-loomy/releases/latest/download/dsh-connect-loomy-0.2.0.tgz
  ```
- **本地插件目录添加（开发联调推荐）**：
  在 DSH 打开 **插件 → 添加本地插件** 选择本仓库目录，修改源码时执行 `npm run dev` 自动构建 `lib/`。

## 收录至插件市场

项目已自带 [awesome-dsh-plugin-submission/](awesome-dsh-plugin-submission/README.md) 提交清单与说明，推送至 GitHub 并发布首个 Release 后即可向 `awesome-dsh-plugin` 提 PR 收录。

## 本地校验

```sh
npm run check
npm pack --dry-run
```
