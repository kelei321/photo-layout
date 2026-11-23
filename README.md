# 照片排版

把一批照片裁成正方形、排成网格，再导出为可分享的整版图片或可打印的 PDF。照片和项目均在本机处理，适合制作百日照拼图、家庭相册和照片墙。

支持 Windows x64。便携版为单个 `PhotoLayout.exe`，双击即可打开。运行需要 Microsoft Edge WebView2 Runtime。手头没有 EXE 时，可以按下文从源码构建。 [微软 WebView2 Runtime 下载页](https://developer.microsoft.com/microsoft-edge/webview2/#download)

## 功能

| 功能 | 用法 |
| --- | --- |
| 批量导入 | 选择或拖入 JPG、JPEG、PNG、WebP 和照片 ZIP |
| 裁切与编排 | 拖动、缩放正方形裁切，打开「裁切对照」查看原图裁切框和头顶参考线。可以拖拽排序、按序号移动、替换、单张或批量移除 |
| 排版与工作区 | 支持固定行列数和自动行数，可调整列数、间距和圆角。中间画布支持整版和缩放查看，两侧面板可拖动调宽、折叠和展开 |
| 导出预览 | 确认预览后导出 JPG、PNG、300 DPI 单页 PDF 或编号小图 ZIP |
| 保存与恢复 | `.photolayout` 包含原图、顺序、裁切和版式，文件移到其他目录后仍可继续编辑。当前编辑会话保留最多 30 步撤销记录 |

## 快速上手

以制作一张 **10×10 的百图拼图**为例：

1. 点击「导入照片」，或把照片和 ZIP 拖进窗口。
2. 选择「10 × 10」。少于 100 张时会显示空位，多出的照片会高亮。点「批量选择」后可逐张勾选、按住 Shift 连选或全选，再移除选中的照片。原照片文件会保留。
3. 选中照片，在右侧调整裁切。可拖动照片排序，也可用照片右键菜单选中编辑、指定序号、替换或移除。
4. 选择导出格式，点击「预览并导出」，确认后选择保存位置。
5. 点击「保存项目」保留可编辑的 `.photolayout` 文件。

**想保留任意张数？** 切换到「自动行数」。固定预设有 10 列 × 10 行、5 列 × 20 行、20 列 × 5 行，均要求正好 100 张才能导出整版。编号小图 ZIP 可以独立导出当前照片。

## 导出格式与限制

| 格式 | 内容 | 尺寸设置 |
| --- | --- | --- |
| JPG / PNG | 一张整版图片 | 小图边长和间距均以像素设置 |
| PDF | 300 DPI 单页整版，可用于打印 | 以毫米设置小图边长和间距，页面尺寸由排版计算 |
| ZIP | 按当前顺序排列的裁切小图，如 `001.jpg`、`002.jpg` | 可单独设置每个小图的像素边长 |

打印 PDF 时选择「实际大小」或「100%」，以保留设置的实物尺寸。照片圆角可设为 0%–50%，成品的圆角区域为白色。头顶参考线仅在编辑时显示。

每个项目最多 500 张照片。单张原图上限为 64 MiB、8000 万像素，宽高各不超过 32,768 像素。导出图像宽高各不超过 16,384 像素，总计不超过 6400 万像素。遇到尺寸提示时，可减小小图边长或间距，再查看成品尺寸。

## 快捷键

| 快捷键 | 操作 |
| --- | --- |
| `Ctrl+I` / `Ctrl+O` / `Ctrl+S` | 导入照片 / 打开项目 / 保存项目 |
| `Ctrl+Z` / `Ctrl+Y` 或 `Ctrl+Shift+Z` | 撤销 / 重做 |
| `Ctrl+P` | 打开 PDF 导出预览 |
| `Shift+F10` | 打开当前焦点照片的右键菜单 |
| 方向键 | 聚焦裁切预览时微调照片，聚焦左右分隔条时调整面板宽度 |

## 从源码运行和构建

技术栈为 **Tauri 2、Rust、React、TypeScript 和 Vite**。在 Windows x64 上准备 PowerShell 7、fnm 管理的 Node.js **24.16.0**、**pnpm 11.25.0**、Rust 的 `x86_64-pc-windows-msvc` 工具链、Visual Studio C++ 构建工具，以及 WebView2 Runtime。

1. 克隆仓库并安装锁文件中的依赖。

   ```powershell
   git clone https://github.com/kelei321/photo-layout.git
   Set-Location photo-layout
   fnm use 24.16.0
   pnpm install --frozen-lockfile
   ```

2. 启动桌面开发窗口。

   ```powershell
   pnpm tauri dev
   ```

3. 运行前端类型检查和测试，以及 Rust 测试。

   ```powershell
   pnpm run check
   pnpm run test
   cargo test --locked --manifest-path src-tauri/Cargo.toml
   ```

4. 构建可独立复制的便携 EXE。

   ```powershell
   pnpm tauri build --no-bundle
   ```

   构建产物位于 `src-tauri/target/release/PhotoLayout.exe`。将该文件复制到装有 WebView2 Runtime 的 Windows x64 电脑即可运行。
