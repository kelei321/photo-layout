# 照片排版

Windows x64 离线桌面工具。双击 [PhotoLayout.exe](release/PhotoLayout.exe) 即可打开。运行需要 Microsoft Edge WebView2 Runtime，Windows 11 通常已自带，缺少时可从微软下载。 [WebView2 Runtime](https://developer.microsoft.com/microsoft-edge/webview2/#download)

## 使用

1. 选择或拖入 JPG、PNG、WebP 和照片 ZIP。每个项目最多 500 张，单张原图最多 64 MB、8000 万像素。
2. 点击照片，在右侧拖动预览来调整正方形裁切。可用滑块缩放，也可聚焦预览后按方向键微调。
3. 中间预览默认显示整版，可缩放查看。拖动照片或输入目标序号可调整顺序。选中照片可替换或移除。需要移除多张时，点「批量选择」，逐张勾选、按住 Shift 选连续范围或点「全选」，再点「移除选中照片」。移除不会删除原文件。
4. 可在排版设置中调整照片圆角（0% 至 50%），成品的圆角区域为白色。选择格式并点「预览并导出」，检查整版或 ZIP 编号小图，再确认保存。Ctrl+P 打开 300 DPI 单页 PDF 预览。打印时选择「实际大小」或 100%，以保留实物尺寸。
5. 保存为 `.photolayout` 后，可移动项目文件并继续编辑。项目文件包含原图，体积会随原图总大小增加。

排版预设固定行列数。张数不足会显示空位，多出的照片会高亮，整版导出需要凑齐张数。点「自动行数」可恢复随照片数增加行数。ZIP 可独立导出当前照片。

编辑时可按 Ctrl+Z 撤销，按 Ctrl+Y 或 Ctrl+Shift+Z 重做。点击「裁切对照」可看到原图裁切框和头顶参考线。参考线只显示在编辑区。

## 本地构建

在 Windows 中使用 fnm Node.js 24.16.0、pnpm 11.25.0、Rust MSVC 工具链和 Visual Studio C++ 构建工具。

```powershell
fnm use 24.16.0
pnpm install --frozen-lockfile
pnpm run test
cargo test --locked --manifest-path src-tauri/Cargo.toml
pnpm tauri build --no-bundle
```

发布版可从 `src-tauri/target/release/PhotoLayout.exe` 单独复制运行。
