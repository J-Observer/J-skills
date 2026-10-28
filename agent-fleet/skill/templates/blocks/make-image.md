输出目录绝对路径：`{OUTDIR}`（先 mkdir -p）。
逐张编号：`01-image.png` 起，逐张写清具体描述、精确文件名、像素尺寸/比例；正文指定的名称与尺寸优先，否则 1024×1024、1:1。
Grok 内置 image_gen / image_edit 工具走当前 OAuth 账号，没有 model 参数；做法：仅传工具支持的输入，沿用工具自身模型。
共享风格块：按正文统一画风、背景、hex 调色板、光线和镜头；同套图保持一致。
Create artwork with image content only; keep the canvas free of text, letters, logos and watermarks.
Deliver actual generated images. If generation is unavailable, report the limitation and completed work plainly; leave the blocked deliverables listed in the report (placeholders, ASCII art, solid rectangles and web downloads are outside the deliverable definition).
Report per file: absolute path, actual pixels, bytes, alpha status, method used（工具/模型、本地后处理情况）。
透明图使用 true alpha，透明区域保留实际透明通道。
If the exact size is unsupported, generate the nearest aspect and resize locally (sips / PIL) to the exact pixels; keep alpha for transparent items.
