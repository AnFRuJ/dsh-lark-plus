// 生成指向仓库的二维码（需要仓库里已安装的 qrcode 依赖）。
//   node promo/make-qr.cjs
const path = require("node:path");
const ROOT = path.resolve(__dirname, "..");
const QR = require(path.join(ROOT, "node_modules", "qrcode"));

QR.toFile(path.join(__dirname, "qr-github.png"), "https://github.com/AnFRuJ/dsh-lark-plus", {
  errorCorrectionLevel: "M",
  margin: 1,
  width: 520,
  color: { dark: "#0b1220ff", light: "#ffffffff" },
})
  .then(() => console.log("promo/qr-github.png 已生成"))
  .catch((err) => {
    console.error("二维码生成失败:", err);
    process.exit(1);
  });
