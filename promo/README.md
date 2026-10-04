# promo/ —— 推广素材（不随 npm 包发布）

这些图片用于**分享和宣传**，和插件本身无关，所以放在 `promo/` 而不是 `assets/`
（`package.json` 的 `files` 只打包 `assets/`，这样 npm 包里不会多出几百 KB 营销图）。

| 文件 | 用途 |
|---|---|
| `social-preview.png` (1280×640) | GitHub → Settings → General → Social preview 上传这张，贴链接时会出现带图卡片 |
| `moments-1080.png` (1080×1080) | 微信朋友圈/微博等方形配图，右下角带仓库二维码 |
| `bilibili-cover.png` (1146×717) | B 站/YouTube 视频封面 |
| `qr-github.png` | 指向仓库的二维码（已嵌进上面几张图里） |

重新生成（改了文案/配色后）：

```bash
node promo/make-qr.cjs          # 1) 先生成二维码（用到仓库自带的 qrcode 依赖）
python promo/generate.py        # 2) 再渲染两张图（需要 Pillow + 微软雅黑字体）
```

字体用的是 Windows 自带 `msyhbd.ttc`（微软雅黑 Bold）与 `consola.ttf`；
在 macOS/Linux 上换成本机存在的中文字体路径即可。
