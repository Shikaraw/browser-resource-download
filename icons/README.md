# 图标资产（icons/）

`edge-resource-download` 的插件图标与品牌资产。全部由 **`build_icons.py`** 生成，
四个 PNG 与两个 SVG 共用**同一张 128×128 用户单位几何参数表**，风格/配色/构图严格一致。

```powershell
python icons/build_icons.py     # 重新生成 PNG / SVG / preview.png（可重复运行，输出确定）
```

依赖仅 **Pillow**（+ numpy），不需要 rsvg / ImageMagick / 外部字体。

---

## 文件

| 文件 | 说明 |
|---|---|
| `icon16.png` `icon32.png` `icon48.png` `icon128.png` | PNG-32（8bit RGBA，真实透明通道），manifest.json 已引用 |
| `logo.svg` | 矢量源文件（935 B ≪ 4 KB），完整细节，与 128px 版本一致，无外部引用 |
| `icon-mono.svg` | 单色 `currentColor` 版本（382 B），供 popup 品牌区 15px 使用（省略三角细节） |
| `preview.png` | 自检拼贴：4 种背景（深/浅/Edge 工具栏灰/深 elev）× 4 尺寸 + 逐像素放大 |
| `build_icons.py` | 生成脚本（几何表 + 光学尺寸 + 超采样光栅化） |
| `_verify.py` | 验收脚本：PNG 结构/尺寸/alpha、SVG 合法性/体积/无外链、重建确定性 |

## 设计

* **容器**：圆角方形，品牌渐变 `--brand-1 #6366f1`（indigo）→ `--brand-2 #22d3ee`（cyan），
  135° 对角（与 `theme.css` 的 `--brand-grad` 一致）。
* **主题「下载箭头 + 媒体资源」**：
  * 白色下载箭头 = 主体（竖杆 + 平顶宽三角），语义直接、16px 也认得出；
  * 箭头下方的白色圆角横条 = 已保存/落盘的文件；
  * 右上角低透明度播放三角 = 媒体资源（视频/音频）线索，仅中/大尺寸出现。
* **浅色工具栏可读**：容器边缘有一层深色收边（`rim_dark`，18–32% 黑）+
  一层白色内高光（`rim_light`），保证在 Edge 浅色工具栏上轮廓不糊掉。
* 所有颜色直接取自 `lib/theme.css` 设计令牌，未引入新色值。

## 光学尺寸（optical sizing）

四个尺寸**不是简单缩放**，小尺寸做了刻意的简化；风格、配色、构图保持一致：

| 尺寸 | 容器 inset / 圆角 | 播放三角 | 简化策略 |
|---|---|---|---|
| **16px** | 4u / 26u（3.25px，约 20% 边长） | **去掉** | 只保留「粗箭头 + 横条」。去掉播放三角（该尺寸下会退化成脏点）；箭头加粗、三角收窄到容器宽度的 ~78%，箭头与横条之间留更大空隙；圆角保持 3.25px 以便四角有可见透明（不透明占比 91%，与 32px 的 94% 接近，不会变成满方块） |
| **32px** | 3.6u / 26u（3.25px） | 保留，缩小 + 降对比（alpha 0.10） | 播放三角极小且低对比，主体占比更大 |
| **48px** | 4.5u / 28u（3.50px） | 保留（alpha 0.12） | 完整构图，三角对比略降 |
| **128px** | 5u / 29u（3.62px） | 保留（alpha 0.15） | 完整细节：更精致的渐变、内高光、最完整的三角 |

> `icon-mono.svg` 采用 16px 档的光学几何（无三角、粗箭头），因为它在 popup 中以 **15px** 渲染。

## 渲染实现要点

1. **8× 超采样**：128px 图标按 1024px 绘制后降采样，边缘抗锯齿质量高；
   16/32/48 同样先放大 8 倍再降采样。
2. **颜色与覆盖率分开重采样**：渐变 RGB 用 LANCZOS（保持平滑），
   alpha 覆盖率用 **BOX**（面积平均）。LANCZOS 会在硬边遮罩上过冲（ringing），
   凭空抬高边缘 alpha，BOX 才是覆盖率遮罩的正确滤波。
3. **圆角三角用二次贝塞尔**（控制点=顶点）实现，栅格化用的采样点与 SVG 的
   `M/L/Q` 路径由同一函数 `_corners()` 派生，确保矢量与位图几何一致。
4. 脚本可重复运行且**输出确定**（同参数重跑哈希不变）。

## 校验

`build_icons.py` 每次运行都会断言并打印：

```
icon16.png   16x16 RGBA    opaque= 91.4%   bbox=(0, 0, 16, 16)
icon32.png   32x32 RGBA    opaque= 85.2%   bbox=(0, 0, 32, 32)
icon48.png   48x48 RGBA    opaque= 81.0%   bbox=(1, 1, 47, 47)
icon128.png  128x128 RGBA  opaque= 80.7%   bbox=(5, 5, 124, 124)
logo.svg     935 bytes
icon-mono.svg 382 bytes
```

完整验收（含重建确定性）：`python icons/_verify.py` → `ALL CHECKS PASSED`。

* 四个 PNG 均为 8-bit **colour type 6（RGBA）**，alpha 含 0 与 255 两端（非全不透明）；
* `logo.svg` / `icon-mono.svg` 为合法 XML，根节点 `viewBox="0 0 128 128"`，
  **无任何外部引用**（唯一 `http://` 是 SVG 命名空间声明）；
* 浅色背景（`#f5f7fc`）下边缘最大亮度差 ≥ 110，工具栏灰下同样有清晰轮廓。

检查 `preview.png` 可一眼确认：深色/浅色/工具栏灰背景、4 个尺寸、以及 16px@5× 与
32px@2× 的逐像素放大效果。
