# 市场收录提交指南（Awesome DSH Plugin）

本目录用于准备向 [awesome-dsh-plugin](https://github.com/awesome-dsh-plugin/awesome-dsh-plugin) 提交插件目录 PR，收录后 `dshmarket` 与 DSH「发现」页会自动同步展示本插件。

## 提交前检查清单

1. 确认 GitHub 仓库 `https://github.com/HongKongDoll-cmd/dsh-connect-loomy` 为 **Public**，并已包含以下文件：
   - `package.json`（`author`、`repository.url`、`homepage`、`bugs.url`）
   - `README.md` 与 `README.en.md`
   - 本目录下的 [HongKongDoll-cmd__dsh-connect-loomy.yml](HongKongDoll-cmd__dsh-connect-loomy.yml)
2. 推送代码与版本标签触发 GitHub Release 预构建包：
   ```sh
   git init
   git add .
   npm run check
   git commit -m "chore: initial release v0.2.0"
   git branch -M main
   git remote add origin https://github.com/HongKongDoll-cmd/dsh-connect-loomy.git
   git push -u origin main
   git tag v0.2.0
   git push origin v0.2.0
   ```
   `.github/workflows/release.yml` 会自动执行校验并把 `dsh-connect-loomy-0.2.0.tgz` 上传到 GitHub Release，用户通过 `dshmarket` 安装时无需执行本地构建脚本。
3. Fork `awesome-dsh-plugin/awesome-dsh-plugin`，将 `HongKongDoll-cmd__dsh-connect-loomy.yml` 放入其 `data/plugins/` 目录并提交 PR：
   - 确认 `icon` 指向 `https://raw.githubusercontent.com/HongKongDoll-cmd/dsh-connect-loomy/main/icons/dsh-connect-loomy-128.png`（必须为 GitHub 托管的 PNG/JPG/WebP 位图，不可使用 SVG）。
   - 确认 `description.en` 为单行英文并以英文句号结尾。
